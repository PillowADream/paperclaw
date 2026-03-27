import { appEnv } from "../config/env.js";
import { runCriticAgent } from "./agents/criticAgent.js";
import { runRecallAgent } from "./agents/recallAgent.js";
import { runSurveyAgent } from "./agents/surveyAgent.js";
import { runWriterAgent } from "./agents/writerAgent.js";
import { getLoopStore } from "./loopStore.js";
import {
  logLoopPhaseFailure,
  logLoopPhaseSuccess,
  updateLoopStopReason
} from "./quality/loopQualityLogger.js";
import {
  determineNextCheckpoint,
  getIterationContext,
  getPreviousCritique,
  shouldStopAfterCritique
} from "./paperLoopState.js";
import type {
  CriticAgentOutput,
  JsonPromptExecutionMeta,
  LoopReflection,
  LoopRunRecord,
  PaperLoopPhase,
  PaperRunStatus,
  ResearchTaskRecord
} from "./paperLoopTypes.js";
import { GeminiJsonPromptError } from "./agents/shared.js";

function toArray(value: string | string[] | undefined, fallback: string): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => item.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [fallback];
}

function buildReflection(phase: PaperLoopPhase, output: Record<string, unknown>): LoopReflection {
  switch (phase) {
    case "CONTEXT_RECALL":
      return {
        what_went_well: toArray(
          (output.recalledThreads as Array<unknown> | undefined)?.length
            ? "Archive recall found relevant prior Gemini threads."
            : undefined,
          "Recall phase completed with a structured context summary."
        ),
        what_is_missing: toArray(output.openQuestions as string[] | undefined, "Need stronger archived evidence coverage."),
        risk: [
          (output.recalledThreads as Array<unknown> | undefined)?.length
            ? "Archived context may still be incomplete or stale."
            : "No recalled archive context means later phases rely more on fresh Gemini synthesis."
        ],
        next_step: "Use the recalled context to synthesize a literature survey."
      };
    case "LITERATURE_SURVEY":
      return {
        what_went_well: toArray(output.methods as string[] | undefined, "Survey produced a structured note set."),
        what_is_missing: toArray(output.gaps as string[] | undefined, "Need clearer literature gaps."),
        risk: ["Survey notes may contain uncited claims that still need validation in drafting."],
        next_step: "Draft the requested paper section using recalled context and survey notes."
      };
    case "DRAFT_SECTION":
      return {
        what_went_well: ["A section draft now exists for critique and revision."],
        what_is_missing: toArray(
          output.claimsNeedingEvidence as string[] | undefined,
          "Need to identify unsupported claims before finalizing the draft."
        ),
        risk: ["Draft quality depends on whether recalled context is sufficient and correctly framed."],
        next_step: "Critique the draft and produce a revised version."
      };
    case "CRITIQUE_AND_REVISE":
      return {
        what_went_well: toArray(output.strengths as string[] | undefined, "Critique identified concrete strengths."),
        what_is_missing: toArray(
          output.missingEvidence as string[] | undefined,
          "Need more evidence and tighter revision targets."
        ),
        risk: toArray(output.weaknesses as string[] | undefined, "Revision may still leave unsupported reasoning."),
        next_step:
          typeof output.nextRevisionTarget === "string" && output.nextRevisionTarget.trim()
            ? output.nextRevisionTarget
            : "Decide whether to stop or start another iteration."
      };
  }
}

async function persistPhaseRun(
  task: ResearchTaskRecord,
  iteration: number,
  phase: PaperLoopPhase,
  inputJson: Record<string, unknown>,
  outputJson: Record<string, unknown>,
  selectedThreadId?: string
): Promise<LoopRunRecord> {
  const reflection = buildReflection(phase, outputJson);
  return getLoopStore().appendLoopRun({
    taskId: task.taskId,
    iteration,
    phase,
    inputJson,
    outputJson,
    reflectionJson: reflection,
    selectedThreadId
  });
}

function getFailureMeta(error: unknown): Partial<JsonPromptExecutionMeta> | undefined {
  if (error instanceof GeminiJsonPromptError) {
    return error.meta;
  }

  return undefined;
}

function getStopReason(
  critique: CriticAgentOutput | undefined,
  iteration: number,
  maxIterations: number
): string {
  if (iteration >= maxIterations) {
    return "max_iterations_reached";
  }

  const target = critique?.nextRevisionTarget.trim().toLowerCase() ?? "";
  if (target === "none" || target === "done" || target === "stop") {
    return `critique_requested_${target}`;
  }

  return `continue:${critique?.nextRevisionTarget.trim() || "unspecified"}`;
}

