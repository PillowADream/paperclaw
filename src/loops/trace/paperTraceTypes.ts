import type {
  LoopRunMetricRecord,
  LoopRunRecord,
  PaperLoopPhase,
  PaperRunTrace,
  ResearchTaskRecord
} from "../paperLoopTypes.js";

export interface PaperTraceOptions {
  iteration?: number;
  phase?: PaperLoopPhase;
}

export interface PaperTraceIterationDetail {
  phase: PaperLoopPhase;
  run?: LoopRunRecord;
  metrics?: LoopRunMetricRecord;
  startedAt?: string;
  endedAt: string;
  inputSummary: string;
  outputSummary: string;
  recallSummary?: {
    recalledThreadCount?: number;
    recalledChunkCount?: number;
    recalledExcerptCount?: number;
    selectedThreadId?: string;
    sourceSummary?: string;
  };
}

export interface PaperTraceOverview {
  totalIterations: number;
  phasesEncountered: PaperLoopPhase[];
  completed: boolean;
  finalStopReason?: string;
  hasFailures: boolean;
  hasRepairs: boolean;
  hasRepairFailures: boolean;
}

export interface PaperTraceReport {
  task: ResearchTaskRecord;
  trace: PaperRunTrace;
  overview: PaperTraceOverview;
  visibleIterations: Array<{
    iteration: number;
    phases: PaperTraceIterationDetail[];
  }>;
  finalStatus: {
    stopReason?: string;
    remainingIssues: string[];
    stopCheck?: {
      shouldStop: boolean;
      reason?: string;
    };
  };
}
