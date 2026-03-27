import type {
  CriticAgentOutput,
  LoopRunRecord,
  PaperLoopIterationContext,
  PaperLoopPhase,
  PaperLoopStateName
} from "./paperLoopTypes.js";

export interface PaperRunnerCheckpoint {
  nextState: PaperLoopStateName;
  iteration: number;
}

export function getIterationContext(runs: LoopRunRecord[], iteration: number): PaperLoopIterationContext {
  const byPhase = new Map<PaperLoopPhase, LoopRunRecord>();
  for (const run of runs) {
    if (run.iteration === iteration) {
      byPhase.set(run.phase, run);
    }
  }

  return {
    recall: byPhase.get("CONTEXT_RECALL")?.outputJson as PaperLoopIterationContext["recall"],
    survey: byPhase.get("LITERATURE_SURVEY")?.outputJson as PaperLoopIterationContext["survey"],
    draft: byPhase.get("DRAFT_SECTION")?.outputJson as PaperLoopIterationContext["draft"],
    critique: byPhase.get("CRITIQUE_AND_REVISE")?.outputJson as PaperLoopIterationContext["critique"]
  };
}

export function getPreviousCritique(runs: LoopRunRecord[], iteration: number): CriticAgentOutput | undefined {
  return runs
    .filter((run) => run.phase === "CRITIQUE_AND_REVISE" && run.iteration === iteration - 1)
    .at(-1)?.outputJson as CriticAgentOutput | undefined;
}

export function determineNextCheckpoint(runs: LoopRunRecord[]): PaperRunnerCheckpoint {
  if (runs.length === 0) {
    return {
      nextState: "CONTEXT_RECALL",
      iteration: 1
    };
  }

  const latest = runs[runs.length - 1];
  switch (latest.phase) {
    case "CONTEXT_RECALL":
      return { nextState: "LITERATURE_SURVEY", iteration: latest.iteration };
    case "LITERATURE_SURVEY":
      return { nextState: "DRAFT_SECTION", iteration: latest.iteration };
    case "DRAFT_SECTION":
      return { nextState: "CRITIQUE_AND_REVISE", iteration: latest.iteration };
    case "CRITIQUE_AND_REVISE":
      return { nextState: "STOP_CHECK", iteration: latest.iteration };
  }
}

export function shouldStopAfterCritique(
  critique: CriticAgentOutput | undefined,
  iteration: number,
  maxIterations: number
): boolean {
  if (iteration >= maxIterations) {
    return true;
  }

  const target = critique?.nextRevisionTarget.trim().toLowerCase() ?? "";
  return target === "none" || target === "done" || target === "stop";
}
