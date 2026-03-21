import { createHash } from "node:crypto";

import { appEnv } from "../config/env.js";
import { chunkMessage } from "./archiveChunker.js";
import { getArchiveEmbedder } from "./archiveEmbedder.js";
import { ArchiveStore } from "./archiveStore.js";
import { ArchiveSummarizer } from "./archiveSummarizer.js";
import type {
  ArchiveChunkBackfillRecord,
  ArchiveMessageRecord,
  ArchiveReembedResult,
  ArchiveThreadRecallCandidate,
  ArchiveThreadSummaryRecord,
  ArchiveTurnInput,
  ArchiveTurnResult
} from "./archiveTypes.js";

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractStableConversationKey(conversationUrl?: string): string | undefined {
  if (!conversationUrl) {
    return undefined;
  }

  try {
    const parsed = new URL(conversationUrl);
    if (parsed.hostname !== "gemini.google.com") {
      return undefined;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    const appIndex = segments.findIndex((segment) => segment === "app");
    const conversationSegment = appIndex >= 0 ? segments[appIndex + 1] : undefined;

    return conversationSegment?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function buildThreadId(conversationUrl?: string): string {
  const stableKey = extractStableConversationKey(conversationUrl);
  if (stableKey) {
    return `gemini:${stableKey}`;
  }

  const normalized = conversationUrl?.trim().toLowerCase() || "gemini:unknown-thread";
  return `gemini:url:${sha256(normalized).slice(0, 24)}`;
}

function buildMessageId(threadId: string, turnIndex: number, role: "user" | "assistant"): string {
  return `${threadId}:turn:${turnIndex}:${role}`;
}

function shouldChunk(message: ArchiveMessageRecord): boolean {
  if (message.role === "assistant") {
    return message.contentText.length >= 200;
  }

  return message.contentText.length >= Math.max(300, appEnv.archiveChunkSize);
}

export class ArchiveService {
  private readonly store = new ArchiveStore();
  private readonly summarizer = new ArchiveSummarizer();
  private readonly embedder = getArchiveEmbedder();

  async archiveTurn(input: ArchiveTurnInput): Promise<ArchiveTurnResult> {
    const status = await this.store.initialize();
    if (!status.enabled) {
      return {
        enabled: false,
        archived: false,
        summaryUpdated: false,
        chunksCreated: 0,
        pgvectorEnabled: false,
        degradedFeatures: status.degradedFeatures,
        message: "archive disabled because POSTGRES_URL is not configured"
      };
    }

    const threadId = buildThreadId(input.conversationUrl);
    let turnIndex = 0;
    const messages: ArchiveMessageRecord[] = [];
    let chunksCreated = 0;

    await this.store.withTransaction(async (client) => {
      await this.store.upsertThread(
        {
          threadId,
          conversationUrl: input.conversationUrl,
          title: input.title,
          source: input.source,
          modelLastSeen: input.modelLastSeen,
          locale: input.locale,
          lastRunMode: input.lastRunMode
        },
        client
      );

      turnIndex = await this.store.getNextTurnIndex(threadId, client);

      const promptMessage: ArchiveMessageRecord = {
        messageId: buildMessageId(threadId, turnIndex, "user"),
        threadId,
        role: "user",
        turnIndex,
        contentRaw: input.prompt,
        contentText: normalizeText(input.prompt),
        metadataJson: input.promptMetadata
      };
      const replyMessage: ArchiveMessageRecord = {
        messageId: buildMessageId(threadId, turnIndex, "assistant"),
        threadId,
        role: "assistant",
        turnIndex,
        contentRaw: input.reply,
        contentText: normalizeText(input.reply),
        metadataJson: input.replyMetadata
      };

      messages.push(promptMessage, replyMessage);

      for (const message of messages) {
        await this.store.upsertMessage(message, client);
        const chunks = shouldChunk(message)
          ? chunkMessage(message, {
              chunkSize: appEnv.archiveChunkSize,
              overlap: appEnv.archiveChunkOverlap
            })
          : [];
        chunksCreated += chunks.length;
        await this.store.replaceChunks(message.messageId, chunks, client);
      }
    });

    let summaryUpdated = false;
    const degradedFeatures = [...status.degradedFeatures];
    const chunkRecords = messages.flatMap((message) =>
      shouldChunk(message)
        ? chunkMessage(message, {
            chunkSize: appEnv.archiveChunkSize,
            overlap: appEnv.archiveChunkOverlap
          })
        : []
    );

    if (appEnv.archiveEnableSummary) {
      try {
        const context = await this.store.getThreadContext(threadId);
        const turnCount = context ? new Set(context.messages.map((message) => message.turnIndex)).size : 0;
        const shouldRefreshSummary =
          Boolean(context) &&
          (!context?.summary ||
            turnCount <= 1 ||
            turnCount % Math.max(1, appEnv.archiveSummaryEveryTurns) === 0);

        if (context && shouldRefreshSummary) {
          const summaryDraft = await this.summarizer.summarizeThread(threadId, context.messages, context.summary);
          const summaryRecord: ArchiveThreadSummaryRecord = {
            threadId,
            summaryShort: summaryDraft.summaryShort,
            summaryLong: summaryDraft.summaryLong,
            tags: summaryDraft.tags,
            keywords: summaryDraft.keywords,
            openQuestions: summaryDraft.openQuestions
          };
          await this.store.upsertSummary(summaryRecord);
          summaryUpdated = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        degradedFeatures.push(`summary-update-failed:${message}`);
      }
    }

    const latestStatus = this.store.getStatus();

    if (latestStatus.pgvectorEnabled && chunkRecords.length > 0) {
      try {
        const embeddings = await this.embedder.embedTexts(chunkRecords.map((chunk) => chunk.chunkText));
        const embeddedChunks = chunkRecords.map((chunk, index) => ({
          ...chunk,
          embedding: embeddings[index]
        }));
        await this.store.updateChunkEmbeddings(embeddedChunks);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        degradedFeatures.push(`chunk-embedding-failed:${message}`);
      }
    }

    return {
      enabled: true,
      archived: true,
      threadId,
      turnIndex,
      summaryUpdated,
      chunksCreated,
      pgvectorEnabled: latestStatus.pgvectorEnabled,
      degradedFeatures: [...latestStatus.degradedFeatures, ...degradedFeatures],
      message: "archive turn completed"
    };
  }

  async listRecentThreads(limit = 10) {
    return this.store.listRecentThreads(limit);
  }

  async getThreadSummary(threadId: string) {
    const context = await this.store.getThreadContext(threadId);
    return context?.summary;
  }

  async getThread(threadId: string) {
    return this.store.getThreadContext(threadId);
  }

  async searchByThread(threadId: string, queryText: string, limit = 10) {
    return this.store.searchByThread(threadId, queryText, limit);
  }

  async recallThreads(queryText: string, limit = 10): Promise<ArchiveThreadRecallCandidate[]> {
    return this.store.recallThreads(queryText, limit);
  }

  async recallThreadsByVector(queryEmbedding: number[], limit = 10): Promise<ArchiveThreadRecallCandidate[]> {
    return this.store.recallThreadsByVector(queryEmbedding, limit);
  }

  async reembedMissingChunks(limit = 50): Promise<ArchiveReembedResult> {
    const status = await this.store.initialize();
    if (!status.enabled) {
      return {
        enabled: false,
        pgvectorEnabled: false,
        scanned: 0,
        updated: 0,
        remainingEstimate: 0,
        degradedFeatures: status.degradedFeatures
      };
    }

    if (!status.pgvectorEnabled) {
      return {
        enabled: true,
        pgvectorEnabled: false,
        scanned: 0,
        updated: 0,
        remainingEstimate: 0,
        degradedFeatures: status.degradedFeatures
      };
    }

    const pendingChunks = await this.store.listChunksMissingEmbeddings(limit);
    if (pendingChunks.length === 0) {
      return {
        enabled: true,
        pgvectorEnabled: true,
        scanned: 0,
        updated: 0,
        remainingEstimate: 0,
        degradedFeatures: status.degradedFeatures
      };
    }

    const degradedFeatures = [...status.degradedFeatures];
    let updated = 0;

    try {
      const embeddings = await this.embedder.embedTexts(pendingChunks.map((chunk) => chunk.chunkText));
      const embeddedChunks: ArchiveChunkBackfillRecord[] = pendingChunks;
      await this.store.updateChunkEmbeddings(
        embeddedChunks.map((chunk, index) => ({
          chunkId: chunk.chunkId,
          threadId: chunk.threadId,
          messageId: chunk.messageId,
          turnIndex: 0,
          role: "assistant",
          chunkOrder: 0,
          chunkText: chunk.chunkText,
          embedding: embeddings[index]
        }))
      );
      updated = pendingChunks.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      degradedFeatures.push(`reembed-failed:${message}`);
    }

    const remainingEstimate = await this.store.countChunksMissingEmbeddings();

    return {
      enabled: true,
      pgvectorEnabled: true,
      scanned: pendingChunks.length,
      updated,
      remainingEstimate,
      degradedFeatures
    };
  }

  async getStatus() {
    return this.store.initialize();
  }
}

let archiveServiceSingleton: ArchiveService | null = null;

export function getArchiveService(): ArchiveService {
  archiveServiceSingleton ??= new ArchiveService();
  return archiveServiceSingleton;
}
