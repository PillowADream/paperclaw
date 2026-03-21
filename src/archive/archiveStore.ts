import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { appEnv } from "../config/env.js";
import type {
  ArchiveChunkBackfillRecord,
  ArchiveChunkRecord,
  ArchiveMessageRecord,
  ArchiveSearchResult,
  ArchiveStoreStatus,
  ArchiveThreadRecallCandidate,
  ArchiveThreadContext,
  ArchiveThreadRecord,
  ArchiveThreadSummaryRecord
} from "./archiveTypes.js";

interface ListRecentThreadRow {
  thread_id: string;
  conversation_url: string | null;
  title: string | null;
  source: string;
  model_last_seen: string | null;
  locale: string | null;
  created_at: string;
  updated_at: string;
  last_run_mode: string | null;
}

interface MessageRow {
  message_id: string;
  thread_id: string;
  role: "user" | "assistant";
  turn_index: number;
  content_raw: string;
  content_text: string;
  created_at: string;
  metadata_json: Record<string, unknown>;
}

interface SummaryRow {
  thread_id: string;
  summary_short: string | null;
  summary_long: string | null;
  tags_json: unknown;
  keywords_json: unknown;
  open_questions_json: unknown;
  last_summarized_at: string | null;
}

interface SearchRow {
  message_id: string;
  thread_id: string;
  turn_index: number;
  role: "user" | "assistant";
  content_text: string;
  created_at: string;
  rank: number;
}

interface RecallRow {
  thread_id: string;
  score: number;
  matched_by: string[];
}

function parseJsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function tokenizeRecallQuery(queryText: string): string[] {
  const normalized = queryText
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  const unique = [...new Set(normalized)];
  return unique.slice(0, 8);
}

function toThreadRecord(row: ListRecentThreadRow): ArchiveThreadRecord {
  return {
    threadId: row.thread_id,
    conversationUrl: row.conversation_url ?? undefined,
    title: row.title ?? undefined,
    source: row.source,
    modelLastSeen: row.model_last_seen ?? undefined,
    locale: row.locale ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunMode: row.last_run_mode ?? undefined
  };
}

export class ArchiveStore {
  private readonly pool: Pool | null;
  private initialized = false;
  private pgvectorEnabled = false;
  private degradedFeatures = new Set<string>();

  constructor() {
    if (!appEnv.postgresUrl) {
      this.pool = null;
      return;
    }

    this.pool = new Pool({
      connectionString: appEnv.postgresUrl,
      ssl: appEnv.postgresSsl ? { rejectUnauthorized: false } : undefined
    });
  }

  getStatus(): ArchiveStoreStatus {
    return {
      enabled: Boolean(this.pool),
      schemaInitialized: this.initialized,
      pgvectorEnabled: this.pgvectorEnabled,
      degradedFeatures: [...this.degradedFeatures]
    };
  }

