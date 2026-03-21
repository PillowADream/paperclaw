import { tool } from "langchain";
import { z } from "zod";

import { runGeminiWebTask } from "../browser/geminiTool.js";

const geminiPromptSchema = z.object({
  prompt: z.string().min(1, "prompt is required")
});

export const geminiWebTool = tool(
  async ({ prompt }) => runGeminiWebTask(prompt, { forceNewChat: false }),
  {
    name: "gemini_web_prompt",
    description:
      "Open the Gemini web app, submit a prompt in an already logged-in browser profile, wait for the latest answer, and return that answer.",
    schema: geminiPromptSchema
  }
);

export const agentTools = [geminiWebTool];
