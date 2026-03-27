import type { PaperTraceReport } from "./paperTraceTypes.js";

function renderList(title: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`${title}: none`];
  }

  return [`${title}:`, ...values.map((value) => `  - ${value}`)];
}

function renderDetailLine(label: string, value: string | number | boolean | undefined): string {
  if (value === undefined || value === "") {
    return `${label}: n/a`;
  }

  return `${label}: ${value}`;
}

export function formatPaperTrace(report: PaperTraceReport): string {
  const lines: string[] = [];

  lines.push("Task Summary");
  lines.push(renderDetailLine("task_id", report.task.taskId));
  lines.push(renderDetailLine("title", report.task.title));
  lines.push(renderDetailLine("problem_statement", report.task.problemStatement));
  lines.push(renderDetailLine("target_section", report.task.targetSection));
  lines.push(renderDetailLine("status", report.task.status));
  lines.push(renderDetailLine("current_phase", report.task.currentPhase));
  lines.push(renderDetailLine("current_iteration", report.task.currentIteration));
  lines.push(renderDetailLine("created_at", report.task.createdAt));
  lines.push(renderDetailLine("updated_at", report.task.updatedAt));
  lines.push("");

  lines.push("Run Overview");
  lines.push(renderDetailLine("total_iterations", report.overview.totalIterations));
  lines.push(renderDetailLine("phases", report.overview.phasesEncountered.join(", ")));
  lines.push(renderDetailLine("completed", report.overview.completed));
  lines.push(renderDetailLine("final_stop_reason", report.overview.finalStopReason));
  lines.push(renderDetailLine("has_failures", report.overview.hasFailures));
  lines.push(renderDetailLine("has_json_repairs", report.overview.hasRepairs));
  lines.push(renderDetailLine("has_failed_repairs", report.overview.hasRepairFailures));
  lines.push("");

  for (const iteration of report.visibleIterations) {
    lines.push(`Iteration ${iteration.iteration}`);
    for (const detail of iteration.phases) {
      const metric = detail.metrics;
      lines.push(`phase: ${detail.phase}`);
      lines.push(`  phase_status: ${metric?.phaseStatus ?? "SUCCEEDED"}`);
      lines.push(`  run_id: ${detail.run?.runId ?? "n/a"}`);
      lines.push(`  started_at: ${detail.startedAt ?? "n/a"}`);
      lines.push(`  ended_at: ${detail.endedAt}`);
      lines.push(`  phase_latency_ms: ${metric?.phaseLatencyMs ?? "n/a"}`);
      lines.push(`  input_summary: ${detail.inputSummary}`);
      lines.push(`  output_summary: ${detail.outputSummary}`);
      lines.push(`  json_repair_used: ${metric?.jsonRepairUsed ?? "n/a"}`);
      lines.push(`  json_repair_succeeded: ${metric?.jsonRepairSucceeded ?? "n/a"}`);
      lines.push(`  selected_thread_id: ${detail.run?.selectedThreadId ?? metric?.selectedThreadId ?? "n/a"}`);
      if (detail.recallSummary) {
        lines.push(`  recalled_thread_count: ${detail.recallSummary.recalledThreadCount ?? "n/a"}`);
        lines.push(`  recalled_chunk_count: ${detail.recallSummary.recalledChunkCount ?? "n/a"}`);
        lines.push(`  recalled_excerpt_count: ${detail.recallSummary.recalledExcerptCount ?? "n/a"}`);
        lines.push(`  recall_sources: ${detail.recallSummary.sourceSummary ?? "n/a"}`);
      }
      if (metric?.criticIssueCount !== undefined || metric?.criticMissingEvidenceCount !== undefined) {
        lines.push(`  critic_issue_count: ${metric?.criticIssueCount ?? "n/a"}`);
        lines.push(`  critic_missing_evidence_count: ${metric?.criticMissingEvidenceCount ?? "n/a"}`);
      }
      lines.push(`  output_size_chars: ${metric?.outputSizeChars ?? "n/a"}`);
      lines.push(`  reflection_risk_level: ${metric?.reflectionRiskLevel ?? "n/a"}`);
      lines.push(`  stop_reason: ${metric?.stopReason ?? "n/a"}`);
      if (metric?.failureReason) {
        lines.push(`  failure_reason: ${metric.failureReason}`);
      }
      if (detail.run) {
        lines.push(...renderList("  reflection.what_went_well", detail.run.reflectionJson.what_went_well));
        lines.push(...renderList("  reflection.what_is_missing", detail.run.reflectionJson.what_is_missing));
        lines.push(...renderList("  reflection.risk", detail.run.reflectionJson.risk));
        lines.push(`  reflection.next_step: ${detail.run.reflectionJson.next_step}`);
      }
    }
    lines.push("");
  }

  lines.push("Final Status");
  lines.push(renderDetailLine("stop_reason", report.finalStatus.stopReason));
  lines.push(renderDetailLine("stop_check.should_stop", report.finalStatus.stopCheck?.shouldStop));
  lines.push(renderDetailLine("stop_check.reason", report.finalStatus.stopCheck?.reason));
  lines.push(...renderList("remaining_issues", report.finalStatus.remainingIssues));

  return lines.join("\n").trim();
}
