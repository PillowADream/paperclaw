import { getArchiveService } from "../../archive/archiveService.js";
import { appEnv } from "../../config/env.js";
import type { PaperAgentResult, RecallAgentOutput, RecallThreadContext, ResearchTaskRecord } from "../paperLoopTypes.js";

function compactText(value: string | undefined, maxLength = 240): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function buildResearchContext(threads: RecallThreadContext[]): string {
  if (threads.length === 0) {
    return "No relevant archived Gemini threads were recalled for this task yet.";
  }

  return threads
    .map((thread, index) => {
      const summary = thread.summaryLong || thread.summaryShort || "No archived summary available.";
      const excerpts = thread.recentExcerpts.length > 0 ? thread.recentExcerpts.join(" | ") : "No matching excerpts.";
      return [
        `Thread ${index + 1}: ${thread.threadId}`,
        `Score: ${thread.score} via ${thread.matchedBy.join(", ")}`,
        `Summary: ${compactText(summary, 500)}`,
        `Recent excerpts: ${compactText(excerpts, 500)}`
      ].join("\n");
    })
    .join("\n\n");
}

export async function runRecallAgent(task: ResearchTaskRecord): Promise<PaperAgentResult<RecallAgentOutput>> {
  const archive = getArchiveService();
  const candidates = await archive.recallThreads(task.problemStatement, appEnv.paperLoopRecallLimit);
  const recalledThreads: RecallThreadContext[] = [];

  for (const candidate of candidates) {
    const context = await archive.getThread(candidate.threadId);
    if (!context) {
      continue;
    }

    const recentExcerpts = context.messages
      .slice(-appEnv.paperLoopThreadSearchLimit)
      .map((message) => compactText(message.contentText, 220))
      .filter(Boolean);

    recalledThreads.push({
      threadId: candidate.threadId,
      score: candidate.score,
      matchedBy: candidate.matchedBy,
      title: context.thread.title,
      summaryShort: context.summary?.summaryShort,
      summaryLong: context.summary?.summaryLong,
      recentExcerpts
    });
  }

  const researchContext = buildResearchContext(recalledThreads);
  const openQuestions =
    recalledThreads.length > 0
      ? recalledThreads
          .slice(0, 3)
          .map((thread) => `Need to verify archived claims from ${thread.threadId} before treating them as paper evidence.`)
      : ["No prior archive context was recalled; later phases need to surface evidence explicitly."];

  return {
    output: {
      topic: task.problemStatement,
      selectedThreadId: recalledThreads[0]?.threadId,
      recalledThreads,
      researchContext,
      openQuestions
    },
    meta: {
      jsonRepairUsed: false,
      jsonRepairSucceeded: false,
      rawResponseChars: researchContext.length
    }
  };
}