export interface PaperRunOptions {
  maxIterations?: number;
}

export class PaperLoopRunner {
  private readonly store = getLoopStore();

  async createTask(title: string, problemStatement: string, targetSection = appEnv.paperDefaultSection) {
    return this.store.createResearchTask({
      title,
      problemStatement,
      targetSection
    });
  }

  async getStatus(taskId: string): Promise<PaperRunStatus | null> {
    return this.store.getPaperRunStatus(taskId);
  }

  async runTask(taskId: string, options: PaperRunOptions = {}): Promise<PaperRunStatus> {
    const maxIterations = options.maxIterations ?? appEnv.paperLoopMaxIterations;
    const task = await this.store.getResearchTask(taskId);
    if (!task) {
      throw new Error(`research task not found: ${taskId}`);
    }

    let checkpoint = determineNextCheckpoint(await this.store.listLoopRuns(taskId));
    await this.store.updateResearchTaskProgress(taskId, "RUNNING", checkpoint.nextState, checkpoint.iteration);

    try {
      while (checkpoint.nextState !== "DONE") {
        if (checkpoint.nextState === "STOP_CHECK") {
          const allRuns = await this.store.listLoopRuns(taskId);
          const currentContext = getIterationContext(allRuns, checkpoint.iteration);
          const latestCritiqueRun = allRuns
            .filter((run) => run.phase === "CRITIQUE_AND_REVISE" && run.iteration === checkpoint.iteration)
            .at(-1);
          const stop = shouldStopAfterCritique(
            currentContext.critique as CriticAgentOutput | undefined,
            checkpoint.iteration,
            maxIterations
          );
          const stopReason = getStopReason(
            currentContext.critique as CriticAgentOutput | undefined,
            checkpoint.iteration,
            maxIterations
          );
          if (latestCritiqueRun) {
            await updateLoopStopReason(latestCritiqueRun.runId, stopReason);
          }

          if (stop) {
            await this.store.updateResearchTaskProgress(taskId, "COMPLETED", "DONE", checkpoint.iteration);
            break;
          }

          checkpoint = {
            nextState: "CONTEXT_RECALL",
            iteration: checkpoint.iteration + 1
          };
          await this.store.updateResearchTaskProgress(taskId, "RUNNING", checkpoint.nextState, checkpoint.iteration);
          continue;
        }

        if (checkpoint.iteration > maxIterations) {
          await this.store.updateResearchTaskProgress(taskId, "COMPLETED", "DONE", maxIterations);
          break;
        }

        const allRuns = await this.store.listLoopRuns(taskId);
        const currentTask = (await this.store.getResearchTask(taskId))!;
        const currentIteration = checkpoint.iteration;
        const currentContext = getIterationContext(allRuns, currentIteration);

        if (checkpoint.nextState === "CONTEXT_RECALL") {
          const phaseStartedAt = Date.now();
          try {
            const recall = await runRecallAgent(currentTask);
            const run = await persistPhaseRun(
              currentTask,
              currentIteration,
              "CONTEXT_RECALL",
              {
                title: currentTask.title,
                problemStatement: currentTask.problemStatement
              },
              recall.output as unknown as Record<string, unknown>,
              recall.output.selectedThreadId
            );
            await logLoopPhaseSuccess({
              task: currentTask,
              run,
              reflection: run.reflectionJson,
              outputJson: recall.output as unknown as Record<string, unknown>,
              phaseLatencyMs: Date.now() - phaseStartedAt,
              meta: recall.meta
            });
          } catch (error) {
            await logLoopPhaseFailure({
              task: currentTask,
              iteration: currentIteration,
              phase: "CONTEXT_RECALL",
              phaseLatencyMs: Date.now() - phaseStartedAt,
              error
            });
            throw error;
          }
        } else if (checkpoint.nextState === "LITERATURE_SURVEY") {
          if (!currentContext.recall) {
            throw new Error(`missing recall output for task ${taskId} iteration ${currentIteration}`);
          }
          const phaseStartedAt = Date.now();
          try {
            const survey = await runSurveyAgent(currentTask, currentContext.recall);
            const run = await persistPhaseRun(
              currentTask,
              currentIteration,
              "LITERATURE_SURVEY",
              {
                recall: currentContext.recall
              },
              survey.output as unknown as Record<string, unknown>,
              currentContext.recall.selectedThreadId
            );
            await logLoopPhaseSuccess({
              task: currentTask,
              run,
              reflection: run.reflectionJson,
              outputJson: survey.output as unknown as Record<string, unknown>,
              phaseLatencyMs: Date.now() - phaseStartedAt,
              meta: survey.meta
            });
          } catch (error) {
            await logLoopPhaseFailure({
              task: currentTask,
              iteration: currentIteration,
              phase: "LITERATURE_SURVEY",
              phaseLatencyMs: Date.now() - phaseStartedAt,
              selectedThreadId: currentContext.recall.selectedThreadId,
              meta: getFailureMeta(error),
              error
            });
            throw error;
          }
        } else if (checkpoint.nextState === "DRAFT_SECTION") {
          if (!currentContext.recall || !currentContext.survey) {
            throw new Error(`missing recall or survey output for task ${taskId} iteration ${currentIteration}`);
          }
          const priorCritique = getPreviousCritique(allRuns, currentIteration);
          const phaseStartedAt = Date.now();
          try {
            const draft = await runWriterAgent(
              currentTask,
              currentContext.recall,
              currentContext.survey,
              priorCritique
            );
            const run = await persistPhaseRun(
              currentTask,
              currentIteration,
              "DRAFT_SECTION",
              {
                recall: currentContext.recall,
                survey: currentContext.survey,
                priorCritique
              },
              draft.output as unknown as Record<string, unknown>,
              currentContext.recall.selectedThreadId
            );
            await logLoopPhaseSuccess({
              task: currentTask,
              run,
              reflection: run.reflectionJson,
              outputJson: draft.output as unknown as Record<string, unknown>,
              phaseLatencyMs: Date.now() - phaseStartedAt,
              meta: draft.meta
            });
          } catch (error) {
            await logLoopPhaseFailure({
              task: currentTask,
              iteration: currentIteration,
              phase: "DRAFT_SECTION",
              phaseLatencyMs: Date.now() - phaseStartedAt,
              selectedThreadId: currentContext.recall.selectedThreadId,
              meta: getFailureMeta(error),
              error
            });
            throw error;
          }
        } else if (checkpoint.nextState === "CRITIQUE_AND_REVISE") {
          if (!currentContext.recall || !currentContext.survey || !currentContext.draft) {
            throw new Error(`missing recall, survey, or draft output for task ${taskId} iteration ${currentIteration}`);
          }
          const phaseStartedAt = Date.now();
          try {
            const critique = await runCriticAgent(
              currentTask,
              currentContext.recall,
              currentContext.survey,
              currentContext.draft
            );
            const run = await persistPhaseRun(
              currentTask,
              currentIteration,
              "CRITIQUE_AND_REVISE",
              {
                recall: currentContext.recall,
                survey: currentContext.survey,
                draft: currentContext.draft
              },
              critique.output as unknown as Record<string, unknown>,
              currentContext.recall.selectedThreadId
            );
            await logLoopPhaseSuccess({
              task: currentTask,
              run,
              reflection: run.reflectionJson,
              outputJson: critique.output as unknown as Record<string, unknown>,
              phaseLatencyMs: Date.now() - phaseStartedAt,
              meta: critique.meta
            });
          } catch (error) {
            await logLoopPhaseFailure({
              task: currentTask,
              iteration: currentIteration,
              phase: "CRITIQUE_AND_REVISE",
              phaseLatencyMs: Date.now() - phaseStartedAt,
              selectedThreadId: currentContext.recall.selectedThreadId,
              meta: getFailureMeta(error),
              error
            });
            throw error;
          }
        }

        checkpoint = determineNextCheckpoint(await this.store.listLoopRuns(taskId));
        await this.store.updateResearchTaskProgress(taskId, "RUNNING", checkpoint.nextState, checkpoint.iteration);
      }
    } catch (error) {
      await this.store.updateResearchTaskProgress(taskId, "PAUSED", checkpoint.nextState, checkpoint.iteration);
      throw error;
    }

    const status = await this.store.getPaperRunStatus(taskId);
    if (!status) {
      throw new Error(`research task disappeared during run: ${taskId}`);
    }

    return status;
  }
}

let paperLoopRunnerSingleton: PaperLoopRunner | null = null;

export function getPaperLoopRunner(): PaperLoopRunner {
  paperLoopRunnerSingleton ??= new PaperLoopRunner();
  return paperLoopRunnerSingleton;
}
