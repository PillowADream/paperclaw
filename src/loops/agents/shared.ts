import { runGeminiWebTask } from "../../browser/geminiTool.js";
import type { JsonPromptExecutionMeta, PaperAgentResult } from "../paperLoopTypes.js";

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function ensureString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function ensureStringArray(value: unknown): string[] {
  return toStringArray(value).map((item) => item.trim());
}

function parseJsonObject(raw: string): Record<string, unknown> {
  return JSON.parse(extractJsonBlock(raw)) as Record<string, unknown>;
}

export class GeminiJsonPromptError extends Error {
  readonly meta: JsonPromptExecutionMeta;

  constructor(message: string, meta: JsonPromptExecutionMeta) {
    super(message);
    this.name = "GeminiJsonPromptError";
    this.meta = meta;
  }
}

export async function runGeminiJsonPrompt<T>(
  prompt: string,
  requiredKeys: string[],
  map: (payload: Record<string, unknown>) => T
): Promise<PaperAgentResult<T>> {
  const result = await runGeminiWebTask(prompt);
  if (!result.success || !result.text?.trim()) {
    throw new Error(result.error ?? "Gemini browser execution did not return text");
  }

  const rawResponseChars = result.text.length;
  try {
    return {
      output: map(parseJsonObject(result.text)),
      meta: {
        jsonRepairUsed: false,
        jsonRepairSucceeded: false,
        rawResponseChars
      }
    };
  } catch (error) {
    const firstError = error instanceof Error ? error.message : String(error);
    const repairPrompt = [
      "Rewrite your immediately previous answer as strict valid JSON only.",
      `Required keys: ${requiredKeys.join(", ")}.`,
      "Do not add markdown fences or explanations.",
      "Preserve the same meaning, but escape strings correctly so the JSON parses.",
      "Return exactly one JSON object."
    ].join("\n");

    const repaired = await runGeminiWebTask(repairPrompt);
    if (!repaired.success || !repaired.text?.trim()) {
      throw new GeminiJsonPromptError(`Gemini returned non-JSON paper loop output: ${firstError}`, {
        jsonRepairUsed: true,
        jsonRepairSucceeded: false,
        rawResponseChars
      });
    }

    try {
      return {
        output: map(parseJsonObject(repaired.text)),
        meta: {
          jsonRepairUsed: true,
          jsonRepairSucceeded: true,
          rawResponseChars,
          repairedResponseChars: repaired.text.length
        }
      };
    } catch (repairError) {
      const secondError = repairError instanceof Error ? repairError.message : String(repairError);
      throw new GeminiJsonPromptError(
        `Gemini returned non-JSON paper loop output: first=${firstError}; repair=${secondError}`,
        {
          jsonRepairUsed: true,
          jsonRepairSucceeded: false,
          rawResponseChars,
          repairedResponseChars: repaired.text.length
        }
      );
    }
  }
}
