import type { Locator, Page } from "playwright";

import { appEnv } from "../config/env.js";
import { getArchiveService } from "../archive/archiveService.js";
import { getArchiveThreadRouter } from "../archive/threadRouter.js";
import type {
  GeminiFailureKind,
  GeminiRunMode,
  GeminiRunStage,
  GeminiWebTaskResult
} from "../types/result.js";
import {
  isGeminiConversationUrl,
  loadGeminiSessionState,
  saveGeminiSessionState,
  type GeminiSessionState
} from "./geminiSessionState.js";
import { createBrowserSession } from "./session.js";

export interface RunGeminiWebTaskOptions {
  forceNewChat?: boolean;
  forceModelOnResume?: boolean;
}

interface StageContext {
  page: Page;
  diagnostics: string[];
  currentStage: GeminiRunStage;
  sessionState: GeminiSessionState;
  runMode: GeminiRunMode;
  currentPrompt: string;
  uiLocale?: string;
  currentModelLabel?: string;
  resumeAttempted?: boolean;
  routedThreadId?: string;
  routedConversationUrl?: string;
}

interface LocatorStrategy {
  name: string;
  priority: number;
  maxCandidates?: number;
  locate: (page: Page) => Locator;
}

interface RankedLocator {
  locator: Locator;
  strategy: string;
  score: number;
}

interface ResponseNode {
  signature: string;
  text: string;
  top: number;
  left: number;
}

interface ConversationSnapshot {
  responseCount: number;
  lastResponseSignature?: string;
  lastResponseText?: string;
}

interface ResponseProgress {
  latestResponse: ResponseNode | null;
  generationActive: boolean;
  loadingActive: boolean;
  sendReady: boolean;
}

const INPUT_STRATEGIES: LocatorStrategy[] = [
  { name: "semantic-contenteditable", priority: 400, maxCandidates: 4, locate: (page) => page.locator("div[contenteditable='true'][role='textbox'][aria-label]") },
  { name: "composer-contenteditable", priority: 360, maxCandidates: 4, locate: (page) => page.locator("rich-textarea [contenteditable='true'], main [contenteditable='true'][role='textbox']") },
  { name: "semantic-textarea", priority: 320, maxCandidates: 3, locate: (page) => page.locator("textarea[aria-label], textarea[placeholder]") },
  { name: "role-textbox", priority: 280, maxCandidates: 4, locate: (page) => page.getByRole("textbox", { name: /message|prompt|gemini|ask|chat|输入|消息|提问/i }) },
  { name: "fallback-textbox", priority: 220, maxCandidates: 4, locate: (page) => page.locator("textarea, [role='textbox'][contenteditable='true']") }
];

const SEND_BUTTON_STRATEGIES: LocatorStrategy[] = [
  { name: "semantic-send-button", priority: 400, maxCandidates: 3, locate: (page) => page.locator("button[aria-label*='send' i], button[aria-label*='submit' i]") },
  { name: "semantic-data-send", priority: 360, maxCandidates: 3, locate: (page) => page.locator("button[data-test-id*='send' i], button[data-testid*='send' i]") },
  { name: "role-send-button", priority: 320, maxCandidates: 4, locate: (page) => page.getByRole("button", { name: /send|submit|发送|提交/i }) },
  { name: "generic-send-button", priority: 220, maxCandidates: 4, locate: (page) => page.locator("main button") }
];

const GENERATION_INDICATOR_STRATEGIES: LocatorStrategy[] = [
  { name: "stop-button", priority: 400, maxCandidates: 3, locate: (page) => page.locator("button[aria-label*='stop' i], button[aria-label*='stop generating' i], button[aria-label*='stop response' i]") },
  { name: "role-stop-button", priority: 320, maxCandidates: 4, locate: (page) => page.getByRole("button", { name: /stop|停止|结束/i }) }
];

const LOADING_INDICATOR_STRATEGIES: LocatorStrategy[] = [
  { name: "aria-busy", priority: 400, maxCandidates: 6, locate: (page) => page.locator("[aria-busy='true']") },
  { name: "progressbar", priority: 320, maxCandidates: 6, locate: (page) => page.locator("[role='progressbar'], mat-progress-bar, .loading, .spinner") }
];

const RESPONSE_NODE_SELECTORS = [
  "model-response",
  "[data-response-role='model']",
  "[data-turn-role='model']",
  "[data-message-author='model']",
  "message-content",
  ".model-response-text",
  "div.markdown"
] as const;

const POLL_INTERVAL_MS = 800;
const RESPONSE_TEXT_MAX_EXCERPT = 180;

function log(message: string): void {
  if (appEnv.logLevel === "debug" || appEnv.logLevel === "info") {
    console.log(`[gemini] ${message}`);
  }
}

function addDiagnostic(ctx: StageContext, message: string): void {
  ctx.diagnostics.push(message);
  log(`${ctx.currentStage}: ${message}`);
}

