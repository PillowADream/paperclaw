import type {
  CriticAgentOutput,
  PaperAgentResult,
  RecallAgentOutput,
  ResearchTaskRecord,
  SurveyAgentOutput,
  WriterAgentOutput
} from "../paperLoopTypes.js";
import { ensureString, ensureStringArray, runGeminiJsonPrompt } from "./shared.js";

function buildCriticPrompt(
  task: ResearchTaskRecord,
  recall: RecallAgentOutput,
  survey: SurveyAgentOutput,
  draft: WriterAgentOutput
): string {
  return [
    "You are the critic in a paper-writing loop.",
    "Return strict JSON only.",
    "Required JSON keys: strengths, weaknesses, missingEvidence, nextRevisionTarget, revisedDraftMarkdown.",
    "strengths, weaknesses, and missingEvidence must be arrays of short strings.",
    "Do not use markdown fences around the JSON.",
    `Paper title: ${task.title}`,
    `Problem statement: ${task.problemStatement}`,
    `Section under review: ${task.targetSection}`,
    `Recalled context:\n${recall.researchContext}`,
    `Survey notes:\n${survey.surveyNotes}`,
    `Current draft:\n${draft.draftMarkdown}`,
    "Critique the draft, identify missing evidence, and produce a revised draft section."
  ].join("\n");
}

export async function runCriticAgent(
  task: ResearchTaskRecord,
  recall: RecallAgentOutput,
  survey: SurveyAgentOutput,
  draft: WriterAgentOutput
): Promise<PaperAgentResult<CriticAgentOutput>> {
  return runGeminiJsonPrompt(
    buildCriticPrompt(task, recall, survey, draft),
    ["strengths", "weaknesses", "missingEvidence", "nextRevisionTarget", "revisedDraftMarkdown"],
    (payload) => ({
      strengths: ensureStringArray(payload.strengths),
      weaknesses: ensureStringArray(payload.weaknesses),
      missingEvidence: ensureStringArray(payload.missingEvidence),
      nextRevisionTarget: ensureString(payload.nextRevisionTarget),
      revisedDraftMarkdown: ensureString(payload.revisedDraftMarkdown)
    })
  );
}
