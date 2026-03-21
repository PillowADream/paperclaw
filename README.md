# Gemini Web Agent MVP

This repository contains a minimal runnable Gemini web automation agent built with TypeScript, Node.js, LangChain, Browser Use, and Playwright. It now includes a PostgreSQL-based conversation archive so each Gemini thread can be stored, summarized, chunked, and queried later without replacing the real-browser workflow.

Current target:
- Controller model: DeepSeek
- Browser target: Gemini web
- Browser channel: Edge
- Archive store: one PostgreSQL database shared by all Gemini threads

Current scope:
- Open Gemini in a logged-in browser profile
- Resume or create a Gemini web conversation
- Submit one prompt
- Wait for the latest reply
- Extract the latest model reply
- Persist runtime session state to `runtime/session.json`
- Archive each successful user/assistant turn into PostgreSQL
- Maintain thread summaries and retrieval-ready text chunks

Out of scope for this MVP:
- Automatic login
- CAPTCHA handling
- File upload
- Multi-tab concurrency
- Replacing Gemini web with a direct Gemini API call
- Production vector search pipeline

## Structure

```text
project-root/
  package.json
  tsconfig.json
  .env.example
  README.md
  AGENTS.md
  browser-profile/
  runtime/
  src/
    index.ts
    config/
      env.ts
    agent/
      planner.ts
      tools.ts
    archive/
      archiveTypes.ts
      archiveStore.ts
      archiveChunker.ts
      archiveSummarizer.ts
      archiveService.ts
    browser/
      geminiTool.ts
      geminiSessionState.ts
      session.ts
    types/
      result.ts
```

## Install

```bash
npm install
```

If Playwright browsers are missing:

```bash
npx playwright install chromium
```

## Environment

Copy `.env.example` to `.env` and fill at least:

```env
LLM_API_KEY=your_deepseek_api_key
LLM_MODEL=deepseek-chat
LLM_BASE_URL=https://api.deepseek.com/v1

POSTGRES_URL=postgres://user:password@host:5432/database
POSTGRES_SSL=true
ARCHIVE_ENABLE_SUMMARY=true
ARCHIVE_ENABLE_EMBEDDINGS=false
EMBEDDING_API_KEY=your_embedding_api_key
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_DIMENSIONS=1536
ARCHIVE_EMBEDDING_TIMEOUT_MS=20000
ARCHIVE_ENABLE_ROUTING=true
ARCHIVE_ROUTER_CANDIDATE_LIMIT=8
ARCHIVE_ROUTER_RECALL_LIMIT=12
ARCHIVE_ROUTER_ENABLE_RERANK=true
ARCHIVE_ROUTER_RERANK_LIMIT=4
ARCHIVE_ROUTER_RERANK_TIMEOUT_MS=12000
ARCHIVE_CHUNK_SIZE=1200
ARCHIVE_CHUNK_OVERLAP=200
ARCHIVE_SUMMARY_EVERY_TURNS=1
ARCHIVE_SUMMARY_TIMEOUT_MS=15000

GEMINI_WEB_URL=https://gemini.google.com/app
BROWSER_PROFILE_DIR=./browser-profile
BROWSER_PROFILE_NAME=Default
BROWSER_CHANNEL=msedge
BROWSER_HEADLESS=false
BROWSER_KEEP_OPEN_ON_ERROR=false
GEMINI_USE_DIRECT_TOOL=false
GEMINI_TARGET_MODEL=pro
```