class GeminiAutomationError extends Error {
  constructor(
    public readonly stage: GeminiRunStage,
    public readonly kind: GeminiFailureKind,
    message: string
  ) {
    super(message);
    this.name = "GeminiAutomationError";
  }
}

function toAutomationError(error: unknown, stage: GeminiRunStage): GeminiAutomationError {
  if (error instanceof GeminiAutomationError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GeminiAutomationError(stage, "unknown", message);
}

async function runStage<T>(ctx: StageContext, stage: GeminiRunStage, action: () => Promise<T>): Promise<T> {
  ctx.currentStage = stage;
  log(`stage=${stage} begin`);
  try {
    const result = await action();
    log(`stage=${stage} success`);
    return result;
  } catch (error) {
    throw toAutomationError(error, stage);
  }
}

function normalizeText(text: string | null | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}

function excerpt(text: string, maxLength = RESPONSE_TEXT_MAX_EXCERPT): string {
  const normalized = normalizeText(text);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getModelPatterns(targetModel: string): RegExp[] {
  const normalized = targetModel.trim().toLowerCase();
  if (normalized === "pro") return [/\bpro\b/i, /gemini\s*\d+(?:\.\d+)?\s*pro/i, /专业/i];
  if (normalized === "flash") return [/\bflash\b/i, /快速/i];
  if (normalized === "thinking") return [/\bthinking\b/i, /思考/i];
  return [new RegExp(escapeRegExp(targetModel), "i")];
}

function matchesModelLabel(label: string | undefined, targetModel: string): boolean {
  return Boolean(label) && getModelPatterns(targetModel).some((pattern) => pattern.test(label as string));
}

async function isLocatorEnabled(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    const ariaDisabled = htmlElement.getAttribute("aria-disabled");
    return !("disabled" in htmlElement && Boolean((htmlElement as HTMLButtonElement).disabled)) && ariaDisabled !== "true";
  });
}

async function isInputEditable(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    const ariaDisabled = htmlElement.getAttribute("aria-disabled");
    const isReadOnly = "readOnly" in htmlElement && Boolean((htmlElement as HTMLTextAreaElement).readOnly);
    return ariaDisabled !== "true" && !isReadOnly;
  });
}

async function rankLocator(
  locator: Locator,
  strategy: LocatorStrategy,
  ranker: (box: { x: number; y: number; width: number; height: number }) => number,
  predicate?: (locator: Locator) => Promise<boolean>
): Promise<RankedLocator | null> {
  try {
    if (!(await locator.isVisible())) return null;
    if (predicate && !(await predicate(locator))) return null;
    const box = await locator.boundingBox();
    if (!box) return null;
    return { locator, strategy: strategy.name, score: strategy.priority + ranker(box) };
  } catch {
    return null;
  }
}

