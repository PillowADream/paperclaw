import { createHash } from "node:crypto";

import type { ArchiveChunkRecord, ArchiveChunkerConfig, ArchiveMessageRecord } from "./archiveTypes.js";

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function buildChunkId(messageId: string, chunkOrder: number, chunkText: string): string {
  const hash = createHash("sha256")
    .update(`${messageId}:${chunkOrder}:${chunkText}`)
    .digest("hex")
    .slice(0, 16);

  return `${messageId}:chunk:${chunkOrder}:${hash}`;
}

export function chunkMessage(
  message: ArchiveMessageRecord,
  config: ArchiveChunkerConfig
): ArchiveChunkRecord[] {
  const text = normalizeWhitespace(message.contentText);
  if (!text) {
    return [];
  }

  const chunkSize = Math.max(200, config.chunkSize);
  const overlap = Math.max(0, Math.min(config.overlap, Math.floor(chunkSize / 2)));
  const chunks: ArchiveChunkRecord[] = [];

  let start = 0;
  let order = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const softBreak = text.lastIndexOf("\n", end);
      const sentenceBreak = text.lastIndexOf("。", end);
      const periodBreak = text.lastIndexOf(".", end);
      const bestBreak = Math.max(softBreak, sentenceBreak, periodBreak);
      if (bestBreak > start + Math.floor(chunkSize * 0.6)) {
        end = bestBreak + 1;
      }
    }

    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        chunkId: buildChunkId(message.messageId, order, chunkText),
        threadId: message.threadId,
        messageId: message.messageId,
        turnIndex: message.turnIndex,
        role: message.role,
        chunkOrder: order,
        chunkText
      });
      order += 1;
    }

    if (end >= text.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
