import { cp, mkdir, rm, stat } from "node:fs/promises";
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

function isLikelyProfileConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /launchPersistentContext|Target page, context or browser has been closed|existing browser session/i.test(message);
}

function getProfileDirArgs(): string[] {
  return [`--profile-directory=${appEnv.browserProfileName}`];
}

function shouldPreferSnapshotLaunch(userDataDir: string): boolean {
  return /[\\/]Microsoft[\\/]Edge[\\/]User Data$/i.test(userDataDir);
}

async function launchPersistentContext(userDataDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    channel: appEnv.browserChannel || undefined,
    headless: appEnv.browserHeadless,
    slowMo: appEnv.browserSlowMoMs,
    viewport: { width: 1440, height: 1100 },
    args: getProfileDirArgs()
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function createProfileSnapshot(sourceUserDataDir: string, profileName: string): Promise<string> {
  const snapshotRoot = path.resolve("runtime", "browser-profile-snapshot");
  const sourceProfileDir = path.join(sourceUserDataDir, profileName);
  const targetProfileDir = path.join(snapshotRoot, profileName);
  const localStatePath = path.join(sourceUserDataDir, "Local State");

  if (!(await pathExists(sourceProfileDir))) {
    throw new Error(`configured Edge profile directory does not exist: ${sourceProfileDir}`);
  }

  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });

  if (await pathExists(localStatePath)) {
    await cp(localStatePath, path.join(snapshotRoot, "Local State"), { force: true });
  }

  await cp(sourceProfileDir, targetProfileDir, {
    recursive: true,
    force: true,
    filter: (entry) => {
      const baseName = path.basename(entry);
      return !/^(LOCK|Singleton.*)$/i.test(baseName);
    }
  });

  return snapshotRoot;
}

export async function createBrowserSession(): Promise<BrowserSession> {
  await mkdir(appEnv.browserProfileDir, { recursive: true });

  const browserUse = new BrowserUseBrowser();

  // The current TS Browser Use port exposes Playwright primitives but not
  // a user_data_dir API. We keep Browser Use as the browser layer dependency
  // boundary and use Playwright's persistent context here to preserve login state.
  let context: BrowserContext;
  const directUserDataDir = path.resolve(appEnv.browserProfileDir);
  if (shouldPreferSnapshotLaunch(directUserDataDir)) {
    console.warn("[browser] using a runtime snapshot of the configured system Edge profile to avoid live profile conflicts");
    const snapshotUserDataDir = await createProfileSnapshot(directUserDataDir, appEnv.browserProfileName);
    context = await launchPersistentContext(snapshotUserDataDir);
  } else {
    try {
      context = await launchPersistentContext(directUserDataDir);
    } catch (error) {
      if (!isLikelyProfileConflict(error)) {
        throw error;
      }

      console.warn("[browser] direct Edge profile launch failed; retrying with a runtime snapshot copy of the configured profile");
      const snapshotUserDataDir = await createProfileSnapshot(directUserDataDir, appEnv.browserProfileName);
      context = await launchPersistentContext(snapshotUserDataDir);
    }
  }

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