async function resolveBestLocator(
  page: Page,
  strategies: LocatorStrategy[],
  timeoutMs: number,
  ranker: (box: { x: number; y: number; width: number; height: number }) => number,
  predicate?: (locator: Locator) => Promise<boolean>
): Promise<RankedLocator | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matches: RankedLocator[] = [];
    for (const strategy of strategies) {
      const group = strategy.locate(page);
      const count = await group.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, strategy.maxCandidates ?? 3); index += 1) {
        const ranked = await rankLocator(group.nth(index), strategy, ranker, predicate);
        if (ranked) matches.push(ranked);
      }
    }
    if (matches.length > 0) {
      matches.sort((left, right) => right.score - left.score);
      return matches[0] ?? null;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function resolveInputBox(page: Page, timeoutMs: number): Promise<RankedLocator | null> {
  return resolveBestLocator(page, INPUT_STRATEGIES, timeoutMs, (box) => Math.round(box.y + box.height), isInputEditable);
}

async function resolveSendButton(page: Page, timeoutMs: number): Promise<RankedLocator | null> {
  return resolveBestLocator(page, SEND_BUTTON_STRATEGIES, timeoutMs, (box) => Math.round(box.x + box.y + box.width), isLocatorEnabled);
}

async function readLocatorLabel(locator: Locator): Promise<string | null> {
  try {
    const value = await locator.evaluate((element) => {
      const htmlElement = element as HTMLElement;
      const text = [
        htmlElement.innerText,
        htmlElement.getAttribute("aria-label"),
        htmlElement.getAttribute("title"),
        htmlElement.getAttribute("data-test-id"),
        htmlElement.getAttribute("data-testid")
      ]
        .map((item) => item?.trim())
        .filter(Boolean)
        .join(" ");
      return text || null;
    });
    return normalizeText(value);
  } catch {
    return null;
  }
}

async function readUiLocale(page: Page): Promise<string | undefined> {
  try {
    const locale = await page.evaluate(() => document.documentElement.lang || navigator.language || "");
    return normalizeText(locale) || undefined;
  } catch {
    return undefined;
  }
}

async function resolveNewChatTrigger(page: Page, timeoutMs: number): Promise<RankedLocator | null> {
  const startedAt = Date.now();
  const patterns = [/new chat/i, /new conversation/i, /start new chat/i, /发起新对话/i, /新聊天/i, /新对话/i];
  while (Date.now() - startedAt < timeoutMs) {
    const candidates = page.locator("button, a, [role='button'], [role='link']");
    const count = await candidates.count().catch(() => 0);
    let best: RankedLocator | null = null;
    for (let index = 0; index < Math.min(count, 40); index += 1) {
      const locator = candidates.nth(index);
      try {
        if (!(await locator.isVisible()) || !(await isLocatorEnabled(locator))) continue;
        const label = await readLocatorLabel(locator);
        if (!label || !patterns.some((pattern) => pattern.test(label))) continue;
        const box = await locator.boundingBox();
        if (!box || box.x > 420) continue;
        const score = 700 - Math.round(box.x) - Math.round(box.y / 2);
        if (!best || score > best.score) best = { locator, strategy: `new-chat-left-nav:${label}`, score };
      } catch {}
    }
    if (best) return best;
    await page.waitForTimeout(250);
  }
  return null;
}

async function resolveModelTrigger(page: Page, timeoutMs: number): Promise<RankedLocator | null> {
  const startedAt = Date.now();
  const labelPatterns = [/\bmodel\b/i, /\bpro\b/i, /\bflash\b/i, /\bthinking\b/i, /gemini\s*\d+(?:\.\d+)?/i, /模型/i, /快速/i, /思考/i, /专业/i, /显示思路/i];
  while (Date.now() - startedAt < timeoutMs) {
    const composer = await resolveInputBox(page, 800);
    const composerBox = composer ? await composer.locator.boundingBox().catch(() => null) : null;
    const candidates = page.locator("footer button, footer [role='button'], rich-textarea button, main button, [aria-haspopup='menu']");
    const count = await candidates.count().catch(() => 0);
    let best: RankedLocator | null = null;
    for (let index = 0; index < Math.min(count, 80); index += 1) {
      const locator = candidates.nth(index);
      try {
        if (!(await locator.isVisible()) || !(await isLocatorEnabled(locator))) continue;
        const label = await readLocatorLabel(locator);
        if (!label || !labelPatterns.some((pattern) => pattern.test(label))) continue;
        if (/账号|account|profile|avatar|share|more|更多|conversation/i.test(label)) continue;
        const box = await locator.boundingBox();
        if (!box || box.y < 500 || box.x > 1200 || box.width > 420) continue;
        if (composerBox) {
          const verticalDistance = Math.abs(box.y - composerBox.y);
          const horizontalDistance = Math.abs(box.x - composerBox.x);
          if (verticalDistance > 260 || horizontalDistance > 500) continue;
        }
        const proximityBonus = composerBox ? 400 - Math.abs(Math.round(box.y - composerBox.y)) - Math.abs(Math.round(box.x - composerBox.x)) / 4 : 0;
        const score = 900 + Math.round(box.y) - Math.round(box.x / 8) + proximityBonus;
        if (!best || score > best.score) best = { locator, strategy: `model-trigger-footer:${label}`, score };
      } catch {}
    }
    if (best) return best;
    await page.waitForTimeout(250);
  }
  return null;
}

async function resolveModelTriggerFallback(page: Page): Promise<RankedLocator | null> {
  const input = await resolveInputBox(page, 1_000);
  if (input) {
    try {
      await input.locator.click({ timeout: 1_000 });
    } catch {
      // Ignore focus failures.
    }
  }

  const composerBox = input ? await input.locator.boundingBox().catch(() => null) : null;
  const candidates = page.locator("button[aria-haspopup='menu'], [role='button'][aria-haspopup='menu'], footer button, footer [role='button']");
  const count = await candidates.count().catch(() => 0);
  let best: RankedLocator | null = null;

  for (let index = 0; index < Math.min(count, 40); index += 1) {
    const locator = candidates.nth(index);
    try {
      if (!(await locator.isVisible()) || !(await isLocatorEnabled(locator))) continue;
      const label = await readLocatorLabel(locator);
      if (label && /账号|account|profile|avatar|share|more|更多|conversation/i.test(label)) continue;
      const box = await locator.boundingBox();
      if (!box || box.y < 500 || box.x > 1200 || box.width > 420) continue;
      if (composerBox) {
        const verticalDistance = Math.abs(box.y - composerBox.y);
        const horizontalDistance = Math.abs(box.x - composerBox.x);
        if (verticalDistance > 260 || horizontalDistance > 500) continue;
      }
      const score = 700 + Math.round(box.y) - Math.round(box.x / 8);
      if (!best || score > best.score) {
        best = { locator, strategy: `model-trigger-fallback:${label ?? "menu-button"}`, score };
      }
    } catch {
      // Ignore detached candidates.
    }
  }

  return best;
}

async function hasVisibleMatch(page: Page, strategies: LocatorStrategy[]): Promise<boolean> {
  const ranked = await resolveBestLocator(page, strategies, 500, () => 0);
  return Boolean(ranked);
}

async function openGeminiTarget(page: Page, url: string): Promise<void> {
  await page.goto(url, { timeout: appEnv.geminiPageTimeoutMs, waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: Math.min(appEnv.geminiPageTimeoutMs, 20_000) }).catch(() => undefined);
}

async function readInputText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    if (htmlElement instanceof HTMLTextAreaElement || htmlElement instanceof HTMLInputElement) {
      return htmlElement.value;
    }
    return htmlElement.innerText || htmlElement.textContent || "";
  });
}

