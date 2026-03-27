import { randomUUID } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";

import { appEnv } from "../config/env.js";
import type {
  LoopRunMetricRecord,
  LoopReflection,
  LoopRunRecord,
  PaperRunTrace,
  PaperLoopPhase,
  PhaseExecutionStatus,
  ReflectionRiskLevel,
  PaperLoopStateName,
  PaperRunStatus,
  ResearchTaskRecord,
  ResearchTaskStatus
} from "./paperLoopTypes.js";

interface ResearchTaskRow extends QueryResultRow {
  task_id: string;
  title: string;
  problem_statement: string;
  target_section: string;
  status: ResearchTaskStatus;
  current_phase: PaperLoopStateName;
  current_iteration: number;
  created_at: string;
  updated_at: string;
}

interface LoopRunRow extends QueryResultRow {
  run_id: string;
  task_id: string;
  iteration: number;
  phase: PaperLoopPhase;
  input_json: Record<string, unknown>;
  output_json: Record<string, unknown>;
  reflection_json: LoopReflection;
  selected_thread_id: string | null;
  created_at: string;
}

interface LoopRunMetricRow extends QueryResultRow {
  metric_id: string;
  loop_run_id: string | null;
  task_id: string;
  iteration: number;
  phase: PaperLoopPhase;
  phase_status: PhaseExecutionStatus;
  phase_latency_ms: number | null;
  json_repair_used: boolean | null;
  json_repair_succeeded: boolean | null;
  recalled_thread_count: number | null;
  recalled_chunk_count: number | null;
  recalled_excerpt_count: number | null;
  selected_thread_id: string | null;
  critic_issue_count: number | null;
  critic_missing_evidence_count: number | null;
  output_size_chars: number | null;
  reflection_risk_level: ReflectionRiskLevel | null;
  stop_reason: string | null;
  failure_reason: string | null;
  created_at: string;
}

function mapTask(row: ResearchTaskRow): ResearchTaskRecord {
  return {
    taskId: row.task_id,
    title: row.title,
    problemStatement: row.problem_statement,
    targetSection: row.target_section,
    status: row.status,
    currentPhase: row.current_phase,
    currentIteration: row.current_iteration,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row: LoopRunRow): LoopRunRecord {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    iteration: row.iteration,
    phase: row.phase,
    inputJson: row.input_json,
    outputJson: row.output_json,
    reflectionJson: row.reflection_json,
    selectedThreadId: row.selected_thread_id ?? undefined,
    createdAt: row.created_at
  };
}

function mapMetric(row: LoopRunMetricRow): LoopRunMetricRecord {
  return {
    metricId: row.metric_id,
    loopRunId: row.loop_run_id ?? undefined,
    taskId: row.task_id,
    iteration: row.iteration,
    phase: row.phase,
    phaseStatus: row.phase_status,
    phaseLatencyMs: row.phase_latency_ms ?? undefined,
    jsonRepairUsed: row.json_repair_used ?? undefined,
    jsonRepairSucceeded: row.json_repair_succeeded ?? undefined,
    recalledThreadCount: row.recalled_thread_count ?? undefined,
    recalledChunkCount: row.recalled_chunk_count ?? undefined,
    recalledExcerptCount: row.recalled_excerpt_count ?? undefined,
    selectedThreadId: row.selected_thread_id ?? undefined,
    criticIssueCount: row.critic_issue_count ?? undefined,
    criticMissingEvidenceCount: row.critic_missing_evidence_count ?? undefined,
    outputSizeChars: row.output_size_chars ?? undefined,
    reflectionRiskLevel: row.reflection_risk_level ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    createdAt: row.created_at
  };
}

export interface CreateResearchTaskInput {
  title: string;
  problemStatement: string;
  targetSection: string;
}

export interface CreateLoopRunInput {
  taskId: string;
  iteration: number;
  phase: PaperLoopPhase;
  inputJson: Record<string, unknown>;
  outputJson: Record<string, unknown>;
  reflectionJson: LoopReflection;
  selectedThreadId?: string;
}

export interface CreateLoopRunMetricInput {
  loopRunId?: string;
  taskId: string;
  iteration: number;
  phase: PaperLoopPhase;
  phaseStatus: PhaseExecutionStatus;
  phaseLatencyMs?: number;
  jsonRepairUsed?: boolean;
  jsonRepairSucceeded?: boolean;
  recalledThreadCount?: number;
  recalledChunkCount?: number;
  recalledExcerptCount?: number;
  selectedThreadId?: string;
  criticIssueCount?: number;
  criticMissingEvidenceCount?: number;
  outputSizeChars?: number;
  reflectionRiskLevel?: ReflectionRiskLevel;
  stopReason?: string;
  failureReason?: string;
}

export class LoopStore {
  private readonly pool: Pool | null;
  private initialized = false;