Notes:
- `LLM_API_KEY` is used by LangChain controller calls and by the archive summarizer.
- `POSTGRES_URL` enables the archive layer. If it is missing, Gemini automation still works and archive operations are skipped.
- `POSTGRES_SSL=true` is the usual setting for managed PostgreSQL such as Alibaba Cloud.
- `ARCHIVE_ENABLE_SUMMARY=false` disables LLM summary generation while keeping thread/message/chunk archiving.
- `ARCHIVE_ENABLE_EMBEDDINGS=true` attempts pgvector initialization. If unsupported, the system logs a downgrade and keeps text archive/search working.
- `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, and `EMBEDDING_BASE_URL` configure the embedding provider used for pgvector writes and vector recall.
- If embedding env vars are omitted, the code falls back to the controller `LLM_API_KEY` and `LLM_BASE_URL`, but that only works when the provider also supports embeddings.
- `EMBEDDING_DIMENSIONS` must match the vector size expected by the embedding model and pgvector column.
- `ARCHIVE_EMBEDDING_TIMEOUT_MS` bounds chunk and query embedding calls.
- `ARCHIVE_ENABLE_ROUTING=true` enables archive-backed thread selection before the browser opens Gemini.
- `ARCHIVE_ROUTER_CANDIDATE_LIMIT` controls how many recent archived threads are inspected during routing.
- `ARCHIVE_ROUTER_RECALL_LIMIT` controls how many cross-thread recall hits are loaded before reranking.
- `ARCHIVE_ROUTER_ENABLE_RERANK=true` enables an LLM judge over the top recalled candidates.
- `ARCHIVE_ROUTER_RERANK_LIMIT` controls how many recalled threads are sent to the LLM reranker.
- `ARCHIVE_ROUTER_RERANK_TIMEOUT_MS` bounds the reranker call so routing can still fall back quickly.
- `BROWSER_PROFILE_DIR` should point to the Edge user-data root directory if you want to reuse an existing logged-in Edge profile.
- `BROWSER_PROFILE_NAME` should point to the exact logged-in profile, such as `Default` or `Profile 1`.
- Close other Edge windows using the same profile before running, otherwise the profile can be locked.

## Edge Profile

If Gemini is already logged in inside your Edge profile, reuse it directly.

Example:

```env
BROWSER_PROFILE_DIR=C:/Users/Lenovo/AppData/Local/Microsoft/Edge/User Data
BROWSER_PROFILE_NAME=Default
BROWSER_CHANNEL=msedge
```

## Run

Normal Gemini run:

```bash
npm run gemini -- "What do you think about GPT?"
```

Force a new Gemini conversation:

```bash
npm run gemini -- --new-chat "Start a fresh conversation and reply with OK"
```

Keep the existing thread but force target-model verification on resume:

```bash
npm run gemini -- --force-model "Reply from the resumed conversation using the target model"
```

Bypass the LangChain planner and call the browser tool directly:

```env
GEMINI_USE_DIRECT_TOOL=true
```

## Conversation Archive

Every successful Gemini exchange archives one logical turn:

1. Browser automation submits the user prompt and extracts the latest Gemini reply.
2. Session state is persisted to `runtime/session.json`.
3. The archive layer derives a stable `thread_id` from the Gemini conversation URL.
4. The `threads` row is upserted.
5. The current `user` and `assistant` messages are inserted into `messages`.
6. Long messages are chunked and written into `chunks`.
7. If enabled, the summarizer updates `thread_summaries`.

Before a normal non-`--new-chat` run opens Gemini, the router can search archived summaries, messages, and chunks across the database and choose the most relevant existing Gemini conversation based on `summary_short`, `summary_long`, `tags`, `keywords`, and recent message overlap. It first recalls candidates across the archive, then can optionally ask the controller LLM to rerank the top candidates. If recall finds nothing useful, the workflow falls back to recent threads and then to the saved session URL.

Archive failures are non-fatal to the Gemini main flow. The user still gets the Gemini reply, and diagnostics log whether archive, summary, chunks, and pgvector succeeded or degraded.

### Thread ID Rule

- Preferred: extract the stable Gemini conversation identifier from `/app/<conversation-id>`.
- Fallback: hash the normalized `conversation_url`.
- Result: the same Gemini web thread maps to the same `thread_id` across runs, while a new conversation produces a new `thread_id`.

## Database Schema

The archive layer initializes schema automatically on first use. Initialization is idempotent.

### `threads`

- `thread_id` primary key
- `conversation_url`
- `title`
- `source`
- `model_last_seen`
- `locale`
- `created_at`
- `updated_at`
- `last_run_mode`

### `messages`

- `message_id` primary key
- `thread_id` foreign key
- `role`
- `turn_index`
- `content_raw`
- `content_text`
- `created_at`
- `metadata_json`
- unique constraint on `thread_id + turn_index + role`

### `thread_summaries`

- `thread_id` primary key / foreign key
- `summary_short`
- `summary_long`
- `tags_json`
- `keywords_json`
- `open_questions_json`
- `last_summarized_at`

### `chunks`

- `chunk_id` primary key
- `thread_id` foreign key
- `message_id` foreign key
- `turn_index`
- `role`
- `chunk_order`
- `chunk_text`
- `created_at`
- unique constraint on `message_id + chunk_order`

Indexes:
- `threads(updated_at DESC)`
- `messages(thread_id, created_at DESC)`
- `messages(created_at DESC)`
- `chunks(thread_id, created_at DESC)`
- `chunks(message_id)`

## Summary And Chunk Strategy

Summary generation:
- Uses the existing DeepSeek/LangChain stack through `@langchain/openai`.
- Runs after base message archive succeeds.
- Has a timeout via `ARCHIVE_SUMMARY_TIMEOUT_MS`.
- Failure is downgraded and does not block the main Gemini workflow.

Chunk generation:
- Uses a simple text splitter with configurable `ARCHIVE_CHUNK_SIZE` and `ARCHIVE_CHUNK_OVERLAP`.
- Prioritizes assistant replies and only chunks longer user messages when useful.
- Stores plain text chunks first so later RAG or hybrid retrieval can be added without changing the base archive model.

Embeddings and pgvector:
- When `ARCHIVE_ENABLE_EMBEDDINGS=true` and pgvector is available, each stored chunk is followed by a best-effort embedding update.
- Embedding failure does not block message archive.
- Cross-thread routing can combine text recall with vector recall when embeddings exist.

## Archive Queries

List recent threads:

```bash
npm run archive:list -- --limit 10
```

Show one full thread with messages and summary:

```bash
npm run archive:thread -- gemini:your-thread-id
```

Search within one archived thread:

```bash
npm run archive:search -- --thread gemini:your-thread-id "模型切换"
```

These commands print JSON to stdout.

Backfill embeddings for historical chunks that were archived before pgvector was enabled:

```bash
npm run archive:reembed -- --limit 50
```

This scans up to `limit` chunks with `embedding IS NULL`, generates embeddings, writes them into pgvector, and returns how many remain.

## Thread Routing

The agent can now use archived summaries to continue the most relevant Gemini thread automatically.

Routing behavior:
- Runs before opening Gemini for normal prompt execution
- Skips routing when `--new-chat` is used
- Recalls candidates across archived summaries, messages, and chunks
- Scores candidate threads using summary and keyword overlap with the new prompt
- Optionally reranks the best candidates with the existing DeepSeek controller model
- Opens the selected `conversation_url` when a candidate exceeds the routing threshold
- Falls back to the last saved session when no strong match is found

This is not a LangChain memory system. The archive remains the primary source of long-term thread selection.

## PGVector

`ARCHIVE_ENABLE_EMBEDDINGS=true` enables an optional pgvector initialization and embedding pipeline.

Behavior:
- The archive store tries `CREATE EXTENSION IF NOT EXISTS vector`.
- If pgvector is available, `chunks.embedding` is added as `vector(EMBEDDING_DIMENSIONS)`.
- The store attempts to create an `ivfflat` cosine index for chunk embeddings.
- The archive service writes embeddings for chunk rows after base chunk persistence succeeds.
- The router can use vector recall in addition to summary/message/chunk text recall.
- If pgvector is unavailable or permissions are insufficient, the system logs a degraded mode and continues with standard PostgreSQL text archive/search.

This keeps the MVP stable while leaving room for future vector indexing.

## Session State

`runtime/session.json` is used for recovery and diagnostics:

```json
{
  "lastConversationUrl": "https://gemini.google.com/app/...",
  "lastKnownModel": "Gemini 2.5 Pro",
  "lastSuccessAt": "2026-03-20T10:00:00.000Z",
  "lastRunMode": "resume",
  "lastReplyExcerpt": "Short excerpt of the last successful reply...",
  "uiLocale": "zh-CN",
  "lastFailureStage": "wait-response-complete",
  "lastFailureReason": "Gemini response did not stabilize before timeout.",
  "updatedAt": "2026-03-20T10:00:00.000Z"
}
```

## Layering

- `src/agent/planner.ts`
  - LangChain high-level orchestration only
- `src/agent/tools.ts`
  - Exposes one coarse-grained Gemini web tool
- `src/browser/session.ts`
  - Browser startup and persistent profile reuse
- `src/browser/geminiTool.ts`
  - Gemini web workflow and non-fatal archive hook
- `src/archive/archiveStore.ts`
  - PostgreSQL schema initialization and CRUD
- `src/archive/archiveService.ts`
  - Archive orchestration, thread-id derivation, chunking, and retrieval APIs

Browser Use remains the browser-layer dependency boundary. Playwright persistent context is used in the session wrapper because the current `browser-use-typescript` package does not cleanly expose persistent `user_data_dir` support through its public TS API.

## Verified

Local checks completed:

```bash
npm run typecheck
npm run build
```

## Known Limits

1. Missing `LLM_API_KEY`
2. Missing `POSTGRES_URL` if archive is expected
3. Browser profile not logged into Gemini
4. Wrong `BROWSER_PROFILE_NAME`
5. Browser profile locked by another Edge window
6. Gemini page structure changes and selectors need an update
7. pgvector extension creation can fail on managed databases without extra permissions
8. This MVP only provides text-based thread search; vector retrieval is reserved for later enhancement
