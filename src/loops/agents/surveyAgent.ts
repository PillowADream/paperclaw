import type { PaperAgentResult, RecallAgentOutput, ResearchTaskRecord, SurveyAgentOutput } from "../paperLoopTypes.js";
import { ensureString, ensureStringArray, runGeminiJsonPrompt } from "./shared.js";

function buildSurveyPrompt(task: ResearchTaskRecord, recall: RecallAgentOutput): string {
  return [
    "You are helping with a paper-writing workflow.",
    "Return strict JSON only.",
    "Required JSON keys: surveyNotes, methods, gaps, candidateReferences, openQuestions.",
    "Each list field must be an array of short strings.",
    "Do not use markdown fences.",
    `Paper title: ${task.title}`,
    `Problem statement: ${task.problemStatement}`,
    `Target section: ${task.targetSection}`,
    "Archived context recalled from prior Gemini threads:",
    recall.researchContext,
    "Produce a concise literature survey oriented toward writing the paper section."
  ].join("\n");
}

export async function runSurveyAgent(
  task: ResearchTaskRecord,
  recall: RecallAgentOutput
): Promise<PaperAgentResult<SurveyAgentOutput>> {
  return runGeminiJsonPrompt(
    buildSurveyPrompt(task, recall),
    ["surveyNotes", "methods", "gaps", "candidateReferences", "openQuestions"],
    (payload) => {
      const methods = ensureStringArray(payload.methods);
      const gaps = ensureStringArray(payload.gaps);
      const openQuestions = ensureStringArray(payload.openQuestions);

      return {
        surveyNotes:
          ensureString(payload.surveyNotes) ||
          [
            methods.length > 0 ? `Methods: ${methods.join("; ")}` : "",
            gaps.length > 0 ? `Gaps: ${gaps.join("; ")}` : "",
            openQuestions.length > 0 ? `Open questions: ${openQuestions.join("; ")}` : ""
          ]
            .filter(Boolean)
            .join(" "),
        methods,
        gaps,
        candidateReferences: ensureStringArray(payload.candidateReferences),
        openQuestions
      };
    }
  );
}
