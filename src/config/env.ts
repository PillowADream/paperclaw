import { config as loadEnv } from "dotenv";
import path from "node:path";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  LLM_API_KEY: z.string().min(1, "LLM_API_KEY is required."),
  LLM_MODEL: z.string().min(1).default("deepseek-chat"),
  LLM_BASE_URL: z.string().url().default("https://api.deepseek.com/v1"),
  POSTGRES_URL: z.string().optional(),
  POSTGRES_SSL: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  ARCHIVE_ENABLE_SUMMARY: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  ARCHIVE_ENABLE_EMBEDDINGS: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional().default("text-embedding-3-small"),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_DIMENSIONS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "1536")),
  ARCHIVE_EMBEDDING_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "20000")),
  ARCHIVE_EMBEDDING_BATCH_SIZE: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "10")),
  ARCHIVE_ENABLE_ROUTING: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  ARCHIVE_ROUTER_CANDIDATE_LIMIT: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "8")),
  ARCHIVE_ROUTER_RECALL_LIMIT: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "12")),
  ARCHIVE_ROUTER_ENABLE_RERANK: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  ARCHIVE_ROUTER_RERANK_LIMIT: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "4")),
  ARCHIVE_ROUTER_RERANK_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "12000")),
  ARCHIVE_CHUNK_SIZE: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "1200")),
  ARCHIVE_CHUNK_OVERLAP: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "200")),
  ARCHIVE_SUMMARY_EVERY_TURNS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "1")),
  ARCHIVE_SUMMARY_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "15000")),
  PAPER_DEFAULT_SECTION: z.string().optional().default("Introduction"),
  PAPER_LOOP_MAX_ITERATIONS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "3")),
  PAPER_LOOP_RECALL_LIMIT: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "4")),
  PAPER_LOOP_THREAD_SEARCH_LIMIT: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "3")),
  GEMINI_WEB_URL: z.string().url().default("https://gemini.google.com/app"),
  BROWSER_PROFILE_DIR: z.string().min(1).default("./browser-profile"),
  BROWSER_PROFILE_NAME: z.string().min(1).default("Default"),
  BROWSER_HEADLESS: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  BROWSER_KEEP_OPEN_ON_ERROR: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  BROWSER_CHANNEL: z.string().optional().default("chrome"),
  BROWSER_SLOW_MO_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "0")),
  GEMINI_USE_DIRECT_TOOL: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  GEMINI_TARGET_MODEL: z.string().default("pro"),
  GEMINI_PAGE_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "120000")),
  GEMINI_RESPONSE_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "180000")),
  GEMINI_STABLE_WAIT_MS: z
    .string()
    .optional()
    .transform((value) => Number(value ?? "2000")),
  LOG_LEVEL: z.string().default("info")
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment configuration:\n${details}`);
}

const env = parsedEnv.data;

export const appEnv = {
  llmApiKey: env.LLM_API_KEY,
  llmModel: env.LLM_MODEL,
  llmBaseUrl: env.LLM_BASE_URL,
  postgresUrl: env.POSTGRES_URL?.trim() || undefined,
  postgresSsl: env.POSTGRES_SSL,
  archiveEnableSummary: env.ARCHIVE_ENABLE_SUMMARY,
  archiveEnableEmbeddings: env.ARCHIVE_ENABLE_EMBEDDINGS,
  embeddingApiKey: env.EMBEDDING_API_KEY?.trim() || env.LLM_API_KEY,
  embeddingModel: env.EMBEDDING_MODEL,
  embeddingBaseUrl: env.EMBEDDING_BASE_URL?.trim() || env.LLM_BASE_URL,
  embeddingDimensions: env.EMBEDDING_DIMENSIONS,
  archiveEmbeddingTimeoutMs: env.ARCHIVE_EMBEDDING_TIMEOUT_MS,
  archiveEmbeddingBatchSize: env.ARCHIVE_EMBEDDING_BATCH_SIZE,
  archiveEnableRouting: env.ARCHIVE_ENABLE_ROUTING,
  archiveRouterCandidateLimit: env.ARCHIVE_ROUTER_CANDIDATE_LIMIT,
  archiveRouterRecallLimit: env.ARCHIVE_ROUTER_RECALL_LIMIT,
  archiveRouterEnableRerank: env.ARCHIVE_ROUTER_ENABLE_RERANK,
  archiveRouterRerankLimit: env.ARCHIVE_ROUTER_RERANK_LIMIT,
  archiveRouterRerankTimeoutMs: env.ARCHIVE_ROUTER_RERANK_TIMEOUT_MS,
  archiveChunkSize: env.ARCHIVE_CHUNK_SIZE,
  archiveChunkOverlap: env.ARCHIVE_CHUNK_OVERLAP,
  archiveSummaryEveryTurns: env.ARCHIVE_SUMMARY_EVERY_TURNS,
  archiveSummaryTimeoutMs: env.ARCHIVE_SUMMARY_TIMEOUT_MS,
  paperDefaultSection: env.PAPER_DEFAULT_SECTION,
  paperLoopMaxIterations: env.PAPER_LOOP_MAX_ITERATIONS,
  paperLoopRecallLimit: env.PAPER_LOOP_RECALL_LIMIT,
  paperLoopThreadSearchLimit: env.PAPER_LOOP_THREAD_SEARCH_LIMIT,
  geminiWebUrl: env.GEMINI_WEB_URL,
  browserProfileDir: path.resolve(env.BROWSER_PROFILE_DIR),
  browserProfileName: env.BROWSER_PROFILE_NAME,
  browserHeadless: env.BROWSER_HEADLESS,
  browserKeepOpenOnError: env.BROWSER_KEEP_OPEN_ON_ERROR,
  browserChannel: env.BROWSER_CHANNEL,
  browserSlowMoMs: env.BROWSER_SLOW_MO_MS,
  geminiUseDirectTool: env.GEMINI_USE_DIRECT_TOOL,
  geminiTargetModel: env.GEMINI_TARGET_MODEL,
  geminiPageTimeoutMs: env.GEMINI_PAGE_TIMEOUT_MS,
  geminiResponseTimeoutMs: env.GEMINI_RESPONSE_TIMEOUT_MS,
  geminiStableWaitMs: env.GEMINI_STABLE_WAIT_MS,
  logLevel: env.LOG_LEVEL
} as const;
