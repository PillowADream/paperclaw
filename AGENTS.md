# Repository Constraints

1. Stay on TypeScript and Node.js. Do not switch to Python.
2. Keep the controller model separate from browser execution.
3. Use LangChain for high-level orchestration only.
4. Use Browser Use and browser automation for page interaction details.
5. Keep the MVP minimal: open Gemini web, send prompt, wait, extract latest reply.
6. Do not replace the browser workflow with a direct Gemini API call.
7. Reuse a persistent Edge browser profile. Do not hardcode accounts, passwords, tokens, or cookies.
8. Expose configuration through `.env` and `.env.example`.
9. After code changes, run at least typecheck or build as a minimum validation step.
10. Avoid unrelated refactors and avoid overengineering.