  constructor() {
    this.pool = appEnv.postgresUrl
      ? new Pool({
          connectionString: appEnv.postgresUrl,
          ssl: appEnv.postgresSsl ? { rejectUnauthorized: false } : undefined
        })
      : null;
  }

  async initialize(): Promise<void> {
    if (!this.pool) {
      throw new Error("paper loop store is disabled because POSTGRES_URL is not configured");
    }

    if (this.initialized) {
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS research_tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        problem_statement TEXT NOT NULL,
        target_section TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED')),
        current_phase TEXT NOT NULL,
        current_iteration INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES research_tasks(task_id) ON DELETE CASCADE,
        iteration INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('CONTEXT_RECALL', 'LITERATURE_SURVEY', 'DRAFT_SECTION', 'CRITIQUE_AND_REVISE')),
        input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        reflection_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        selected_thread_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_research_tasks_status_updated_at ON research_tasks(status, updated_at DESC);`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_loop_runs_task_iteration_created_at ON loop_runs(task_id, iteration, created_at ASC);`
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS loop_run_metrics (
        metric_id TEXT PRIMARY KEY,
        loop_run_id TEXT REFERENCES loop_runs(run_id) ON DELETE SET NULL,
        task_id TEXT NOT NULL REFERENCES research_tasks(task_id) ON DELETE CASCADE,
        iteration INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('CONTEXT_RECALL', 'LITERATURE_SURVEY', 'DRAFT_SECTION', 'CRITIQUE_AND_REVISE')),
        phase_status TEXT NOT NULL CHECK (phase_status IN ('SUCCEEDED', 'FAILED')),
        phase_latency_ms INTEGER,
        json_repair_used BOOLEAN,
        json_repair_succeeded BOOLEAN,
        recalled_thread_count INTEGER,
        recalled_chunk_count INTEGER,
        recalled_excerpt_count INTEGER,
        selected_thread_id TEXT,
        critic_issue_count INTEGER,
        critic_missing_evidence_count INTEGER,
        output_size_chars INTEGER,
        reflection_risk_level TEXT CHECK (reflection_risk_level IN ('low', 'medium', 'high', 'unknown')),
        stop_reason TEXT,
        failure_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_loop_run_metrics_task_phase_created_at ON loop_run_metrics(task_id, phase, created_at DESC);`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_loop_run_metrics_run_id ON loop_run_metrics(loop_run_id);`
    );