  async initialize(): Promise<ArchiveStoreStatus> {
    if (!this.pool) {
      this.degradedFeatures.add("archive-disabled:no-postgres-url");
      return this.getStatus();
    }

    if (this.initialized) {
      return this.getStatus();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS threads (
          thread_id TEXT PRIMARY KEY,
          conversation_url TEXT,
          title TEXT,
          source TEXT NOT NULL,
          model_last_seen TEXT,
          locale TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_run_mode TEXT
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          turn_index INTEGER NOT NULL,
          content_raw TEXT NOT NULL,
          content_text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          UNIQUE (thread_id, turn_index, role)
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS thread_summaries (
          thread_id TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
          summary_short TEXT,
          summary_long TEXT,
          tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          keywords_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          open_questions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          last_summarized_at TIMESTAMPTZ
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          chunk_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
          turn_index INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          chunk_order INTEGER NOT NULL,
          chunk_text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (message_id, chunk_order)
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_thread_created_at ON messages(thread_id, created_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_chunks_thread_created_at ON chunks(thread_id, created_at DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_chunks_message_id ON chunks(message_id);`);

      if (appEnv.archiveEnableEmbeddings) {
        try {
          await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.degradedFeatures.add(`pgvector-extension-unavailable:${message}`);
        }

        const vectorTypeResult = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') AS exists;`
        );
        this.pgvectorEnabled = Boolean(vectorTypeResult.rows[0]?.exists);

        if (this.pgvectorEnabled) {
          await client.query(
            `ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding vector(${appEnv.embeddingDimensions});`
          );
          try {
            await client.query(
              `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_ivfflat ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.degradedFeatures.add(`pgvector-index-unavailable:${message}`);
          }
        } else {
          this.degradedFeatures.add("pgvector-disabled:fallback-to-text-search");
        }
      }

      await client.query("COMMIT");
      this.initialized = true;
      return this.getStatus();
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getNextTurnIndex(threadId: string, client?: PoolClient): Promise<number> {
    const result = await this.query<{ next_turn: number }>(
      `
        SELECT COALESCE(MAX(turn_index), -1) + 1 AS next_turn
        FROM messages
        WHERE thread_id = $1
      `,
      [threadId],
      client
    );

    return Number(result.rows[0]?.next_turn ?? 0);
  }

  async upsertThread(thread: ArchiveThreadRecord, client?: PoolClient): Promise<void> {
    await this.execute(
      `
        INSERT INTO threads (
          thread_id,
          conversation_url,
          title,
          source,
          model_last_seen,
          locale,
          last_run_mode,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (thread_id) DO UPDATE
        SET
          conversation_url = COALESCE(EXCLUDED.conversation_url, threads.conversation_url),
          title = COALESCE(EXCLUDED.title, threads.title),
          source = EXCLUDED.source,
          model_last_seen = COALESCE(EXCLUDED.model_last_seen, threads.model_last_seen),
          locale = COALESCE(EXCLUDED.locale, threads.locale),
          last_run_mode = COALESCE(EXCLUDED.last_run_mode, threads.last_run_mode),
          updated_at = NOW()
      `,
      [
        thread.threadId,
        thread.conversationUrl ?? null,
        thread.title ?? null,
        thread.source,
        thread.modelLastSeen ?? null,
        thread.locale ?? null,
        thread.lastRunMode ?? null
      ],
      client
    );
  }

  async upsertMessage(message: ArchiveMessageRecord, client?: PoolClient): Promise<void> {
    await this.execute(
      `
        INSERT INTO messages (
          message_id,
          thread_id,
          role,
          turn_index,
          content_raw,
          content_text,
          metadata_json,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
        ON CONFLICT (message_id) DO UPDATE
        SET
          content_raw = EXCLUDED.content_raw,
          content_text = EXCLUDED.content_text,
          metadata_json = EXCLUDED.metadata_json
      `,
      [
        message.messageId,
        message.threadId,
        message.role,
        message.turnIndex,
        message.contentRaw,
        message.contentText,
        JSON.stringify(message.metadataJson ?? {})
      ],
      client
    );
  }

  async replaceChunks(messageId: string, chunks: ArchiveChunkRecord[], client?: PoolClient): Promise<void> {
    await this.execute(`DELETE FROM chunks WHERE message_id = $1`, [messageId], client);

    for (const chunk of chunks) {
      await this.execute(
        `
          INSERT INTO chunks (
            chunk_id,
            thread_id,
            message_id,
            turn_index,
            role,
            chunk_order,
            chunk_text,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (chunk_id) DO UPDATE
          SET chunk_text = EXCLUDED.chunk_text
        `,
        [
          chunk.chunkId,
          chunk.threadId,
          chunk.messageId,
          chunk.turnIndex,
          chunk.role,
          chunk.chunkOrder,
          chunk.chunkText
        ],
        client
      );
    }
  }

  async updateChunkEmbeddings(chunks: ArchiveChunkRecord[], client?: PoolClient): Promise<void> {
    for (const chunk of chunks) {
      if (!chunk.embedding?.length) {
        continue;
      }

      await this.execute(
        `
          UPDATE chunks
          SET embedding = $2::vector
          WHERE chunk_id = $1
        `,
        [chunk.chunkId, `[${chunk.embedding.join(",")}]`],
        client
      );
    }
  }

  async upsertSummary(summary: ArchiveThreadSummaryRecord, client?: PoolClient): Promise<void> {
    await this.execute(
      `
        INSERT INTO thread_summaries (
          thread_id,
          summary_short,
          summary_long,
          tags_json,
          keywords_json,
          open_questions_json,
          last_summarized_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, NOW())
        ON CONFLICT (thread_id) DO UPDATE
        SET
          summary_short = EXCLUDED.summary_short,
          summary_long = EXCLUDED.summary_long,
          tags_json = EXCLUDED.tags_json,
          keywords_json = EXCLUDED.keywords_json,
          open_questions_json = EXCLUDED.open_questions_json,
          last_summarized_at = NOW()
      `,
      [
        summary.threadId,
        summary.summaryShort ?? null,
        summary.summaryLong ?? null,
        JSON.stringify(summary.tags),
        JSON.stringify(summary.keywords),
        JSON.stringify(summary.openQuestions)
      ],
      client
    );
  }

  async getThreadContext(threadId: string): Promise<ArchiveThreadContext | null> {
    const threadResult = await this.query<ListRecentThreadRow>(
      `
        SELECT
          thread_id,
          conversation_url,
          title,
          source,
          model_last_seen,
          locale,
          created_at,
          updated_at,
          last_run_mode
        FROM threads
        WHERE thread_id = $1
      `,
      [threadId]
    );

    const threadRow = threadResult.rows[0];
    if (!threadRow) {
      return null;
    }

    const messageResult = await this.query<MessageRow>(
      `
        SELECT
          message_id,
          thread_id,
          role,
          turn_index,
          content_raw,
          content_text,
          created_at,
          metadata_json
        FROM messages
        WHERE thread_id = $1
        ORDER BY turn_index ASC, created_at ASC
      `,
      [threadId]
    );

    const summaryResult = await this.query<SummaryRow>(
      `
        SELECT
          thread_id,
          summary_short,
          summary_long,
          tags_json,
          keywords_json,
          open_questions_json,
          last_summarized_at
        FROM thread_summaries
        WHERE thread_id = $1
      `,
      [threadId]
    );

    const summaryRow = summaryResult.rows[0];

    return {
      thread: toThreadRecord(threadRow),
      messages: messageResult.rows.map((row: MessageRow) => ({
        messageId: row.message_id,
        threadId: row.thread_id,
        role: row.role,
        turnIndex: row.turn_index,
        contentRaw: row.content_raw,
        contentText: row.content_text,
        createdAt: row.created_at,
        metadataJson: row.metadata_json
      })),
      summary: summaryRow
        ? {
            threadId: summaryRow.thread_id,
            summaryShort: summaryRow.summary_short ?? undefined,
            summaryLong: summaryRow.summary_long ?? undefined,
            tags: parseJsonStringArray(summaryRow.tags_json),
            keywords: parseJsonStringArray(summaryRow.keywords_json),
            openQuestions: parseJsonStringArray(summaryRow.open_questions_json),
            lastSummarizedAt: summaryRow.last_summarized_at ?? undefined
          }
        : undefined
    };
  }

  async listRecentThreads(limit: number): Promise<ArchiveThreadRecord[]> {
    const result = await this.query<ListRecentThreadRow>(
      `
        SELECT
          thread_id,
          conversation_url,
          title,
          source,
          model_last_seen,
          locale,
          created_at,
          updated_at,
          last_run_mode
        FROM threads
        ORDER BY updated_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(toThreadRecord);
  }

  async searchByThread(threadId: string, queryText: string, limit: number): Promise<ArchiveSearchResult[]> {
    const like = `%${queryText}%`;
    const result = await this.query<SearchRow>(
      `
        SELECT
          message_id,
          thread_id,
          turn_index,
          role,
          content_text,
          created_at,
          CASE
            WHEN content_text ILIKE $2 THEN 3
            WHEN EXISTS (
              SELECT 1
              FROM chunks
              WHERE chunks.message_id = messages.message_id
                AND chunks.chunk_text ILIKE $2
            ) THEN 2
            ELSE 1
          END AS rank
        FROM messages
        WHERE thread_id = $1
          AND (
            content_text ILIKE $2
            OR EXISTS (
              SELECT 1
              FROM chunks
              WHERE chunks.message_id = messages.message_id
                AND chunks.chunk_text ILIKE $2
            )
          )
        ORDER BY rank DESC, turn_index DESC, created_at DESC
        LIMIT $3
      `,
      [threadId, like, limit]
    );

    return result.rows.map((row: SearchRow) => ({
      messageId: row.message_id,
      threadId: row.thread_id,
      turnIndex: row.turn_index,
      role: row.role,
      contentText: row.content_text,
      createdAt: row.created_at,
      rank: Number(row.rank)
    }));
  }

  async recallThreads(queryText: string, limit: number): Promise<ArchiveThreadRecallCandidate[]> {
    const tokens = tokenizeRecallQuery(queryText);
    const patterns = [...new Set([`%${queryText}%`, ...tokens.map((token) => `%${token}%`)])];
    const result = await this.query<RecallRow>(
      `
        WITH patterns AS (
          SELECT UNNEST($1::text[]) AS pattern
        ),
        summary_hits AS (
          SELECT
            ts.thread_id,
            8 * COUNT(DISTINCT p.pattern)::int AS score,
            'summary'::text AS matched_by
          FROM thread_summaries ts
          CROSS JOIN patterns p
          WHERE
            (
              COALESCE(ts.summary_short, '') ILIKE p.pattern
              OR COALESCE(ts.summary_long, '') ILIKE p.pattern
              OR ts.tags_json::text ILIKE p.pattern
              OR ts.keywords_json::text ILIKE p.pattern
            )
          GROUP BY ts.thread_id
        ),
        message_hits AS (
          SELECT
            m.thread_id,
            5 * COUNT(DISTINCT p.pattern)::int AS score,
            'message'::text AS matched_by
          FROM messages m
          CROSS JOIN patterns p
          WHERE m.content_text ILIKE p.pattern
          GROUP BY m.thread_id
        ),
        chunk_hits AS (
          SELECT
            c.thread_id,
            3 * COUNT(DISTINCT p.pattern)::int AS score,
            'chunk'::text AS matched_by
          FROM chunks c
          CROSS JOIN patterns p
          WHERE c.chunk_text ILIKE p.pattern
          GROUP BY c.thread_id
        ),
        combined AS (
          SELECT * FROM summary_hits
          UNION ALL
          SELECT * FROM message_hits
          UNION ALL
          SELECT * FROM chunk_hits
        )
        SELECT
          combined.thread_id,
          SUM(combined.score)::int AS score,
          ARRAY_AGG(DISTINCT combined.matched_by) AS matched_by
        FROM combined
        GROUP BY combined.thread_id
        ORDER BY score DESC, combined.thread_id ASC
        LIMIT $2
      `,
      [patterns, limit]
    );

    return result.rows.map((row) => ({
      threadId: row.thread_id,
      score: Number(row.score),
      matchedBy: row.matched_by
    }));
  }

  async recallThreadsByVector(queryEmbedding: number[], limit: number): Promise<ArchiveThreadRecallCandidate[]> {
    if (!queryEmbedding.length || !this.pgvectorEnabled) {
      return [];
    }

    const result = await this.query<RecallRow>(
      `
        SELECT
          c.thread_id,
          GREATEST(1, ROUND((1 - MIN(c.embedding <=> $1::vector)) * 20))::int AS score,
          ARRAY['vector']::text[] AS matched_by
        FROM chunks c
        WHERE c.embedding IS NOT NULL
        GROUP BY c.thread_id
        ORDER BY MIN(c.embedding <=> $1::vector) ASC, c.thread_id ASC
        LIMIT $2
      `,
      [`[${queryEmbedding.join(",")}]`, limit]
    );

    return result.rows.map((row) => ({
      threadId: row.thread_id,
      score: Number(row.score),
      matchedBy: row.matched_by
    }));
  }

  async listChunksMissingEmbeddings(limit: number): Promise<ArchiveChunkBackfillRecord[]> {
    if (!this.pgvectorEnabled) {
      return [];
    }

    const result = await this.query<{
      chunk_id: string;
      thread_id: string;
      message_id: string;
      chunk_text: string;
    }>(
      `
        SELECT
          chunk_id,
          thread_id,
          message_id,
          chunk_text
        FROM chunks
        WHERE embedding IS NULL
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => ({
      chunkId: row.chunk_id,
      threadId: row.thread_id,
      messageId: row.message_id,
      chunkText: row.chunk_text
    }));
  }

  async countChunksMissingEmbeddings(): Promise<number> {
    if (!this.pgvectorEnabled) {
      return 0;
    }

    const result = await this.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM chunks
        WHERE embedding IS NULL
      `
    );

    return Number(result.rows[0]?.count ?? 0);
  }

  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error("archive store is disabled because POSTGRES_URL is not configured");
    }

    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async query<T extends QueryResultRow>(
    text: string,
    values: unknown[] = [],
    client?: PoolClient
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error("archive store is disabled because POSTGRES_URL is not configured");
    }

    await this.initialize();
    if (client) {
      return client.query<T>(text, values);
    }
    return this.pool.query<T>(text, values);
  }

  private async execute(text: string, values: unknown[] = [], client?: PoolClient): Promise<void> {
    await this.initialize();
    if (client) {
      await client.query(text, values);
      return;
    }
    if (!this.pool) {
      throw new Error("archive store is disabled because POSTGRES_URL is not configured");
    }
    await this.pool.query(text, values);
  }
}
