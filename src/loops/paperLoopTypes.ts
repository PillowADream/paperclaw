export type PaperLoopPhase =
  | "CONTEXT_RECALL"
  | "LITERATURE_SURVEY"
  | "DRAFT_SECTION"
  | "CRITIQUE_AND_REVISE";

export type PaperLoopStateName =
  | "IDEA"
  | "CONTEXT_RECALL"
  | "LITERATURE_SURVEY"
  | "DRAFT_SECTION"
  | "CRITIQUE_AND_REVISE"
  | "STOP_CHECK"
  | "DONE";

export type ResearchTaskStatus = "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED" | "FAILED";

export type PhaseExecutionStatus = "SUCCEEDED" | "FAILED";

export type ReflectionRiskLevel = "low" | "medium" | "high" | "unknown";

export interface LoopReflection {
  what_went_well: string[];
  what_is_missing: string[];
  risk: string[];
  next_step: string;
}

export interface ResearchTaskRecord {
  taskId: string;
  title: string;
  problemStatement: string;
  targetSection: string;
  status: ResearchTaskStatus;
  currentPhase: PaperLoopStateName;
  currentIteration: number;
  createdAt: string;
  updatedAt: string;
}

export interface LoopRunRecord {
  runId: string;
  taskId: string;
  iteration: number;
  phase: PaperLoopPhase;
  inputJson: Record<string, unknown>;
  outputJson: Record<string, unknown>;
  reflectionJson: LoopReflection;
  selectedThreadId?: string;
  createdAt: string;
}

export interface JsonPromptExecutionMeta {
  jsonRepairUsed: boolean;
  jsonRepairSucceeded: boolean;
  rawResponseChars: number;
  repairedResponseChars?: number;
}

export interface PaperAgentResult<T> {
  output: T;
  meta: JsonPromptExecutionMeta;
}

export interface LoopRunMetricRecord {
  metricId: string;
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
  createdAt: string;
}

export interface RecallThreadContext {
  threadId: string;
  score: number;
  matchedBy: string[];
  title?: string;
  summaryShort?: string;
  summaryLong?: string;
  recentExcerpts: string[];
}

export interface RecallAgentOutput {
  topic: string;
  selectedThreadId?: string;
  recalledThreads: RecallThreadContext[];
  researchContext: string;
  openQuestions: string[];
}

export interface SurveyAgentOutput {
  surveyNotes: string;
  methods: string[];
  gaps: string[];
  candidateReferences: string[];
  openQuestions: string[];
}

export interface WriterAgentOutput {
  sectionTitle: string;
  outline: string[];
  draftMarkdown: string;
  claimsNeedingEvidence: string[];
}

export interface CriticAgentOutput {
  strengths: string[];
  weaknesses: string[];
  missingEvidence: string[];
  nextRevisionTarget: string;
  revisedDraftMarkdown: string;
}

export interface PaperLoopIterationContext {
  recall?: RecallAgentOutput;
  survey?: SurveyAgentOutput;
  draft?: WriterAgentOutput;
  critique?: CriticAgentOutput;
}

export interface PaperRunStatus {
  task: ResearchTaskRecord;
  runs: LoopRunRecord[];
}

export interface PaperRunTrace {
  task: ResearchTaskRecord;
  runs: LoopRunRecord[];
  metrics: LoopRunMetricRecord[];
}
