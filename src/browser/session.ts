import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Browser as BrowserUseBrowser } from "browser-use-typescript/dist/browser-use-typescript/browser/playwrightBrowser/browserService.js";
import { chromium, type BrowserContext, type Page } from "playwright";

import { appEnv } from "../config/env.js";

export interface BrowserSession {
  browserUse: BrowserUseBrowser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export async function createBrowserSession(): Promise<BrowserSession> {
  await mkdir(appEnv.browserProfileDir, { recursive: true });

  const browserUse = new BrowserUseBrowser();

  // The current TS Browser Use port exposes Playwright primitives but not
  // a user_data_dir API. We keep Browser Use as the browser layer dependency
  // boundary and use Playwright's persistent context here to preserve login state.
  const context = await chromium.launchPersistentContext(
    path.resolve(appEnv.browserProfileDir),
    {
      channel: appEnv.browserChannel || undefined,
      headless: appEnv.browserHeadless,
      slowMo: appEnv.browserSlowMoMs,
      viewport: { width: 1440, height: 1100 },
      args: [`--profile-directory=${appEnv.browserProfileName}`]
    }
  );

  const existingPage = context.pages().at(-1);
  const page = existingPage ?? (await context.newPage());

  return {
    browserUse,
    context,
    page,
    close: async () => {
      try {
        await context.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[browser] close ignored: ${message}`);
      }
    }
  };
}