async function readResponseNodes(page: Page): Promise<ResponseNode[]> {
  return page.evaluate((selectors) => {
    const seen = new Set<Element>();
    const items: ResponseNode[] = [];
    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        seen.add(node);
      }
    }
    for (const node of seen) {
      if (!(node instanceof HTMLElement)) continue;
      const text = (node.innerText || "").trim();
      if (!text) continue;
      const rect = node.getBoundingClientRect();
      const key = `${Math.round(rect.top)}:${Math.round(rect.left)}:${text.slice(0, 80)}`;
      if (items.some((item) => item.signature === key)) continue;
      items.push({
        signature: node.getAttribute("data-message-id") || node.getAttribute("data-turn-id") || node.id || key,
        text,
        top: rect.top,
        left: rect.left
      });
    }
    items.sort((left, right) => left.top - right.top || left.left - right.left);
    return items;
  }, [...RESPONSE_NODE_SELECTORS]);
}

async function waitForNewChatState(page: Page, previousUrl: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();
    const responses = await readResponseNodes(page).catch(() => []);
    const input = await resolveInputBox(page, 300);
    const inputText = input ? await readInputText(input.locator).catch(() => "") : "";
    if (currentUrl !== previousUrl && !isGeminiConversationUrl(currentUrl)) return true;
    if (!isGeminiConversationUrl(currentUrl) && input && !normalizeText(inputText)) return true;
    if (currentUrl !== previousUrl && responses.length === 0) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function ensureNewChatSurface(ctx: StageContext): Promise<void> {
  const trigger = await resolveNewChatTrigger(ctx.page, 5_000);
  if (!trigger) {
    throw new GeminiAutomationError("restore-or-create-chat", "locator", "new-chat requested but the left navigation new-chat trigger was not found");
  }
  const previousUrl = ctx.page.url();
  addDiagnostic(ctx, `clicking new-chat trigger via ${trigger.strategy}`);
  await trigger.locator.click({ timeout: 5_000 });
  const changed = await waitForNewChatState(ctx.page, previousUrl, 5_000);
  if (!changed) {
    throw new GeminiAutomationError("restore-or-create-chat", "page-state", "clicked new-chat trigger but Gemini stayed on the previous conversation surface");
  }
  addDiagnostic(ctx, `new-chat surface confirmed url=${ctx.page.url()}`);
}

async function detectCurrentModelLabel(page: Page): Promise<string | null> {
  const composerLabel = await detectModelLabelFromComposerV2(page);
  if (composerLabel) return composerLabel;
  const trigger = await resolveModelTrigger(page, 1_500);
  if (!trigger) return null;
  const label = await readLocatorLabel(trigger.locator);
  if (!label || /账号|account|profile|avatar|conversation/i.test(label)) return null;
  return label;
}

async function detectModelLabelFromComposer(page: Page): Promise<string | null> {
  const input = await resolveInputBox(page, 1_000);
  const inputBox = input ? await input.locator.boundingBox().catch(() => null) : null;
  if (!inputBox) return null;

  const candidates = page.locator("button, [role='button'], span, div");
  const count = await candidates.count().catch(() => 0);
  let best: { label: string; score: number } | null = null;

  for (let index = 0; index < Math.min(count, 120); index += 1) {
    const locator = candidates.nth(index);
    try {
      if (!(await locator.isVisible())) continue;
      const label = await readLocatorLabel(locator);
      if (!label) continue;
      if (!getModelPatterns(appEnv.geminiTargetModel).some((pattern) => pattern.test(label))) continue;
      if (/上传|文件|account|profile|avatar|conversation/i.test(label)) continue;

      const box = await locator.boundingBox();
      if (!box) continue;

      const nearComposer =
        box.y >= inputBox.y - 80 &&
        box.y <= inputBox.y + inputBox.height + 120 &&
        box.x >= inputBox.x &&
        box.x <= inputBox.x + inputBox.width + 40;

      if (!nearComposer) continue;

      const score =
        1000 -
        Math.abs(Math.round(box.y - inputBox.y)) -
        Math.abs(Math.round(box.x - (inputBox.x + inputBox.width)));

      if (!best || score > best.score) {
        best = { label, score };
      }
    } catch {
      // Ignore detached nodes.
    }
  }

  return best?.label ?? null;
}

async function detectModelLabelFromComposerV2(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const input =
      document.querySelector("div[contenteditable='true'][role='textbox']") ??
      document.querySelector("rich-textarea [contenteditable='true']") ??
      document.querySelector("textarea") ??
      document.querySelector("[role='textbox']");

    if (!(input instanceof HTMLElement)) {
      return null;
    }

    const inputRect = input.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], span, div"));
    let best: { label: string; score: number } | null = null;

    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) continue;
      const text = (node.innerText || node.textContent || "").trim();
      if (!text) continue;
      if (!/(^|\\s)(Pro|Flash|Thinking)(\\s|$)/i.test(text)) continue;
      if (/(upload|file|account|profile|avatar|conversation|上传|文件)/i.test(text)) continue;

      const rect = node.getBoundingClientRect();
      const nearComposer =
        rect.y >= inputRect.y - 80 &&
        rect.y <= inputRect.y + inputRect.height + 120 &&
        rect.x >= inputRect.x &&
        rect.x <= inputRect.x + inputRect.width + 60;

      if (!nearComposer) continue;

      const score =
        1000 -
        Math.abs(Math.round(rect.y - inputRect.y)) -
        Math.abs(Math.round(rect.x - (inputRect.x + inputRect.width)));

      if (!best || score > best.score) {
        best = { label: text, score };
      }
    }

    return best?.label ?? null;
  });
}