    this.initialized = true;
  }

  async createResearchTask(input: CreateResearchTaskInput): Promise<ResearchTaskRecord> {
    await this.initialize();
    const taskId = `task:${randomUUID()}`;
    const result = await this.pool!.query<ResearchTaskRow>(
      `
        INSERT INTO research_tasks (
          task_id,
          title,
          problem_statement,
          target_section,
          status,
          current_phase,
          current_iteration
        )
        VALUES ($1, $2, $3, $4, 'PENDING', 'IDEA', 0)
        RETURNING
          task_id,
          title,
          problem_statement,
          target_section,
          status,
          current_phase,
          current_iteration,
          created_at,
          updated_at
      `,
      [taskId, input.title, input.problemStatement, input.targetSection]
    );

    return mapTask(result.rows[0]!);
  }

  async getResearchTask(taskId: string): Promise<ResearchTaskRecord | null> {
    await this.initialize();
    const result = await this.pool!.query<ResearchTaskRow>(
      `
        SELECT
          task_id,
          title,
          problem_statement,
          target_section,
          status,
          current_phase,
          current_iteration,
          created_at,
          updated_at
        FROM research_tasks
        WHERE task_id = $1
      `,
      [taskId]
    );

    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  async listLoopRuns(taskId: string): Promise<LoopRunRecord[]> {
    await this.initialize();
    const result = await this.pool!.query<LoopRunRow>(
      `
        SELECT
          run_id,
          task_id,
          iteration,
          phase,
          input_json,
          output_json,
          reflection_json,
          selected_thread_id,
          created_at
        FROM loop_runs
        WHERE task_id = $1
        ORDER BY iteration ASC, created_at ASC
      `,
      [taskId]
    );

    return result.rows.map(mapRun);
  }

  async appendLoopRun(input: CreateLoopRunInput): Promise<LoopRunRecord> {
    await this.initialize();
    const runId = `run:${randomUUID()}`;
    const result = await this.pool!.query<LoopRunRow>(
      `
        INSERT INTO loop_runs (
          run_id,
          task_id,
          iteration,
          phase,
          input_json,
          output_json,
          reflection_json,
          selected_thread_id
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
        RETURNING
          run_id,
          task_id,
          iteration,
          phase,
          input_json,
          output_json,
          reflection_json,
          selected_thread_id,
          created_at
      `,
      [
        runId,
        input.taskId,
        input.iteration,
        input.phase,
        JSON.stringify(input.inputJson),
        JSON.stringify(input.outputJson),
        JSON.stringify(input.reflectionJson),
        input.selectedThreadId ?? null
      ]
    );

    return mapRun(result.rows[0]!);
  }

  async appendLoopRunMetric(input: CreateLoopRunMetricInput): Promise<LoopRunMetricRecord> {
    await this.initialize();
    const metricId = `metric:${randomUUID()}`;
    const result = await this.pool!.query<LoopRunMetricRow>(
      `
        INSERT INTO loop_run_metrics (
          metric_id,
          loop_run_id,
          task_id,
          iteration,
          phase,
          phase_status,
          phase_latency_ms,
          json_repair_used,
          json_repair_succeeded,
          recalled_thread_count,
          recalled_chunk_count,
          recalled_excerpt_count,
          selected_thread_id,
          critic_issue_count,
          critic_missing_evidence_count,
          output_size_chars,
          reflection_risk_level,
          stop_reason,
          failure_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING
          metric_id,
          loop_run_id,
          task_id,
          iteration,
          phase,
          phase_status,
          phase_latency_ms,
          json_repair_used,
          json_repair_succeeded,
          recalled_thread_count,
          recalled_chunk_count,
          recalled_excerpt_count,
          selected_thread_id,
          critic_issue_count,
          critic_missing_evidence_count,
          output_size_chars,
          reflection_risk_level,
          stop_reason,
          failure_reason,
          created_at
      `,
      [
        metricId,
        input.loopRunId ?? null,
        input.taskId,
        input.iteration,
        input.phase,
        input.phaseStatus,
        input.phaseLatencyMs ?? null,
        input.jsonRepairUsed ?? null,
        input.jsonRepairSucceeded ?? null,
        input.recalledThreadCount ?? null,
        input.recalledChunkCount ?? null,
        input.recalledExcerptCount ?? null,
        input.selectedThreadId ?? null,
        input.criticIssueCount ?? null,
        input.criticMissingEvidenceCount ?? null,
        input.outputSizeChars ?? null,
        input.reflectionRiskLevel ?? null,
        input.stopReason ?? null,
        input.failureReason ?? null
      ]
    );

    return mapMetric(result.rows[0]!);
  }

  async listLoopRunMetrics(taskId: string): Promise<LoopRunMetricRecord[]> {
    await this.initialize();
    const result = await this.pool!.query<LoopRunMetricRow>(
      `
        SELECT
          metric_id,
          loop_run_id,
          task_id,
          iteration,
          phase,
          phase_status,
          phase_latency_ms,
          json_repair_used,
          json_repair_succeeded,
          recalled_thread_count,
          recalled_chunk_count,
          recalled_excerpt_count,
          selected_thread_id,
          critic_issue_count,
          critic_missing_evidence_count,
          output_size_chars,
          reflection_risk_level,
          stop_reason,
          failure_reason,
          created_at
        FROM loop_run_metrics
        WHERE task_id = $1
        ORDER BY iteration ASC, created_at ASC
      `,
      [taskId]
    );

    return result.rows.map(mapMetric);
  }

  async updateLoopRunMetricStopReason(loopRunId: string, stopReason: string): Promise<void> {
    await this.initialize();
    await this.pool!.query(
      `
        UPDATE loop_run_metrics
        SET stop_reason = $2
        WHERE loop_run_id = $1
      `,
      [loopRunId, stopReason]
    );
  }

  async updateResearchTaskProgress(
    taskId: string,
    status: ResearchTaskStatus,
    currentPhase: PaperLoopStateName,
    currentIteration: number
  ): Promise<void> {
    await this.initialize();
    await this.pool!.query(
      `
        UPDATE research_tasks
        SET
          status = $2,
          current_phase = $3,
          current_iteration = $4,
          updated_at = NOW()
        WHERE task_id = $1
      `,
      [taskId, status, currentPhase, currentIteration]
    );
  }

  async getPaperRunStatus(taskId: string): Promise<PaperRunStatus | null> {
    const task = await this.getResearchTask(taskId);
    if (!task) {
      return null;
    }

    const runs = await this.listLoopRuns(taskId);
    return { task, runs };
  }

  async getPaperRunTrace(taskId: string): Promise<PaperRunTrace | null> {
    const task = await this.getResearchTask(taskId);
    if (!task) {
      return null;
    }

    const [runs, metrics] = await Promise.all([
      this.listLoopRuns(taskId),
      this.listLoopRunMetrics(taskId)
    ]);
    return { task, runs, metrics };
  }
}

let loopStoreSingleton: LoopStore | null = null;

export function getLoopStore(): LoopStore {
  loopStoreSingleton ??= new LoopStore();
  return loopStoreSingleton;
}
