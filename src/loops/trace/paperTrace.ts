import { getLoopStore } from "../loopStore.js";
import type {
  CriticAgentOutput,
  LoopRunMetricRecord,
  LoopRunRecord,
  PaperLoopPhase,
  PaperRunTrace,
  RecallAgentOutput
} from "../paperLoopTypes.js";
import type { PaperTraceIterationDetail, PaperTraceOptions, PaperTraceReport } from "./paperTraceTypes.js";

function summarizeScalar(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function summarizeObject(value: Record<string, unknown>, maxLength = 320): string {
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .slice(0, 6)
    .map(([key, item]) => {
      if (Array.isArray(item)) {
        return `${key}=[${item
          .slice(0, 3)
          .map((entry) => summarizeScalar(entry) || JSON.stringify(entry))
          .join("; ")}${item.length > 3 ? "; ..." : ""}]`;
      }
      if (typeof item === "object") {
        return `${key}={...}`;
      }
      return `${key}=${summarizeScalar(item)}`;
    })
    .join(" | ");

  return entries.length > maxLength ? `${entries.slice(0, maxLength)}...` : entries || "{}";
}

function summarizeInput(run: LoopRunRecord): string {
  return summarizeObject(run.inputJson);
}

function summarizeOutput(run: LoopRunRecord): string {
  return summarizeObject(run.outputJson);
}

function buildRecallSummary(run: LoopRunRecord, metric?: LoopRunMetricRecord) {
  if (run.phase !== "CONTEXT_RECALL") {
    return undefined;
  }

  const recall = run.outputJson as unknown as RecallAgentOutput;
  const recalledThreads = Array.isArray(recall.recalledThreads) ? recall.recalledThreads : [];
  const sourceSummary = recalledThreads
    .slice(0, 3)
    .map((thread) => {
      const title = typeof thread.title === "string" && thread.title.trim() ? ` (${thread.title.trim()})` : "";
      return `${thread.threadId}${title}`;
    })
    .join(", ");

  return {
    recalledThreadCount: metric?.recalledThreadCount ?? recalledThreads.length,
    recalledChunkCount: metric?.recalledChunkCount,
    recalledExcerptCount: metric?.recalledExcerptCount,
    selectedThreadId: run.selectedThreadId,
    sourceSummary: sourceSummary || undefined
  };
}

function deriveStartedAt(run: LoopRunRecord, metric?: LoopRunMetricRecord): string | undefined {
  if (!metric?.phaseLatencyMs) {
    return undefined;
  }

  const endMs = new Date(run.createdAt).getTime();
  return new Date(endMs - metric.phaseLatencyMs).toISOString();
}

function normalizeTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

function buildIterationDetail(run: LoopRunRecord, metric?: LoopRunMetricRecord): PaperTraceIterationDetail {
  return {
    phase: run.phase,
    run,
    metrics: metric,
    startedAt: deriveStartedAt(run, metric),
    endedAt: normalizeTimestamp(run.createdAt),
    inputSummary: summarizeInput(run),
    outputSummary: summarizeOutput(run),
    recallSummary: buildRecallSummary(run, metric)
  };
}

function buildFailureDetail(metric: LoopRunMetricRecord): PaperTraceIterationDetail {
  return {
    phase: metric.phase,
    metrics: metric,
    startedAt: metric.phaseLatencyMs
      ? new Date(new Date(metric.createdAt).getTime() - metric.phaseLatencyMs).toISOString()
      : undefined,
    endedAt: normalizeTimestamp(metric.createdAt),
    inputSummary: "n/a",
    outputSummary: "n/a"
  };
}

function getFinalStopReason(trace: PaperRunTrace): string | undefined {
  const lastMetricWithStop = [...trace.metrics].reverse().find((metric) => metric.stopReason);
  if (lastMetricWithStop?.stopReason) {
    return lastMetricWithStop.stopReason;
  }

  if (trace.task.status === "COMPLETED") {
    return "completed_without_explicit_stop_reason";
  }

  if (trace.task.status === "PAUSED") {
    return "paused_due_to_phase_failure";
  }

  return undefined;
}

function getRemainingIssues(trace: PaperRunTrace): string[] {
  const lastCritique = [...trace.runs].reverse().find((run) => run.phase === "CRITIQUE_AND_REVISE");
  const critique = lastCritique?.outputJson as CriticAgentOutput | undefined;
  if (!critique) {
    return [];
  }

  const issues = [
    ...(Array.isArray(critique.weaknesses) ? critique.weaknesses : []),
    ...(Array.isArray(critique.missingEvidence) ? critique.missingEvidence : [])
  ];
  return issues.slice(0, 8);
}

function buildOverview(trace: PaperRunTrace) {
  const totalIterations = trace.runs.reduce((max, run) => Math.max(max, run.iteration), 0);
  const phasesEncountered = Array.from(new Set(trace.runs.map((run) => run.phase)));
  const finalStopReason = getFinalStopReason(trace);
  const hasFailures = trace.metrics.some((metric) => metric.phaseStatus === "FAILED");
  const hasRepairs = trace.metrics.some((metric) => metric.jsonRepairUsed);
  const hasRepairFailures = trace.metrics.some(
    (metric) => metric.jsonRepairUsed && metric.jsonRepairSucceeded === false
  );

  return {
    totalIterations,
    phasesEncountered,
    completed: trace.task.status === "COMPLETED",
    finalStopReason,
    hasFailures,
    hasRepairs,
    hasRepairFailures
  };
}

function filterRuns(runs: LoopRunRecord[], options: PaperTraceOptions): LoopRunRecord[] {
  return runs.filter((run) => {
    if (options.iteration !== undefined && run.iteration !== options.iteration) {
      return false;
    }
    if (options.phase && run.phase !== options.phase) {
      return false;
    }
    return true;
  });
}

export async function buildPaperTraceReport(
  taskId: string,
  options: PaperTraceOptions = {}
): Promise<PaperTraceReport | null> {
  const trace = await getLoopStore().getPaperRunTrace(taskId);
  if (!trace) {
    return null;
  }

  const metricsByRunId = new Map<string, LoopRunMetricRecord>();
  for (const metric of trace.metrics) {
    if (metric.loopRunId && metric.phaseStatus === "SUCCEEDED") {
      metricsByRunId.set(metric.loopRunId, metric);
    }
  }

  const visibleRuns = filterRuns(trace.runs, options);
  const visibleFailureMetrics = trace.metrics.filter((metric) => {
    if (metric.loopRunId || metric.phaseStatus !== "FAILED") {
      return false;
    }
    if (options.iteration !== undefined && metric.iteration !== options.iteration) {
      return false;
    }
    if (options.phase && metric.phase !== options.phase) {
      return false;
    }
    return true;
  });
  const byIteration = new Map<number, PaperTraceIterationDetail[]>();
  for (const run of visibleRuns) {
    const detail = buildIterationDetail(run, metricsByRunId.get(run.runId));
    const current = byIteration.get(run.iteration) ?? [];
    current.push(detail);
    byIteration.set(run.iteration, current);
  }
  for (const metric of visibleFailureMetrics) {
    const detail = buildFailureDetail(metric);
    const current = byIteration.get(metric.iteration) ?? [];
    current.push(detail);
    byIteration.set(metric.iteration, current);
  }

  const latestCritique = [...trace.runs].reverse().find((run) => run.phase === "CRITIQUE_AND_REVISE");
  const latestCritiqueOutput = latestCritique?.outputJson as CriticAgentOutput | undefined;
  const stopReason = getFinalStopReason(trace);

  return {
    task: trace.task,
    trace,
    overview: buildOverview(trace),
    visibleIterations: Array.from(byIteration.entries())
      .sort(([left], [right]) => left - right)
      .map(([iteration, phases]) => ({
        iteration,
        phases: phases.sort((left, right) => left.endedAt.localeCompare(right.endedAt))
      })),
    finalStatus: {
      stopReason,
      remainingIssues: getRemainingIssues(trace),
      stopCheck: latestCritiqueOutput
        ? {
            shouldStop: stopReason ? !stopReason.startsWith("continue:") : trace.task.status === "COMPLETED",
            reason: stopReason
          }
        : undefined
    }
  };
}

export function parseTracePhase(value: string | undefined): PaperLoopPhase | undefined {
  if (!value) {
    return undefined;
  }

  const phase = value.trim().toUpperCase();
  if (
    phase === "CONTEXT_RECALL" ||
    phase === "LITERATURE_SURVEY" ||
    phase === "DRAFT_SECTION" ||
    phase === "CRITIQUE_AND_REVISE"
  ) {
    return phase;
  }

  throw new Error(`unsupported paper phase: ${value}`);
}
