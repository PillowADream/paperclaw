import type {
  CriticAgentOutput,
  PaperAgentResult,
  RecallAgentOutput,
  ResearchTaskRecord,
  SurveyAgentOutput,
  WriterAgentOutput
} from "../paperLoopTypes.js";
import { ensureString, ensureStringArray, runGeminiJsonPrompt } from "./shared.js";

function buildWriterPrompt(
  task: ResearchTaskRecord,
  recall: RecallAgentOutput,
  survey: SurveyAgentOutput,
  priorCritique?: CriticAgentOutput
): string {
  return [
    "You are drafting one section of a research paper.",
    "Return strict JSON only.",
    "Required JSON keys: sectionTitle, outline, draftMarkdown, claimsNeedingEvidence.",
    "outline and claimsNeedingEvidence must be arrays of short strings.",
    "Do not use markdown fences around the JSON.",
    `Paper title: ${task.title}`,
    `Problem statement: ${task.problemStatement}`,
    `Section to draft: ${task.targetSection}`,
    `Recalled context:\n${recall.researchContext}`,
    `Survey notes:\n${survey.surveyNotes}`,
    `Methods: ${survey.methods.join("; ") || "none"}`,
    `Gaps: ${survey.gaps.join("; ") || "none"}`,
    `Candidate references: ${survey.candidateReferences.join("; ") || "none"}`,
    priorCritique
      ? `Latest critique guidance: ${priorCritique.nextRevisionTarget}\nMissing evidence: ${priorCritique.missingEvidence.join("; ")}`
      : "Latest critique guidance: none",
    "Write a compact but concrete draft section suitable for iterative revision."
  ].join("\n");
}

export async function runWriterAgent(
  task: ResearchTaskRecord,
  recall: RecallAgentOutput,
  survey: SurveyAgentOutput,
  priorCritique?: CriticAgentOutput
): Promise<PaperAgentResult<WriterAgentOutput>> {
  return runGeminiJsonPrompt(
    buildWriterPrompt(task, recall, survey, priorCritique),
    ["sectionTitle", "outline", "draftMarkdown", "claimsNeedingEvidence"],
    (payload) => ({
      sectionTitle: ensureString(payload.sectionTitle, task.targetSection),
      outline: ensureStringArray(payload.outline),
      draftMarkdown: ensureString(payload.draftMarkdown),
      claimsNeedingEvidence: ensureStringArray(payload.claimsNeedingEvidence)
    })
  );
}
