import { ChatOpenAI } from "@langchain/openai";

import { appEnv } from "../config/env.js";
import { getArchiveEmbedder } from "./archiveEmbedder.js";
import type { ArchiveThreadContext, ArchiveThreadRoute } from "./archiveTypes.js";
import { getArchiveService } from "./archiveService.js";

interface ScoredThreadCandidate {
  context: ArchiveThreadContext;
  score: number;
  reason: string;
}

interface RouterDecisionPayload {
  selected_thread_id?: string;
  confidence?: number;
  reason?: string;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function isLikelyRoutableGeminiConversationUrl(conversationUrl?: string): boolean {
  if (!conversationUrl) {
    return false;
  }

  try {
    const parsed = new URL(conversationUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const appIndex = segments.findIndex((segment) => segment === "app");
    const conversationId = appIndex >= 0 ? segments[appIndex + 1] : undefined;
    if (!conversationId) {
      return false;
    }
    return /^[a-z0-9]{12,}$/i.test(conversationId);
  } catch {
    return false;
  }
}

function scoreThread(prompt: string, context: ArchiveThreadContext): { score: number; reason: string } {
  const summary = context.summary;
  const summaryText = [
    summary?.summaryShort ?? "",
    summary?.summaryLong ?? "",
    ...(summary?.tags ?? []),
    ...(summary?.keywords ?? [])
  ]
    .join(" ")
    .trim();

  const promptTokens = new Set(tokenize(prompt));
  const candidateTokens = new Set(tokenize(summaryText));
  let score = 0;

  for (const token of promptTokens) {
    if (candidateTokens.has(token)) {
      score += 8;
    }
  }

  const normalizedPrompt = normalizeText(prompt);
  const normalizedSummary = normalizeText(summaryText);
  if (normalizedPrompt && normalizedSummary.includes(normalizedPrompt)) {
    score += 20;
  }

  const recentMessages = context.messages.slice(-6).map((message) => normalizeText(message.contentText));
  for (const token of promptTokens) {
    if (recentMessages.some((message) => message.includes(token))) {
      score += 3;
    }
  }

  if (summary?.summaryShort) {
    score += 4;
  }

  const reasonParts = [
    summary?.summaryShort ? `summary=${summary.summaryShort}` : "summary=none",
    summary?.keywords?.length ? `keywords=${summary.keywords.slice(0, 4).join(",")}` : "keywords=none"
  ];

  return {
    score,
    reason: reasonParts.join(" | ")
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function buildCandidatePrompt(prompt: string, candidates: ScoredThreadCandidate[]): string {
  const serializedCandidates = candidates.map((candidate, index) => {
    const summary = candidate.context.summary;
    return JSON.stringify({
      rank: index + 1,
      thread_id: candidate.context.thread.threadId,
      conversation_url: candidate.context.thread.conversationUrl,
      heuristic_score: candidate.score,
      summary_short: summary?.summaryShort ?? "",
      summary_long: summary?.summaryLong ?? "",
      tags: summary?.tags ?? [],
      keywords: summary?.keywords ?? [],
      recent_messages: candidate.context.messages.slice(-4).map((message) => ({
        role: message.role,
        turn_index: message.turnIndex,
        text: message.contentText.slice(0, 240)
      }))
    });
  });

  return [
    "You choose which existing Gemini web conversation thread should continue a new user request.",
    "Return strict JSON only with fields: selected_thread_id, confidence, reason.",
    "Confidence is a number from 0 to 1.",
    "Pick exactly one candidate only if it is genuinely the best continuation context.",
    "If none fit well, return selected_thread_id as an empty string and explain why.",
    `new_user_prompt=${prompt}`,
    "Candidates:",
    ...serializedCandidates
  ].join("\n");
}

export class ArchiveThreadRouter {
  private readonly rerankModel = new ChatOpenAI({
    apiKey: appEnv.llmApiKey,
    model: appEnv.llmModel,
    configuration: {
      baseURL: appEnv.llmBaseUrl
    },
    temperature: 0
  });
  private readonly embedder = getArchiveEmbedder();

  async routePrompt(prompt: string): Promise<ArchiveThreadRoute> {
    const archive = getArchiveService();
    const status = await archive.getStatus();

    if (!status.enabled || !appEnv.archiveEnableRouting) {
      return {
        matched: false,
        score: 0,
        reason: "archive routing disabled",
        diagnostics: status.degradedFeatures
      };
    }

    const diagnostics: string[] = [];
    const textRecall = await archive.recallThreads(prompt, appEnv.archiveRouterRecallLimit);
    let vectorRecall = [] as Awaited<ReturnType<typeof archive.recallThreadsByVector>>;

    if (status.pgvectorEnabled && appEnv.archiveEnableEmbeddings) {
      try {
        const queryEmbedding = await this.embedder.embedQuery(prompt);
        vectorRecall = await archive.recallThreadsByVector(queryEmbedding, appEnv.archiveRouterRecallLimit);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push(`vector recall failed: ${message}`);
      }
    }

    const recallMap = new Map<string, { threadId: string; score: number; matchedBy: Set<string> }>();
    for (const recalled of [...textRecall, ...vectorRecall]) {
      const existing = recallMap.get(recalled.threadId);
      if (existing) {
        existing.score += recalled.score;
        for (const item of recalled.matchedBy) {
          existing.matchedBy.add(item);
        }
      } else {
        recallMap.set(recalled.threadId, {
          threadId: recalled.threadId,
          score: recalled.score,
          matchedBy: new Set(recalled.matchedBy)
        });
      }
    }

    const recalledThreads = [...recallMap.values()]
      .map((item) => ({
        threadId: item.threadId,
        score: item.score,
        matchedBy: [...item.matchedBy]
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, appEnv.archiveRouterRecallLimit);

    const threadIds =
      recalledThreads.length > 0
        ? recalledThreads.map((candidate) => candidate.threadId)
        : (await archive.listRecentThreads(appEnv.archiveRouterCandidateLimit)).map((thread) => thread.threadId);

    if (threadIds.length === 0) {
      return {
        matched: false,
        score: 0,
        reason: "no archived threads available",
        diagnostics
      };
    }

    if (recalledThreads.length > 0) {
      for (const recalled of recalledThreads) {
        diagnostics.push(
          `recall ${recalled.threadId} score=${recalled.score} matchedBy=${recalled.matchedBy.join(",")}`
        );
      }
    } else {
      diagnostics.push("recall fallback to recent threads");
    }

    const candidates: ScoredThreadCandidate[] = [];

    for (const threadId of threadIds) {
      const context = await archive.getThread(threadId);
      if (!context?.thread.conversationUrl || !isLikelyRoutableGeminiConversationUrl(context.thread.conversationUrl)) {
        continue;
      }

      const scored = scoreThread(prompt, context);
      diagnostics.push(`candidate ${threadId} score=${scored.score}`);
      candidates.push({
        context,
        score: scored.score,
        reason: scored.reason
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    const bestHeuristic = candidates[0] ?? null;

    if (!bestHeuristic || bestHeuristic.score < 8) {
      return {
        matched: false,
        score: bestHeuristic?.score ?? 0,
        reason: "no thread exceeded routing threshold",
        diagnostics
      };
    }

    if (!appEnv.archiveRouterEnableRerank || candidates.length === 1) {
      return {
        matched: true,
        threadId: bestHeuristic.context.thread.threadId,
        conversationUrl: bestHeuristic.context.thread.conversationUrl,
        score: bestHeuristic.score,
        reason: bestHeuristic.reason,
        diagnostics,
        strategy: "heuristic"
      };
    }

    try {
      const rerankCandidates = candidates.slice(0, Math.max(1, appEnv.archiveRouterRerankLimit));
      const response = await withTimeout(
        this.rerankModel.invoke([{ role: "user", content: buildCandidatePrompt(prompt, rerankCandidates) }]),
        appEnv.archiveRouterRerankTimeoutMs,
        "archive router rerank"
      );

      const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      const decision = JSON.parse(extractJsonObject(raw)) as RouterDecisionPayload;
      diagnostics.push(`rerank reason=${decision.reason ?? "none"} confidence=${decision.confidence ?? 0}`);

      const selectedThreadId = decision.selected_thread_id?.trim();
      const selected = selectedThreadId
        ? rerankCandidates.find((candidate) => candidate.context.thread.threadId === selectedThreadId)
        : undefined;

      if (selected && Number(decision.confidence ?? 0) >= 0.45) {
        return {
          matched: true,
          threadId: selected.context.thread.threadId,
          conversationUrl: selected.context.thread.conversationUrl,
          score: selected.score,
          reason: decision.reason?.trim() || selected.reason,
          diagnostics,
          strategy: "llm-rerank"
        };
      }

      diagnostics.push("rerank fallback to heuristic best candidate");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`rerank failed: ${message}`);
    }

    return {
      matched: true,
      threadId: bestHeuristic.context.thread.threadId,
      conversationUrl: bestHeuristic.context.thread.conversationUrl,
      score: bestHeuristic.score,
      reason: bestHeuristic.reason,
      diagnostics,
      strategy: "heuristic"
    };
  }
}

let archiveThreadRouterSingleton: ArchiveThreadRouter | null = null;

export function getArchiveThreadRouter(): ArchiveThreadRouter {
  archiveThreadRouterSingleton ??= new ArchiveThreadRouter();
  return archiveThreadRouterSingleton;
}
