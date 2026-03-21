export type ArchiveMessageRole = "user" | "assistant";

export interface ArchiveThreadRecord {
  threadId: string;
  conversationUrl?: string;
  title?: string;
  source: string;
  modelLastSeen?: string;
  locale?: string;
  createdAt?: string;
  updatedAt?: string;
  lastRunMode?: string;
}

export interface ArchiveMessageRecord {
  messageId: string;
  threadId: string;
  role: ArchiveMessageRole;
  turnIndex: number;
  contentRaw: string;
  contentText: string;
  createdAt?: string;
  metadataJson?: Record<string, unknown>;
}

export interface ArchiveThreadSummaryRecord {
  threadId: string;
  summaryShort?: string;
  summaryLong?: string;
  tags: string[];
  keywords: string[];
  openQuestions: string[];
  lastSummarizedAt?: string;
}

export interface ArchiveChunkRecord {
  chunkId: string;
  threadId: string;
  messageId: string;
  turnIndex: number;
  role: ArchiveMessageRole;
  chunkOrder: number;
  chunkText: string;
  embedding?: number[];
  createdAt?: string;
}

export interface ArchiveChunkerConfig {
  chunkSize: number;
  overlap: number;
}

export interface ArchiveTurnInput {
  prompt: string;
  reply: string;
  conversationUrl?: string;
  source: string;
  modelLastSeen?: string;
  locale?: string;
  lastRunMode?: string;
  title?: string;
  promptMetadata?: Record<string, unknown>;
  replyMetadata?: Record<string, unknown>;
}

export interface ArchiveTurnResult {
  enabled: boolean;
  archived: boolean;
  threadId?: string;
  turnIndex?: number;
  summaryUpdated: boolean;
  chunksCreated: number;
  pgvectorEnabled: boolean;
  degradedFeatures: string[];
  message?: string;
}

export interface ArchiveSearchResult {
  messageId: string;
  threadId: string;
  turnIndex: number;
  role: ArchiveMessageRole;
  contentText: string;
  createdAt: string;
  rank: number;
}

export interface ArchiveStoreStatus {
  enabled: boolean;
  schemaInitialized: boolean;
  pgvectorEnabled: boolean;
  degradedFeatures: string[];
}

export interface ArchiveSummaryDraft {
  summaryShort?: string;
  summaryLong?: string;
  tags: string[];
  keywords: string[];
  openQuestions: string[];
}

export interface ArchiveThreadContext {
  thread: ArchiveThreadRecord;
  messages: ArchiveMessageRecord[];
  summary?: ArchiveThreadSummaryRecord;
}

export interface ArchiveThreadRoute {
  matched: boolean;
  threadId?: string;
  conversationUrl?: string;
  score: number;
  reason: string;
  diagnostics: string[];
  strategy?: "heuristic" | "llm-rerank";
}

export interface ArchiveThreadRecallCandidate {
  threadId: string;
  score: number;
  matchedBy: string[];
}

export interface ArchiveChunkBackfillRecord {
  chunkId: string;
  threadId: string;
  messageId: string;
  chunkText: string;
}

export interface ArchiveReembedResult {
  enabled: boolean;
  pgvectorEnabled: boolean;
  scanned: number;
  updated: number;
  remainingEstimate: number;
  degradedFeatures: string[];
}
