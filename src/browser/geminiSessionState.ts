import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GeminiRunMode, GeminiRunStage } from "../types/result.js";

export interface GeminiSessionState {
  lastConversationUrl?: string;
  lastKnownModel?: string;
  lastSuccessAt?: string;
  lastRunMode?: GeminiRunMode;
  lastReplyExcerpt?: string;
  uiLocale?: string;
  lastFailureStage?: GeminiRunStage;
  lastFailureReason?: string;
  updatedAt?: string;
}

const runtimeDir = path.resolve("runtime");
const sessionFilePath = path.join(runtimeDir, "session.json");

export function getGeminiSessionFilePath(): string {
  return sessionFilePath;
}

export function isGeminiConversationUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "gemini.google.com" &&
      parsedUrl.pathname.startsWith("/app/") &&
      parsedUrl.pathname !== "/app/"
    );
  } catch {
    return false;
  }
}

export async function loadGeminiSessionState(): Promise<GeminiSessionState> {
  try {
    const raw = await readFile(sessionFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed === "string") {
      return {
        lastConversationUrl: parsed
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const data = parsed as Record<string, unknown>;
    const updatedAt = asOptionalString(data.updatedAt);
    const lastSuccessAt = asOptionalString(data.lastSuccessAt) ?? updatedAt;

    return {
      lastConversationUrl: asOptionalString(data.lastConversationUrl),
      lastKnownModel: asOptionalString(data.lastKnownModel),
      lastSuccessAt,
      lastRunMode: asRunMode(data.lastRunMode),
      lastReplyExcerpt: asOptionalString(data.lastReplyExcerpt),
      uiLocale: asOptionalString(data.uiLocale),
      lastFailureStage: asRunStage(data.lastFailureStage),
      lastFailureReason: asOptionalString(data.lastFailureReason),
      updatedAt
    };
  } catch {
    return {};
  }
}

export async function saveGeminiSessionState(state: GeminiSessionState): Promise<void> {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(sessionFilePath, JSON.stringify(state, null, 2), "utf8");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRunMode(value: unknown): GeminiRunMode | undefined {
  return value === "resume" || value === "new-chat" ? value : undefined;
}

function asRunStage(value: unknown): GeminiRunStage | undefined {
  return typeof value === "string" ? (value as GeminiRunStage) : undefined;
}
