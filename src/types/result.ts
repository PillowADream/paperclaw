export type GeminiRunStage =
  | "bootstrap"
  | "open-target-page"
  | "restore-or-create-chat"
  | "ensure-target-model"
  | "ensure-input-ready"
  | "submit-prompt"
  | "wait-response-start"
  | "wait-response-complete"
  | "extract-latest-reply"
  | "persist-session-state";

export type GeminiFailureKind =
  | "navigation"
  | "locator"
  | "page-state"
  | "timeout"
  | "model-switch"
  | "extraction"
  | "unknown";

export type GeminiRunMode = "resume" | "new-chat";

export interface GeminiWebTaskResult {
  success: boolean;
  text?: string;
  error?: string;
  diagnostics?: string[];
  stage?: GeminiRunStage;
  failureKind?: GeminiFailureKind;
}
