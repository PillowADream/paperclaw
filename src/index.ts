import { appEnv } from "./config/env.js";
import { runPlannedGeminiPrompt } from "./agent/planner.js";
import { getArchiveService } from "./archive/archiveService.js";
import { runGeminiWebTask } from "./browser/geminiTool.js";
import { getPaperLoopRunner } from "./loops/paperLoopRunner.js";
import { formatPaperTrace } from "./loops/trace/paperTraceFormatter.js";
import { buildPaperTraceReport, parseTracePhase } from "./loops/trace/paperTrace.js";
import type { PaperLoopPhase } from "./loops/paperLoopTypes.js";

interface CliArgs {
  mode:
    | "gemini"
    | "archive:list"
    | "archive:thread"
    | "archive:search"
    | "archive:reembed"
    | "paper:init"
    | "paper:run"
    | "paper:status"
    | "paper:trace";
  prompt?: string;
  forceNewChat: boolean;
  forceModelOnResume: boolean;
  threadId?: string;
  query?: string;
  limit: number;
  title?: string;
  problem?: string;
  taskId?: string;
  iterations?: number;
  section?: string;
  json?: boolean;
  iteration?: number;
  phase?: PaperLoopPhase;
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
  const mode = rawArgs[0];
  if (mode === "archive:list") {
    const limitIndex = rawArgs.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(rawArgs[limitIndex + 1] ?? "10") : 10;
    return {
      mode: "archive:list",
      forceNewChat: false,
      forceModelOnResume: false,
      limit
    };
  }
  if (mode === "archive:thread") {
    return {
      mode: "archive:thread",
      forceNewChat: false,
      forceModelOnResume: false,
      threadId: rawArgs[1],
      limit: 10
    };
  }
  if (mode === "archive:search") {
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
  if (mode === "archive:reembed") {
    const limitIndex = rawArgs.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(rawArgs[limitIndex + 1] ?? "50") : 50;
    return {
      mode: "archive:reembed",
      forceNewChat: false,
      forceModelOnResume: false,
      limit
    };
  }
  if (mode === "paper:init") {
    const titleIndex = rawArgs.indexOf("--title");
    const problemIndex = rawArgs.indexOf("--problem");
    const sectionIndex = rawArgs.indexOf("--section");
    return {
      mode: "paper:init",
      forceNewChat: false,
      forceModelOnResume: false,
      limit: 10,
      title: titleIndex >= 0 ? sanitizeCliPrompt(rawArgs[titleIndex + 1] ?? "") : undefined,
      problem: problemIndex >= 0 ? sanitizeCliPrompt(rawArgs[problemIndex + 1] ?? "") : undefined,
      section: sectionIndex >= 0 ? sanitizeCliPrompt(rawArgs[sectionIndex + 1] ?? "") : undefined
    };
  }
  if (mode === "paper:run") {
    const iterationsIndex = rawArgs.indexOf("--iterations");
    return {
      mode: "paper:run",
      forceNewChat: false,
      forceModelOnResume: false,
      limit: 10,
      taskId: rawArgs[1],
      iterations:
        iterationsIndex >= 0
          ? Number(rawArgs[iterationsIndex + 1] ?? `${appEnv.paperLoopMaxIterations}`)
          : appEnv.paperLoopMaxIterations
    };
  }
  if (mode === "paper:status") {
    return {
      mode: "paper:status",
      forceNewChat: false,
      forceModelOnResume: false,
      limit: 10,
      taskId: rawArgs[1]
    };
  }
  if (mode === "paper:trace") {
    const iterationIndex = rawArgs.indexOf("--iteration");
    const phaseIndex = rawArgs.indexOf("--phase");
    return {
      mode: "paper:trace",
      forceNewChat: false,
      forceModelOnResume: false,
      limit: 10,
      taskId: rawArgs[1],
      json: rawArgs.includes("--json"),
      iteration: iterationIndex >= 0 ? Number(rawArgs[iterationIndex + 1] ?? "0") : undefined,
      phase: parseTracePhase(phaseIndex >= 0 ? rawArgs[phaseIndex + 1] : undefined)
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

async function runPaperCommand(args: CliArgs): Promise<void> {
  const runner = getPaperLoopRunner();

  if (args.mode === "paper:init") {
    const title = requireValue(args.title, "paper:init requires --title");
    const problem = requireValue(args.problem, "paper:init requires --problem");
    const task = await runner.createTask(title, problem, args.section?.trim() || appEnv.paperDefaultSection);
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  const taskId = requireValue(args.taskId, `${args.mode} requires <task_id>`);

  if (args.mode === "paper:run") {
    const status = await runner.runTask(taskId, {
      maxIterations: args.iterations
    });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (args.mode === "paper:status") {
    const status = await runner.getStatus(taskId);
    if (!status) {
      throw new Error(`research task not found: ${taskId}`);
    }
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (args.mode === "paper:trace") {
    const trace = await buildPaperTraceReport(taskId, {
      iteration: args.iteration,
      phase: args.phase
    });
    if (!trace) {
      throw new Error(`research task not found: ${taskId}`);
    }
    if (args.json) {
      console.log(JSON.stringify(trace, null, 2));
      return;
    }
    console.log(formatPaperTrace(trace));
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  if (args.mode.startsWith("archive:")) {
    await runArchiveCommand(args);
    return;
  }
  if (args.mode.startsWith("paper:")) {
    await runPaperCommand(args);
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