async function locateModelOption(page: Page, targetModel: string): Promise<RankedLocator | null> {
  const regex = new RegExp(getModelPatterns(targetModel).map((item) => item.source).join("|"), "i");
  const strategies: LocatorStrategy[] = [
    { name: "menuitemradio-model-option", priority: 420, maxCandidates: 4, locate: (p) => p.getByRole("menuitemradio", { name: regex }) },
    { name: "option-model-option", priority: 380, maxCandidates: 4, locate: (p) => p.getByRole("option", { name: regex }) },
    { name: "button-model-option", priority: 340, maxCandidates: 6, locate: (p) => p.getByRole("button", { name: regex }) },
    { name: "text-model-option", priority: 260, maxCandidates: 6, locate: (p) => p.getByText(regex) }
  ];
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const overlay = page.locator("[role='menu'], [role='listbox'], [role='dialog'], .cdk-overlay-pane, .mat-mdc-menu-panel");
    const overlayVisible = (await overlay.count().catch(() => 0)) > 0;
    const match = await resolveBestLocator(page, strategies, 600, (box) => Math.round(box.y), async (locator) => {
      if (!(await isLocatorEnabled(locator))) return false;
      const label = await readLocatorLabel(locator);
      if (label && /账号|account|profile|avatar/i.test(label)) return false;
      if (!overlayVisible) return true;
      return locator.evaluate((element) => Boolean(element.closest("[role='menu'], [role='listbox'], [role='dialog'], .cdk-overlay-pane, .mat-mdc-menu-panel")));
    });
    if (match) return match;
    await page.waitForTimeout(250);
  }
  return null;
}

async function fillPrompt(input: Locator, prompt: string): Promise<void> {
  await input.click({ timeout: 5_000 });
  const tagName = await input.evaluate((element) => element.tagName.toLowerCase());
  if (tagName === "textarea" || tagName === "input") {
    await input.fill(prompt, { timeout: 5_000 });
    return;
  }
  await input.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.textContent = "";
  });
  await input.pressSequentially(prompt, { delay: 15 });
}

async function submitPrompt(page: Page, input: Locator): Promise<string> {
  const sendButton = await resolveSendButton(page, 2_000);
  if (sendButton) {
    await sendButton.locator.click({ timeout: 5_000 });
    return sendButton.strategy;
  }
  await input.press("Enter");
  return "keyboard-enter";
}

async function captureConversationSnapshot(page: Page): Promise<ConversationSnapshot> {
  const responses = await readResponseNodes(page);
  const latest = responses.at(-1);
  return { responseCount: responses.length, lastResponseSignature: latest?.signature, lastResponseText: latest?.text };
}

function getLatestNewResponse(responses: ResponseNode[], snapshot: ConversationSnapshot): ResponseNode | null {
  if (responses.length === 0) return null;
  const newerByCount = responses.slice(snapshot.responseCount);
  if (newerByCount.length > 0) return newerByCount.at(-1) ?? null;
  const latest = responses.at(-1);
  if (latest && latest.signature === snapshot.lastResponseSignature && latest.text.length > (snapshot.lastResponseText?.length ?? 0)) return latest;
  return null;
}

async function readResponseProgress(page: Page, snapshot: ConversationSnapshot): Promise<ResponseProgress> {
  const responses = await readResponseNodes(page);
  return {
    latestResponse: getLatestNewResponse(responses, snapshot),
    generationActive: await hasVisibleMatch(page, GENERATION_INDICATOR_STRATEGIES),
    loadingActive: await hasVisibleMatch(page, LOADING_INDICATOR_STRATEGIES),
    sendReady: Boolean(await resolveSendButton(page, 500))
  };
}

function buildLoginDiagnostic(blockedText: string | null): string | null {
  const body = normalizeText(blockedText);
  if (/(sign in|log in|登录|登入)/i.test(body)) return "Gemini page appears to require login in the configured Edge profile.";
  return null;
}

