import type {
  CriticAgentOutput,
  JsonPromptExecutionMeta,
  LoopReflection,
  LoopRunRecord,
  PaperLoopPhase,
  RecallAgentOutput,
  ReflectionRiskLevel,
  ResearchTaskRecord
} from "../paperLoopTypes.js";
import { getLoopStore } from "../loopStore.js";

function inferReflectionRiskLevel(
  reflection: LoopReflection,
  phase: PaperLoopPhase,
  outputJson: Record<string, unknown>
): ReflectionRiskLevel {
  const riskText = [
    ...reflection.risk,
    ...reflection.what_is_missing,
    reflection.next_step
  ]
    .join(" ")
    .toLowerCase();

  if (
    phase === "CRITIQUE_AND_REVISE" &&
    Array.isArray((outputJson as unknown as CriticAgentOutput).missingEvidence) &&
    (((outputJson as unknown as CriticAgentOutput).missingEvidence?.length ?? 0) > 0)
  ) {
    return "high";
  }

  if (/(unsupported|missing evidence|uncited|no recalled|incomplete|stale|risk)/.test(riskText)) {
    return "high";
  }

  if (riskText.trim().length > 0) {
    return "medium";
  }

  return "low";
}

function safeJsonSize(value: Record<string, unknown>): number {
  return JSON.stringify(value).length;
}

function deriveRecallMetrics(output: Record<string, unknown>) {
  const recall = output as unknown as RecallAgentOutput;
  const recalledThreads = Array.isArray(recall.recalledThreads) ? recall.recalledThreads : [];
  const recalledExcerptCount = recalledThreads.reduce(
    (count, thread) => count + (Array.isArray(thread.recentExcerpts) ? thread.recentExcerpts.length : 0),
    0
  );

  return {
    recalledThreadCount: recalledThreads.length,
    // Current recall persists excerpts, not original chunk ids, so chunk count remains unavailable.
    recalledChunkCount: undefined,
    recalledExcerptCount
  };
}

function deriveCriticMetrics(output: Record<string, unknown>) {
  const critique = output as unknown as CriticAgentOutput;
  const weaknesses = Array.isArray(critique.weaknesses) ? critique.weaknesses.length : 0;
  const missingEvidence = Array.isArray(critique.missingEvidence) ? critique.missingEvidence.length : 0;

  return {
    criticIssueCount: weaknesses + missingEvidence,
    criticMissingEvidenceCount: missingEvidence
  };
}

function toFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1000);
}

export async function logLoopPhaseSuccess(params: {
  task: ResearchTaskRecord;
  run: LoopRunRecord;
  reflection: LoopReflection;
  outputJson: Record<string, unknown>;
  phaseLatencyMs: number;
  meta: JsonPromptExecutionMeta;
}): Promise<void> {
  const { task, run, reflection, outputJson, phaseLatencyMs, meta } = params;
  const recallMetrics = run.phase === "CONTEXT_RECALL" ? deriveRecallMetrics(outputJson) : {};
  const criticMetrics = run.phase === "CRITIQUE_AND_REVISE" ? deriveCriticMetrics(outputJson) : {};

  try {
    await getLoopStore().appendLoopRunMetric({
      loopRunId: run.runId,
      taskId: task.taskId,
      iteration: run.iteration,
      phase: run.phase,
      phaseStatus: "SUCCEEDED",
      phaseLatencyMs,
      jsonRepairUsed: meta.jsonRepairUsed,
      jsonRepairSucceeded: meta.jsonRepairUsed ? meta.jsonRepairSucceeded : false,
      selectedThreadId: run.selectedThreadId,
      outputSizeChars: safeJsonSize(outputJson),
      reflectionRiskLevel: inferReflectionRiskLevel(reflection, run.phase, outputJson),
      ...recallMetrics,
      ...criticMetrics
    });
  } catch (error) {
    console.error(
      `[paper-loop] metrics write failed for task=${task.taskId} iteration=${run.iteration} phase=${run.phase}: ${toFailureReason(error)}`
    );
  }
}

export async function logLoopPhaseFailure(params: {
  task: ResearchTaskRecord;
  iteration: number;
  phase: PaperLoopPhase;
  phaseLatencyMs: number;
  selectedThreadId?: string;
  meta?: Partial<JsonPromptExecutionMeta>;
  error: unknown;
}): Promise<void> {
  const { task, iteration, phase, phaseLatencyMs, selectedThreadId, meta, error } = params;

  try {
    await getLoopStore().appendLoopRunMetric({
      taskId: task.taskId,
      iteration,
      phase,
      phaseStatus: "FAILED",
      phaseLatencyMs,
      jsonRepairUsed: meta?.jsonRepairUsed,
      jsonRepairSucceeded: meta?.jsonRepairSucceeded,
      selectedThreadId,
      failureReason: toFailureReason(error)
    });
  } catch (metricsError) {
    console.error(
      `[paper-loop] failure metrics write failed for task=${task.taskId} iteration=${iteration} phase=${phase}: ${toFailureReason(metricsError)}`
    );
  }
}

export async function updateLoopStopReason(loopRunId: string, stopReason: string): Promise<void> {
  try {
    await getLoopStore().updateLoopRunMetricStopReason(loopRunId, stopReason);
  } catch (error) {
    console.error(`[paper-loop] stop reason metrics update failed for run=${loopRunId}: ${toFailureReason(error)}`);
  }
}
