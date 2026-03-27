import { ChatOpenAI } from "@langchain/openai";

import { appEnv } from "../config/env.js";
import type {
  ArchiveMessageRecord,
  ArchiveSummaryDraft,
  ArchiveThreadSummaryRecord
} from "./archiveTypes.js";

interface SummaryModelPayload {
  summary_short?: string;
  summary_long?: string;
  tags?: string[];
  keywords?: string[];
  open_questions?: string[];
}

const SUMMARY_TRANSCRIPT_MESSAGE_LIMIT = 6;
const SUMMARY_MESSAGE_CLIP_CHARS = 1200;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
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

function clip(text: string, max = 3000): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toTranscript(messages: ArchiveMessageRecord[]): string {
  return messages
    .slice(-SUMMARY_TRANSCRIPT_MESSAGE_LIMIT)
    .map((message) => `turn=${message.turnIndex} role=${message.role}\n${clip(message.contentText, SUMMARY_MESSAGE_CLIP_CHARS)}`)
    .join("\n\n");
}

function sanitizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 12);
}

function sanitizeSummaryPayload(payload: SummaryModelPayload): ArchiveSummaryDraft {
  return {
    summaryShort: typeof payload.summary_short === "string" ? payload.summary_short.trim() : undefined,
    summaryLong: typeof payload.summary_long === "string" ? payload.summary_long.trim() : undefined,
    tags: sanitizeList(payload.tags),
    keywords: sanitizeList(payload.keywords),
    openQuestions: sanitizeList(payload.open_questions)
  };
}

function dedupe(items: string[], limit: number): string[] {
  return [...new Set(items.filter(Boolean))].slice(0, limit);
}

function buildFallbackSummary(
  threadId: string,
  messages: ArchiveMessageRecord[],
  existingSummary?: ArchiveThreadSummaryRecord
): ArchiveSummaryDraft {
  const recentMessages = messages.slice(-SUMMARY_TRANSCRIPT_MESSAGE_LIMIT);
  const assistantMessages = recentMessages.filter((message) => message.role === "assistant");
  const userMessages = recentMessages.filter((message) => message.role === "user");
  const latestAssistant = assistantMessages.at(-1)?.contentText ?? "";
  const latestUser = userMessages.at(-1)?.contentText ?? "";
  const combined = recentMessages.map((message) => message.contentText).join(" ");
  const keywords = dedupe(
    [
      ...(existingSummary?.keywords ?? []),
      ...tokenize(latestUser),
      ...tokenize(latestAssistant)
    ],
    12
  );

  const tags = dedupe(
    [
      ...(existingSummary?.tags ?? []),
      keywords[0] ?? "",
      keywords[1] ?? "",
      latestAssistant ? "assistant-reply" : "",
      latestUser ? "user-request" : ""
    ],
    8
  );

  const summaryShort =
    clip(
      latestUser
        ? `Thread ${threadId} recent request: ${latestUser}`
        : existingSummary?.summaryShort ?? `Thread ${threadId} archived conversation summary`,
      160
    ) || `Thread ${threadId} archived conversation summary`;

  const summaryLong = clip(
    [
      existingSummary?.summaryLong ? `Previous summary: ${existingSummary.summaryLong}` : "",
      latestUser ? `Latest user request: ${latestUser}` : "",
      latestAssistant ? `Latest assistant reply: ${latestAssistant}` : "",
      combined ? `Recent context: ${combined}` : ""
    ]
      .filter(Boolean)
      .join(" "),
    800
  );

  return {
    summaryShort,
    summaryLong,
    tags,
    keywords,
    openQuestions: dedupe(existingSummary?.openQuestions ?? [], 8)
  };
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

export class ArchiveSummarizer {
  private readonly model = new ChatOpenAI({
    apiKey: appEnv.llmApiKey,
    model: appEnv.llmModel,
    configuration: {
      baseURL: appEnv.llmBaseUrl
    },
    temperature: 0
  });

  async summarizeThread(
    threadId: string,
    messages: ArchiveMessageRecord[],
    existingSummary?: ArchiveThreadSummaryRecord
  ): Promise<ArchiveSummaryDraft> {
    const transcript = toTranscript(messages);
    const prompt = [
      "You summarize archived Gemini web conversations for retrieval and later classification.",
      "Return strict JSON only.",
      "Fields: summary_short, summary_long, tags, keywords, open_questions.",
      "Rules:",
      "- summary_short <= 160 chars",
      "- summary_long <= 800 chars",
      "- tags <= 8 items",
      "- keywords <= 12 items",
      "- open_questions <= 8 items",
      "- Use the same language as the conversation when obvious.",
      `thread_id=${threadId}`,
      existingSummary
        ? `existing_summary_short=${existingSummary.summaryShort ?? ""}\nexisting_tags=${existingSummary.tags.join(", ")}`
        : "existing_summary_short=",
      "Recent conversation transcript:",
      transcript
    ].join("\n");

    try {
      const response = await withTimeout(
        this.model.invoke([{ role: "user", content: prompt }]),
        appEnv.archiveSummaryTimeoutMs,
        "archive summarizer"
      );

      const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
      const parsed = JSON.parse(extractJsonObject(raw)) as SummaryModelPayload;
      return sanitizeSummaryPayload(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[archive] summarizer fallback for ${threadId}: ${message}`);
      return buildFallbackSummary(threadId, messages, existingSummary);
    }
  }
}