async function bootstrap(ctx: StageContext): Promise<void> {
  ctx.sessionState = await loadGeminiSessionState();
  addDiagnostic(ctx, `loaded session file with conversation=${ctx.sessionState.lastConversationUrl ?? "none"}`);
}

async function openTargetPage(ctx: StageContext, options: RunGeminiWebTaskOptions): Promise<void> {
  if (!options.forceNewChat) {
    try {
      const route = await getArchiveThreadRouter().routePrompt(ctx.currentPrompt);
      for (const diagnostic of route.diagnostics) {
        addDiagnostic(ctx, `router ${diagnostic}`);
      }
      if (route.matched && route.conversationUrl) {
        ctx.resumeAttempted = true;
        ctx.routedThreadId = route.threadId;
        ctx.routedConversationUrl = route.conversationUrl;
        await openGeminiTarget(ctx.page, route.conversationUrl);
        addDiagnostic(
          ctx,
          `opened routed archived conversation strategy=${route.strategy ?? "unknown"} threadId=${route.threadId ?? "unknown"} score=${route.score} reason=${route.reason}`
        );
        return;
      }
      addDiagnostic(ctx, `router fallback reason=${route.reason}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addDiagnostic(ctx, `router failed and fell back to session restore: ${message}`);
    }
  }

  const savedUrl = ctx.sessionState.lastConversationUrl;
  if (!options.forceNewChat && savedUrl && isGeminiConversationUrl(savedUrl)) {
    ctx.resumeAttempted = true;
    try {
      await openGeminiTarget(ctx.page, savedUrl);
      addDiagnostic(ctx, `opened saved conversation target ${savedUrl}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addDiagnostic(ctx, `failed to open saved conversation target: ${message}`);
    }
  }
  ctx.resumeAttempted = false;
  await openGeminiTarget(ctx.page, appEnv.geminiWebUrl);
  addDiagnostic(ctx, options.forceNewChat ? "opened Gemini home because --new-chat was requested" : "opened Gemini home because no resumable saved conversation was available");
}

async function restoreOrCreateChat(ctx: StageContext, options: RunGeminiWebTaskOptions): Promise<void> {
  ctx.uiLocale = await readUiLocale(ctx.page);
  if (ctx.resumeAttempted) {
    const input = await resolveInputBox(ctx.page, 10_000);
    if (input) {
      ctx.runMode = "resume";
      addDiagnostic(ctx, `resumed saved conversation via ${input.strategy}`);
      return;
    }
    addDiagnostic(ctx, "saved conversation opened but composer was not ready; falling back to Gemini home.");
    await openGeminiTarget(ctx.page, appEnv.geminiWebUrl);
    ctx.uiLocale = await readUiLocale(ctx.page);
  }
  ctx.runMode = "new-chat";
  if (options.forceNewChat) {
    await ensureNewChatSurface(ctx);
  }
  addDiagnostic(ctx, `using Gemini home/new-chat surface locale=${ctx.uiLocale ?? "unknown"}`);
}

async function ensureTargetModel(ctx: StageContext, options: RunGeminiWebTaskOptions): Promise<void> {
  const shouldEnforce = ctx.runMode === "new-chat" || (ctx.runMode === "resume" && Boolean(options.forceModelOnResume));
  if (!shouldEnforce) {
    ctx.currentModelLabel = (await detectCurrentModelLabel(ctx.page)) ?? undefined;
    addDiagnostic(ctx, `skipping model switch on resumed conversation current=${ctx.currentModelLabel ?? "unknown"}`);
    return;
  }
  const targetModel = appEnv.geminiTargetModel.trim();
  if (!targetModel) {
    addDiagnostic(ctx, "target model is empty; skipping model switch");
    return;
  }
  const beforeLabel = await detectCurrentModelLabel(ctx.page);
  ctx.currentModelLabel = beforeLabel ?? undefined;
  addDiagnostic(ctx, `model enforcement active runMode=${ctx.runMode} target=${targetModel} current=${beforeLabel ?? "unknown"}`);
  if (matchesModelLabel(beforeLabel ?? undefined, targetModel)) {
    addDiagnostic(ctx, "target model already active; skipping switch");
    return;
  }
  const trigger = (await resolveModelTrigger(ctx.page, 5_000)) ?? (await resolveModelTriggerFallback(ctx.page));
  if (!trigger) {
    throw new GeminiAutomationError("ensure-target-model", "model-switch", `model switch trigger not found while targeting ${targetModel}`);
  }
  addDiagnostic(ctx, `opening model menu via ${trigger.strategy}`);
  await trigger.locator.click({ timeout: 5_000 });
  await ctx.page.waitForTimeout(500);
  const option = await locateModelOption(ctx.page, targetModel);
  if (!option) {
    throw new GeminiAutomationError("ensure-target-model", "model-switch", `model option ${targetModel} was not found in the Gemini model menu`);
  }
  addDiagnostic(ctx, `selecting target model ${targetModel} via ${option.strategy}`);
  await option.locator.click({ timeout: 5_000 });
  await ctx.page.waitForTimeout(1_000);
  const afterLabel = await detectCurrentModelLabel(ctx.page);
  ctx.currentModelLabel = afterLabel ?? undefined;
  addDiagnostic(ctx, `model verification after switch current=${afterLabel ?? "unknown"}`);
  if (!matchesModelLabel(afterLabel ?? undefined, targetModel)) {
    throw new GeminiAutomationError("ensure-target-model", "model-switch", `model switch verification failed target=${targetModel} current=${afterLabel ?? "unknown"}`);
  }
}

async function ensureInputReady(ctx: StageContext): Promise<Locator> {
  const loginDiagnostic = buildLoginDiagnostic(await ctx.page.textContent("body").catch(() => null));
  if (loginDiagnostic) addDiagnostic(ctx, loginDiagnostic);
  const rankedInput = await resolveInputBox(ctx.page, 20_000);
  if (!rankedInput) {
    throw new GeminiAutomationError("ensure-input-ready", "locator", "Gemini input box was not found. Confirm login state and inspect recent Gemini layout changes.");
  }
  addDiagnostic(ctx, `composer ready via ${rankedInput.strategy}`);
  return rankedInput.locator;
}

async function waitForResponseStart(ctx: StageContext, snapshot: ConversationSnapshot): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < appEnv.geminiResponseTimeoutMs) {
    const progress = await readResponseProgress(ctx.page, snapshot);
    if (progress.latestResponse || progress.generationActive || progress.loadingActive) {
      addDiagnostic(ctx, `response started generation=${progress.generationActive} loading=${progress.loadingActive} newResponse=${Boolean(progress.latestResponse)}`);
      return;
    }
    await ctx.page.waitForTimeout(POLL_INTERVAL_MS);
  }
  throw new GeminiAutomationError("wait-response-start", "timeout", "Gemini did not show a new response block or generation state before timeout.");
}

