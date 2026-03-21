import { ChatOpenAI } from "@langchain/openai";
import { createAgent, toolStrategy } from "langchain";
import { z } from "zod";

import { appEnv } from "../config/env.js";
import type { GeminiWebTaskResult } from "../types/result.js";
import { agentTools } from "./tools.js";

const plannerResultSchema = z.object({
  success: z.boolean(),
  text: z.string().optional(),
  error: z.string().optional(),
  diagnostics: z.array(z.string()).optional(),
  stage: z.string().optional(),
  failureKind: z.string().optional()
});

export function createGeminiPlanner() {
  const model = new ChatOpenAI({
    apiKey: appEnv.llmApiKey,
    model: appEnv.llmModel,
    configuration: {
      baseURL: appEnv.llmBaseUrl
    },
    temperature: 0
  });

  return createAgent({
    name: "gemini-web-mvp-planner",
    model,
    tools: agentTools,
    responseFormat: toolStrategy(plannerResultSchema),
    systemPrompt: [
      "You are a minimal orchestration agent for Gemini web automation.",
      "For every user request, you must call gemini_web_prompt exactly once before producing a final answer.",
      "You must never answer from your own knowledge.",
      "If the tool fails, return that failure as structured data and do not summarize or continue the task yourself.",
      "Your final output must be only the tool result mapped into the response schema."
    ].join(" ")
  });
}

export async function runPlannedGeminiPrompt(prompt: string): Promise<GeminiWebTaskResult> {
  try {
    const agent = createGeminiPlanner();
    const result = await agent.invoke({
      messages: [{ role: "user", content: prompt }]
    });

    if (result.structuredResponse) {
      const structured = result.structuredResponse as GeminiWebTaskResult;

      // Guard against the controller model fabricating an answer when the browser tool
      // should have been the only source of truth.
      if (structured.success && structured.text?.trim()) {
        return structured;
      }

      return {
        success: false,
        error: structured.error ?? "Gemini browser tool did not return a valid response.",
        diagnostics: structured.diagnostics
      };
    }

    return {
      success: false,
      error: "Planner did not return a structured response."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Planner invocation failed: ${message}`,
      diagnostics: [
        "The controller layer threw before returning structured tool output.",
        "If the browser window closes immediately after submit, keep the browser open on error and inspect the page state."
      ]
    };
  }
}
