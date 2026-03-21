import { appEnv } from "./config/env.js";
import { runPlannedGeminiPrompt } from "./agent/planner.js";
import { getArchiveService } from "./archive/archiveService.js";
import { runGeminiWebTask } from "./browser/geminiTool.js";

interface CliArgs {
  mode: "gemini" | "archive:list" | "archive:thread" | "archive:search" | "archive:reembed";
  prompt?: string;
  forceNewChat: boolean;
  forceModelOnResume: boolean;
  threadId?: string;
  query?: string;
  limit: number;
}

function sanitizeCliPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed.includes("^")) {
    return trimmed;
  }

  // On Windows npm/cmd invocations, carets can leak into argv as escape artifacts.
  // Strip only boundary-like carets so deliberate inner caret usage is less likely to be affected.
  return trimmed
    .replace(/\^(?=\S)/g, "")
    .replace(/(?<=\S)\^/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCliArgs(argv: string[]): CliArgs {
  const rawArgs = argv.slice(2);
  const archiveMode = rawArgs[0];
  if (archiveMode === "archive:list") {
    const limitIndex = rawArgs.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(rawArgs[limitIndex + 1] ?? "10") : 10;
    return {
      mode: "archive:list",
      forceNewChat: false,
      forceModelOnResume: false,
      limit
    };
  }
  if (archiveMode === "archive:thread") {
    return {
      mode: "archive:thread",
      forceNewChat: false,
      forceModelOnResume: false,
      threadId: rawArgs[1],
      limit: 10
    };
  }
  if (archiveMode === "archive:search") {
    const threadFlagIndex = rawArgs.indexOf("--thread");
    const limitIndex = rawArgs.indexOf("--limit");
    const threadId = threadFlagIndex >= 0 ? rawArgs[threadFlagIndex + 1] : undefined;
    const query = rawArgs
      .filter((arg, index) => {
        if (index === 0) return false;
        if (arg === "--thread" || arg === "--limit") return false;
        if (threadFlagIndex >= 0 && index === threadFlagIndex + 1) return false;
        if (limitIndex >= 0 && index === limitIndex + 1) return false;
        return true;
      })
      .join(" ")
      .trim();
    const limit = limitIndex >= 0 ? Number(rawArgs[limitIndex + 1] ?? "10") : 10;
    return {
      mode: "archive:search",
      forceNewChat: false,
      forceModelOnResume: false,
      threadId,
      query,
      limit
    };
  }
  if (archiveMode === "archive:reembed") {
    const limitIndex = rawArgs.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(rawArgs[limitIndex + 1] ?? "50") : 50;
    return {
      mode: "archive:reembed",
      forceNewChat: false,
      forceModelOnResume: false,
      limit
    };
  }

  const forceNewChat = rawArgs.includes("--new-chat");
  const forceModelOnResume = rawArgs.includes("--force-model");
  const prompt = sanitizeCliPrompt(
    rawArgs
    .filter((arg) => arg !== "--new-chat" && arg !== "--force-model")
    .join(" ")
    .trim()
  );

  return {
    mode: "gemini",
    forceNewChat,
    forceModelOnResume,
    limit: 10,
    prompt:
      prompt || "Please reply with a short sentence confirming that the browser workflow is connected."
  };
}

function requireValue(value: string | undefined, message: string): string {
  if (!value?.trim()) {
    throw new Error(message);
  }

  return value;
}

async function runArchiveCommand(args: CliArgs): Promise<void> {
  const archive = getArchiveService();
  const status = await archive.getStatus();

  if (!status.enabled) {
    throw new Error("Archive is disabled. Set POSTGRES_URL before using archive commands.");
  }

  if (args.mode === "archive:list") {
    const threads = await archive.listRecentThreads(args.limit);
    console.log(JSON.stringify(threads, null, 2));
    return;
  }

  if (args.mode === "archive:thread") {
    const threadId = requireValue(args.threadId, "archive:thread requires a thread id");
    const thread = await archive.getThread(threadId);
    console.log(JSON.stringify(thread, null, 2));
    return;
  }

  if (args.mode === "archive:search") {
    const threadId = requireValue(args.threadId, "archive:search requires --thread <thread_id>");
    const query = requireValue(args.query, "archive:search requires a query string");
    const results = await archive.searchByThread(threadId, query, args.limit);
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (args.mode === "archive:reembed") {
    const result = await archive.reembedMissingChunks(args.limit);
    console.log(JSON.stringify(result, null, 2));
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  if (args.mode !== "gemini") {
    await runArchiveCommand(args);
    return;
  }

  const { prompt, forceNewChat, forceModelOnResume } = args;
  const result =
    appEnv.geminiUseDirectTool || forceNewChat || forceModelOnResume
    ? await runGeminiWebTask(prompt ?? "", { forceNewChat, forceModelOnResume })
    : await runPlannedGeminiPrompt(prompt ?? "");

  if (result.success) {
    console.log(result.text ?? "");
    return;
  }

  console.error(result.error ?? "Gemini workflow failed.");

  if (result.diagnostics?.length) {
    for (const diagnostic of result.diagnostics) {
      console.error(`- ${diagnostic}`);
    }
  }

  process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