async function waitForResponseCompletion(ctx: StageContext, snapshot: ConversationSnapshot): Promise<ResponseNode> {
  const startedAt = Date.now();
  let latestStableCandidate: ResponseNode | null = null;
  let stableSince = 0;
  let lastObservedText = "";
  while (Date.now() - startedAt < appEnv.geminiResponseTimeoutMs) {
    const progress = await readResponseProgress(ctx.page, snapshot);
    const candidate = progress.latestResponse;
    if (candidate) {
      const normalizedText = normalizeText(candidate.text);
      if (normalizedText !== lastObservedText) {
        lastObservedText = normalizedText;
        latestStableCandidate = candidate;
        stableSince = 0;
      } else if (normalizedText && !stableSince) {
        stableSince = Date.now();
      }
      if (normalizedText && stableSince && Date.now() - stableSince >= appEnv.geminiStableWaitMs && !progress.generationActive && !progress.loadingActive && progress.sendReady) {
        addDiagnostic(ctx, `response completed sendReady=${progress.sendReady} generation=${progress.generationActive} loading=${progress.loadingActive} chars=${normalizedText.length}`);
        return candidate;
      }
    }
    await ctx.page.waitForTimeout(POLL_INTERVAL_MS);
  }
  const tail = latestStableCandidate ? excerpt(latestStableCandidate.text, 80) : "none";
  throw new GeminiAutomationError("wait-response-complete", "timeout", `Gemini response did not stabilize before timeout. latestObserved=${tail}`);
}

async function extractLatestReply(ctx: StageContext, response: ResponseNode): Promise<string> {
  const text = normalizeText(response.text);
  if (!text) {
    throw new GeminiAutomationError("extract-latest-reply", "extraction", "latest Gemini response block was found but did not contain readable text");
  }
  addDiagnostic(ctx, `latest reply extracted chars=${text.length}`);
  return text;
}

async function persistSuccessState(ctx: StageContext, replyText: string): Promise<void> {
  const currentUrl = ctx.page.url();
  const timestamp = new Date().toISOString();
  const state: GeminiSessionState = {
    ...ctx.sessionState,
    lastConversationUrl: isGeminiConversationUrl(currentUrl) ? currentUrl : ctx.sessionState.lastConversationUrl,
    lastKnownModel: ctx.currentModelLabel ?? ctx.sessionState.lastKnownModel,
    lastSuccessAt: timestamp,
    lastRunMode: ctx.runMode,
    lastReplyExcerpt: excerpt(replyText),
    uiLocale: ctx.uiLocale ?? ctx.sessionState.uiLocale,
    lastFailureStage: undefined,
    lastFailureReason: undefined,
    updatedAt: timestamp
  };
  await saveGeminiSessionState(state);
  addDiagnostic(ctx, `session persisted url=${state.lastConversationUrl ?? "none"} mode=${ctx.runMode}`);
}

async function persistFailureState(ctx: StageContext, error: GeminiAutomationError): Promise<void> {
  const currentUrl = ctx.page.url();
  const timestamp = new Date().toISOString();
  const state: GeminiSessionState = {
    ...ctx.sessionState,
    lastConversationUrl: isGeminiConversationUrl(currentUrl) ? currentUrl : ctx.sessionState.lastConversationUrl,
    lastKnownModel: ctx.currentModelLabel ?? ctx.sessionState.lastKnownModel,
    lastRunMode: ctx.runMode,
    uiLocale: ctx.uiLocale ?? ctx.sessionState.uiLocale,
    lastFailureStage: error.stage,
    lastFailureReason: error.message,
    updatedAt: timestamp
  };
  await saveGeminiSessionState(state);
}

async function archiveSuccessfulTurn(
  ctx: StageContext,
  prompt: string,
  replyText: string
): Promise<void> {
  try {
    const archiveResult = await getArchiveService().archiveTurn({
      prompt,
      reply: replyText,
      conversationUrl: isGeminiConversationUrl(ctx.page.url()) ? ctx.page.url() : ctx.sessionState.lastConversationUrl,
      source: "gemini-web",
      modelLastSeen: ctx.currentModelLabel,
      locale: ctx.uiLocale,
      lastRunMode: ctx.runMode,
      promptMetadata: {
        stage: "submit-prompt"
      },
      replyMetadata: {
        stage: "extract-latest-reply"
      }
    });

    if (!archiveResult.enabled) {
      addDiagnostic(ctx, `archive skipped ${archiveResult.message ?? "archive disabled"}`);
      return;
    }

    addDiagnostic(
      ctx,
      `archive success threadId=${archiveResult.threadId ?? "unknown"} turn=${archiveResult.turnIndex ?? -1} summaryUpdated=${archiveResult.summaryUpdated} chunks=${archiveResult.chunksCreated} pgvector=${archiveResult.pgvectorEnabled}`
    );

    if (archiveResult.degradedFeatures.length) {
      addDiagnostic(ctx, `archive degraded ${archiveResult.degradedFeatures.join("; ")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addDiagnostic(ctx, `archive failed non-fatally: ${message}`);
  }
}

export async function runGeminiWebTask(prompt: string, options: RunGeminiWebTaskOptions = {}): Promise<GeminiWebTaskResult> {
  const diagnostics: string[] = [];
  const session = await createBrowserSession();
  let keepBrowserOpen = false;
  const ctx: StageContext = {
    page: session.page,
    diagnostics,
    currentStage: "bootstrap",
    sessionState: {},
    runMode: options.forceNewChat ? "new-chat" : "resume",
    currentPrompt: prompt
  };
  try {
    await runStage(ctx, "bootstrap", async () => bootstrap(ctx));
    await runStage(ctx, "open-target-page", async () => openTargetPage(ctx, options));
    await runStage(ctx, "restore-or-create-chat", async () => {
      await restoreOrCreateChat(ctx, options);
      addDiagnostic(ctx, `chat path selected runMode=${ctx.runMode}`);
    });
    await runStage(ctx, "ensure-target-model", async () => ensureTargetModel(ctx, options));
    const input = await runStage(ctx, "ensure-input-ready", async () => ensureInputReady(ctx));
    const snapshot = await captureConversationSnapshot(ctx.page);
    addDiagnostic(ctx, `captured baseline responses=${snapshot.responseCount}`);
    await runStage(ctx, "submit-prompt", async () => {
      await fillPrompt(input, prompt);
      const submitStrategy = await submitPrompt(ctx.page, input);
      addDiagnostic(ctx, `prompt submitted via ${submitStrategy}`);
    });
    await runStage(ctx, "wait-response-start", async () => waitForResponseStart(ctx, snapshot));
    const response = await runStage(ctx, "wait-response-complete", async () => waitForResponseCompletion(ctx, snapshot));
    const replyText = await runStage(ctx, "extract-latest-reply", async () => extractLatestReply(ctx, response));
    await runStage(ctx, "persist-session-state", async () => persistSuccessState(ctx, replyText));
    await archiveSuccessfulTurn(ctx, prompt, replyText);
    return { success: true, text: replyText, diagnostics, stage: ctx.currentStage };
  } catch (error) {
    const automationError = toAutomationError(error, ctx.currentStage);
    addDiagnostic(ctx, `failed stage=${automationError.stage} kind=${automationError.kind} reason=${automationError.message}`);
    try {
      await persistFailureState(ctx, automationError);
    } catch (persistError) {
      const message = persistError instanceof Error ? persistError.message : String(persistError);
      addDiagnostic(ctx, `failed to persist failure state: ${message}`);
    }
    if (appEnv.browserKeepOpenOnError) {
      keepBrowserOpen = true;
      addDiagnostic(ctx, "browser left open because BROWSER_KEEP_OPEN_ON_ERROR=true");
    }
    return {
      success: false,
      error: `Gemini web task failed at ${automationError.stage}: ${automationError.message}`,
      diagnostics,
      stage: automationError.stage,
      failureKind: automationError.kind
    };
  } finally {
    if (!keepBrowserOpen) await session.close();
  }
}
