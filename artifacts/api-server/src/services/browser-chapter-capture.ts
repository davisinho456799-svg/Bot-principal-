/// <reference lib="dom" />

import type { Browser, BrowserContext, Page, Request, Response } from "playwright";
import type { MonitorPlatform, ParsedChapter } from "./parsers/index";
import { enrichChapterSubtitles } from "./parsers/chapter-subtitles";
import { applyCaptureSubtitles, type CaptureSubtitle } from "./chapter-subtitle-capture";
import { applyToptoonPairCapture } from "./toptoon-pair-capture";
import { getMonitorDependencyExport, loadMonitorDependency } from "../lib/monitor-dependencies";
import { assertMonitorPlatformEnabled } from "./monitor-platform-settings.js";

const PAGE_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_WIDTH = 2_400;
const MAX_CAPTURE_HEIGHT = 4_800;
export const MAX_TOOMICS_CHAPTERS_PER_IMAGE = 5;
// Keep the pixels of the real platform card. Padding here would make the
// Discord attachment look like a reconstructed strip instead of the source UI.
const CARD_PADDING = 0;
const CARD_MEDIA_WAIT_MS = 30_000;
const CARD_MEDIA_POLL_MS = 150;

export function capturedGroupWithinLimit(platform: MonitorPlatform, chapterCount: number): boolean {
  return platform !== "toomics" || chapterCount <= MAX_TOOMICS_CHAPTERS_PER_IMAGE;
}

type ChapterBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserChapter = ParsedChapter & {
  captureId: string;
  captureOrder: number;
};

export type CapturedChapterGroup = {
  chapterNumbers: string[];
  image: Buffer;
};

export type ToomicsLoginAttemptDiagnostic = {
  page: string;
  httpStatus: number | null;
  loginLinks: number;
  loginTarget?: string;
  loginClicked: boolean;
  loginClickMode?: "normal" | "forÃ§ado";
  loginNormalClickError?: string;
  loginClickError?: string;
  postClickPage?: string;
  emailFields: number;
  passwordFields: number;
  emailFieldsAcrossPages?: number;
  passwordFieldsAcrossPages?: number;
  frames: number;
  frameFields?: ToomicsLoginFrameDiagnostic[];
  trace?: ToomicsLoginTraceStep[];
  otherPages?: string[];
  signals: string[];
};

export type ToomicsLoginTraceStep = {
  type: "navegação" | "resposta" | "página" | "campos" | "clique" | "janela";
  page: string;
  httpStatus?: number | null;
  result?: string;
  emailFields?: number;
  passwordFields?: number;
};

export type ToomicsLoginFrameDiagnostic = {
  page: string;
  forms: number;
  userIdFields: number;
  visibleUserIdFields: number;
  userPwFields: number;
  visibleUserPwFields: number;
  emailLikeFields: number;
  visibleEmailLikeFields: number;
  passwordFields: number;
  visiblePasswordFields: number;
};

export type BrowserListingDiagnostics = {
  finalUrl: string;
  pageTitle: string;
  bodyTextLength: number;
  visibleImageCount: number;
  signals: string[];
  authentication: string;
  authenticationFailureStage?: string;
  authenticationAttempts?: ToomicsLoginAttemptDiagnostic[];
};

export type BrowserListingSession = {
  candidates: BrowserChapter[];
  diagnostics: BrowserListingDiagnostics;
  captureGroups(chapterIds: string[], subtitles?: CaptureSubtitle[], topToonPairTest?: boolean): Promise<CapturedChapterGroup[]>;
  close(): Promise<void>;
};

export type BrowserChapterSnapshot = BrowserChapter & {
  box: ChapterBox;
};

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;
let imageFilterSequence = 0;
type Chromium = typeof import("playwright").chromium;
let chromiumPromise: Promise<Chromium> | null = null;

async function getChromium(): Promise<Chromium> {
  chromiumPromise ??= loadMonitorDependency("playwright")
    .then((module) => {
      const chromium = getMonitorDependencyExport<Chromium>(module, "chromium");
      if (!chromium || typeof chromium.launch !== "function") {
        throw new Error("Playwright nÃ£o exportou um launcher Chromium utilizÃ¡vel.");
      }
      return chromium;
    })
    .catch(error => { chromiumPromise = null; throw error; });
  return chromiumPromise;
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = getChromium()
      .then((chromium) =>
        chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
        args: [
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-extensions",
          "--no-sandbox",
          "--disable-setuid-sandbox",
        ],
        }),
      )
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}

async function getBrowserContext(): Promise<BrowserContext> {
  if (!contextPromise) {
    contextPromise = getBrowser()
      .then((browser) =>
        browser.newContext({
          viewport: { width: 1_440, height: 1_200 },
          deviceScaleFactor: 1,
          locale: "en-US",
          userAgent:
            process.env.PLAYWRIGHT_USER_AGENT ??
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        }),
      )
      .catch((error) => {
        contextPromise = null;
        throw error;
      });
  }
  return contextPromise;
}

async function waitForRenderedPage(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: PAGE_TIMEOUT_MS });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForTimeout(700);

  await page
    .evaluate(
      `(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
      })()`,
    )
    .catch(() => undefined);
}

async function prepareCapturePage(page: Page, platform: MonitorPlatform): Promise<void> {
  await page.route("**/*", async (route) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url().toLocaleLowerCase();
    if (
      (resourceType === "font" && platform !== "toomics") ||
      resourceType === "media" ||
      resourceType === "websocket" ||
      /doubleclick|googlesyndication|google-analytics|facebook\\.net|hotjar/.test(url)
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}

async function loadToomicsKoreanFont(page: Page): Promise<boolean> {
  try {
    await page.addStyleTag({
      url: "https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap",
    });
    await page.addStyleTag({
      content: `
        .ep__episode, .ep__title, .ep_stitle, .episode-subtitle, .chapter-subtitle {
          font-family: "Noto Sans KR", sans-serif !important;
        }
      `,
    });
    return await page.evaluate(async () => {
      const loaded = await Promise.race([
        document.fonts.load('500 16px "Noto Sans KR"', "íêµ­ì´"),
        new Promise<FontFace[]>((resolve) => setTimeout(() => resolve([]), 6_000)),
      ]);
      return loaded.length > 0 && document.fonts.check('500 16px "Noto Sans KR"', "íêµ­ì´");
    });
  } catch {
    return false;
  }
}

async function resetBrowserAfterCrash(): Promise<void> {
  const browser = await browserPromise?.catch(() => null);
  browserPromise = null;
  contextPromise = null;
  await browser?.close().catch(() => undefined);
}

export function toomicsLoginUrls(listingUrl: string, currentPageUrl: string, discoveredLoginUrls: string[] = []): string[] {
  const origins: string[] = [];
  const urls: string[] = [];
  urls.push("https://global.toomics.com/por/login");
  for (const candidate of discoveredLoginUrls) {
    try {
      const url = new URL(candidate, listingUrl);
      if ((url.protocol === "https:" || url.protocol === "http:") &&
          (url.hostname === "toomics.com" || url.hostname.endsWith(".toomics.com"))) {
        const loginUrl = `${url.origin}${url.pathname}`;
        if (!urls.includes(loginUrl)) urls.push(loginUrl);
        if (!origins.includes(url.origin)) origins.push(url.origin);
      }
    } catch {
      // Ignore malformed login links and non-URL click handlers.
    }
  }
  for (const candidate of [
    listingUrl,
    currentPageUrl,
    "https://toomics.com",
    "https://www.toomics.com",
    "https://global.toomics.com",
  ]) {
    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        (url.hostname === "toomics.com" || url.hostname.endsWith(".toomics.com"))
      ) {
        const origin = url.origin;
        if (!origins.includes(origin)) origins.push(origin);
      }
    } catch {
      // Ignore blank/about:blank pages and malformed origins.
    }
  }
  for (const origin of origins) {
    const localizedLogin = `${origin}/por/login`;
    if (!urls.includes(localizedLogin)) urls.push(localizedLogin);
    const home = `${origin}/`;
    if (!urls.includes(home)) urls.push(home);
  }
  return urls;
}

export function shouldClickToomicsLoginLink(value: string): boolean {
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1]?.toLowerCase();
    return lastSegment !== "login" && lastSegment !== "signin";
  } catch {
    return false;
  }
}

export async function discoverToomicsLoginUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const loginText = /login|sign[\s-]?in|log[\s-]?in|entrar|ë¡ê·¸ì¸/i;
    return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter((anchor) => {
        const style = getComputedStyle(anchor);
        const rect = anchor.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 && rect.width > 2 && rect.height > 2 &&
          loginText.test(`${anchor.href} ${anchor.textContent || ""}`);
      })
      .map((anchor) => anchor.href);
  });
}
export const TOOMICS_LOGIN_LINK_SELECTOR =
  'a[href*="login" i]:visible, a[href*="signin" i]:visible, a:has-text("Login"):visible, a:has-text("Entrar"):visible, a:has-text("ë¡ê·¸ì¸"):visible, button:has-text("Login"):visible, button:has-text("Entrar"):visible, button:has-text("ë¡ê·¸ì¸"):visible';

function safeToomicsPageLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 160);
  } catch {
    return "pÃ¡gina desconhecida";
  }
}

async function countVisibleFieldsAcrossPages(pages: Page[], selector: string): Promise<number> {
  let count = 0;
  for (const candidatePage of pages) {
    for (const frame of candidatePage.frames()) {
      try {
        count += await frame.locator(selector).count();
      } catch {
        // A popup or frame can close while the login diagnostic is sampling it.
      }
    }
  }
  return count;
}


async function toomicsDocumentRedirectTrace(response: Response | null): Promise<ToomicsLoginTraceStep[]> {
  if (!response) return [];
  const trace: ToomicsLoginTraceStep[] = [];
  let request: Request | null = response.request();
  while (request) {
    const documentResponse = await request.response().catch(() => null);
    trace.push({
      type: "resposta",
      page: safeToomicsPageLabel(request.url()),
      httpStatus: documentResponse?.status() ?? null,
      result: request.method(),
    });
    request = request.redirectedFrom();
  }
  return trace.reverse();
}


const TOOMICS_EMAIL_FIELD_CANDIDATES =
  'input[type="email"], input[name*="email" i], input[name*="user" i], input[name*="login" i], input[name*="id" i], input#user_id';
const TOOMICS_PASSWORD_FIELD_CANDIDATES = 'input[type="password"], input#user_pw';

function visibleSelector(selector: string): string {
  return selector.split(",").map((part) => `${part.trim()}:visible`).join(", ");
}

export async function inspectToomicsLoginFrames(pages: Page[]): Promise<ToomicsLoginFrameDiagnostic[]> {
  const diagnostics: ToomicsLoginFrameDiagnostic[] = [];
  for (const candidatePage of pages) {
    for (const frame of candidatePage.frames()) {
      try {
        const [
          forms, userIdFields, visibleUserIdFields, userPwFields, visibleUserPwFields,
          emailLikeFields, visibleEmailLikeFields, passwordFields, visiblePasswordFields,
        ] = await Promise.all([
          frame.locator("form").count(),
          frame.locator("input#user_id").count(),
          frame.locator("input#user_id:visible").count(),
          frame.locator("input#user_pw").count(),
          frame.locator("input#user_pw:visible").count(),
          frame.locator(TOOMICS_EMAIL_FIELD_CANDIDATES).count(),
          frame.locator(visibleSelector(TOOMICS_EMAIL_FIELD_CANDIDATES)).count(),
          frame.locator(TOOMICS_PASSWORD_FIELD_CANDIDATES).count(),
          frame.locator(visibleSelector(TOOMICS_PASSWORD_FIELD_CANDIDATES)).count(),
        ]);
        diagnostics.push({
          page: safeToomicsPageLabel(frame.url()), forms, userIdFields, visibleUserIdFields,
          userPwFields, visibleUserPwFields, emailLikeFields, visibleEmailLikeFields,
          passwordFields, visiblePasswordFields,
        });
      } catch {
        // A popup or frame can close while its login controls are being sampled.
      }
    }
  }
  return diagnostics.slice(0, 12);
}

type ToomicsLoginProgress = { stage: string };

async function loginToomics(
  page: Page,
  listingUrl: string,
  discoveredLoginUrls: string[] = [],
  attempts: ToomicsLoginAttemptDiagnostic[] = [],
  progress: ToomicsLoginProgress = { stage: "preparaÃ§Ã£o do login" },
): Promise<string> {
  const email = process.env.TOOMICS_EMAIL?.trim();
  const password = process.env.TOOMICS_PASSWORD;
  if (!email || !password) return "credenciais nÃ£o configuradas";

  try {
    // `visible` is a Playwright locator pseudo-class, not an option accepted
    // by locator.filter(). Without it the hidden login modal can win over the
    // real form and the listing is reopened without an authenticated session.
    const emailSelector =
      'input[type="email"]:visible, input[name*="email" i]:visible, input[name*="user" i]:visible, input[name*="login" i]:visible, input[name*="id" i]:visible';
    const passwordSelector = 'input[type="password"]:visible';
    progress.stage = "localizaÃ§Ã£o dos campos";
    let emailInput = page.locator(emailSelector).first();
    let passwordInput = page.locator(passwordSelector).first();

    progress.stage = "verificaÃ§Ã£o dos campos";
    if (!(await passwordInput.count())) {
      progress.stage = "localizaÃ§Ã£o do link de login";
      const loginLink = page.locator(
        TOOMICS_LOGIN_LINK_SELECTOR,
      ).first();
      if (await loginLink.count()) {
        progress.stage = "clique no link de login";
        await loginLink.click().catch(() => undefined);
        progress.stage = "espera apÃ³s abrir o login";
        await page.waitForTimeout(500);
        progress.stage = "localizaÃ§Ã£o dos campos";
        emailInput = page.locator(emailSelector).first();
        passwordInput = page.locator(passwordSelector).first();
      }
    }

    progress.stage = "verificaÃ§Ã£o dos campos";
    if (!(await passwordInput.count())) {
      const loginUrls = toomicsLoginUrls(listingUrl, page.url(), discoveredLoginUrls);

      for (const loginUrl of loginUrls) {
        const trace: ToomicsLoginTraceStep[] = [{ type: "navegação", page: safeToomicsPageLabel(loginUrl), result: "iniciada" }];
        progress.stage = "abertura da pÃ¡gina de login";
        const response = await page.goto(loginUrl, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT_MS,
        });
        trace.push(...await toomicsDocumentRedirectTrace(response));
        progress.stage = "espera da pÃ¡gina de login";
        await waitForRenderedPage(page);
        trace.push({ type: "página", page: safeToomicsPageLabel(page.url()), result: "renderizada" });
        progress.stage = "espera dos campos do formulÃ¡rio";
        await page
          .locator('input[type="email"], input[type="password"], #user_id, #user_pw')
          .first()
          .waitFor({ state: "attached", timeout: 3_000 })
          .catch(() => undefined);

        progress.stage = "localizaÃ§Ã£o do link de login";
        const loginLink = page.locator(TOOMICS_LOGIN_LINK_SELECTOR).first();
        const loginLinks = await loginLink.count();
        let loginClicked = false;
        let loginClickMode: "normal" | "forÃ§ado" | undefined;
        let loginNormalClickError: string | undefined;
        let loginClickError: string | undefined;
        let loginTarget: string | undefined;
        let postClickPage: string | undefined;
        const popupPages: Page[] = [];
        const recordPopup = (popup: Page) => popupPages.push(popup);
        let loginEmail = page.locator(emailSelector).first();
        let loginPassword = page.locator(passwordSelector).first();
        let emailFields = await loginEmail.count();
        let passwordFields = await loginPassword.count();
        trace.push({ type: "campos", page: safeToomicsPageLabel(page.url()), emailFields, passwordFields, result: "visíveis antes do clique" });
        if (!(emailFields && passwordFields) && loginLinks && shouldClickToomicsLoginLink(loginUrl)) {
          try {
            const href = await loginLink.getAttribute("href");
            if (href) loginTarget = safeToomicsPageLabel(new URL(href, page.url()).toString());
          } catch {
            // Keep the diagnostic limited to sanitized URL labels.
          }
          page.on("popup", recordPopup);
          try {
            progress.stage = "clique no link de login";
            await loginLink.click({ timeout: 1_500, noWaitAfter: true });
            loginClicked = true;
            loginClickMode = "normal";
          } catch (error) {
            const normalError = error instanceof Error ? error.name : "Error";
            loginNormalClickError = normalError;
            loginClickError = normalError;
            if (error instanceof Error && error.name === "TimeoutError") {
              try {
                progress.stage = "clique forÃ§ado no link de login";
                await loginLink.click({ force: true, timeout: 1_500, noWaitAfter: true });
                loginClicked = true;
                loginClickMode = "forÃ§ado";
                loginClickError = undefined;
              } catch (forcedError) {
                loginClickError = forcedError instanceof Error ? forcedError.name : "Error";
              }
            }
          }
          postClickPage = safeToomicsPageLabel(page.url());
          trace.push({ type: "clique", page: postClickPage, result: loginClickMode ?? loginClickError ?? "não concluído" });
          progress.stage = "espera apÃ³s abrir o login";
          await page.waitForTimeout(500);
          page.off("popup", recordPopup);
          progress.stage = "localizaÃ§Ã£o dos campos";
          loginEmail = page.locator(emailSelector).first();
          loginPassword = page.locator(passwordSelector).first();
          emailFields = await loginEmail.count();
          passwordFields = await loginPassword.count();
        }
        const inspectedPages = [page, ...popupPages];
        const otherPages = popupPages.map((popup) => safeToomicsPageLabel(popup.url()));
        trace.push(...otherPages.map((page) => ({ type: "janela" as const, page, result: "aberta" })));
        const emailFieldsAcrossPages = await countVisibleFieldsAcrossPages(inspectedPages, emailSelector);
        const passwordFieldsAcrossPages = await countVisibleFieldsAcrossPages(inspectedPages, passwordSelector);
        const frameFields = await inspectToomicsLoginFrames(inspectedPages);
        trace.push({ type: "campos", page: safeToomicsPageLabel(page.url()), emailFields: emailFieldsAcrossPages, passwordFields: passwordFieldsAcrossPages, result: `visíveis em ${frameFields.length} quadros` });
        const signals = await page.evaluate(() => {
          const text = `${document.title} ${document.body?.innerText || ""}`.toLocaleLowerCase();
          return [
            /captcha|recaptcha|are you human|verifique que/.test(text) ? "captcha" : "",
            /cloudflare|just a moment|checking your browser/.test(text) ? "cloudflare" : "",
            /access denied|403 forbidden|forbidden/.test(text) ? "access-denied" : "",
          ].filter(Boolean);
        }).catch(() => []);
        attempts.push({
          page: safeToomicsPageLabel(page.url()),
          httpStatus: response?.status() ?? null,
          loginLinks,
          ...(loginTarget ? { loginTarget } : {}),
          loginClicked,
          ...(loginClickMode ? { loginClickMode } : {}),
          ...(loginNormalClickError ? { loginNormalClickError } : {}),
          ...(loginClickError ? { loginClickError } : {}),
          ...(postClickPage ? { postClickPage } : {}),
          emailFields,
          passwordFields,
          emailFieldsAcrossPages,
          passwordFieldsAcrossPages,
          frames: page.frames().length,
          frameFields,
          trace: trace.slice(0, 32),
          ...(otherPages.length ? { otherPages } : {}),
          signals,
        });
        if (emailFields && passwordFields) {
          emailInput = loginEmail;
          passwordInput = loginPassword;
          break;
        }
      }
    }

    if (!(await emailInput.count()) || !(await passwordInput.count())) {
      return "formulÃ¡rio de login nÃ£o encontrado";
    }

    progress.stage = "preenchimento do e-mail";
    await emailInput.fill(email, { force: true });
    progress.stage = "preenchimento da senha";
    await passwordInput.fill(password, { force: true });
    progress.stage = "localizaÃ§Ã£o do botÃ£o de login";
    const submit = page.locator(
      'form:has(#user_id) button[type="submit"]:visible, form:has(#user_id) input[type="submit"]:visible, button:has-text("Login"):visible, button:has-text("Entrar"):visible, button:has-text("ë¡ê·¸ì¸"):visible',
    ).last();
    const submitButton = await submit.count()
      ? submit
      : page.locator('form:has(#user_id) button[type="submit"], form:has(#user_id) input[type="submit"]').last();
    if (!(await submitButton.count())) return "botÃ£o de login nÃ£o encontrado";

    progress.stage = "envio do formulÃ¡rio";
    await Promise.all([
      submitButton.click({ force: true }).catch(() => undefined),
      page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined),
    ]);
    await page.waitForTimeout(1_000);

    progress.stage = "verificaÃ§Ã£o do resultado do login";
    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").toLocaleLowerCase();
      const hasPassword = Array.from(document.querySelectorAll('input[type="password"]'))
        .some((input) => {
          const style = getComputedStyle(input);
          const rect = input.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" &&
            Number.parseFloat(style.opacity || "1") > 0 && rect.width > 2 && rect.height > 2;
        });
      const hasCaptcha = /captcha|recaptcha|are you human|verifique que/.test(text);
      const hasError = /invalid password|incorrect|senha invÃ¡lida|email invÃ¡lido|ë¡ê·¸ì¸ ì¤í¨/.test(text);
      return { hasPassword, hasCaptcha, hasError };
    });
    if (state.hasCaptcha) return "captcha ou verificaÃ§Ã£o manual necessÃ¡ria";
    if (state.hasError || state.hasPassword) return "login rejeitado";
    return "login concluÃ­do";
  } catch (error) {
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
      ? error.name
      : "UnknownError";
    const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : "erro desconhecido";
    return `erro no login [${errorName}] (etapa: ${progress.stage}; ${message})`;
  }
}

/**
 * Detection happens inside the browser. It deliberately selects a chapter
 * card/link, not an arbitrary image. Toptoon banners such as "FULLVERSION
 * APP" therefore never become candidates because they have no chapter marker.
 */
export async function findRenderedChapters(
  page: Page,
  platform: MonitorPlatform,
): Promise<BrowserChapterSnapshot[]> {
  const snapshot = (await page.evaluate(
    `(({ platform }) => {
      const CARD_ATTRIBUTE = "data-monitor-capture-card";
      const selector = [
        "a[href]",
        "a.js-episode-link",
        "li",
        "article",
        "[data-episode]",
        "[data-episode-no]",
        "[data-chapter]",
        "[data-chapter-number]",
        "[class*='episode']",
        "[class*='chapter']",
        "[id*='episode']",
        "[id*='chapter']",
        "div"
      ].join(",");
       // Toomics uses "banner" in legitimate episode-thumbnail paths.
       // Keep generic banner filtering for the other sites, but do not hide
       // a real Toomics card image just because its CDN path says banner.
       const blockedWords = platform === "toomics"
         ? /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[/._-])(?:lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i
         : /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[-_ ])banner(?:[-_ ]|$)|(?:^|[/._-])(?:banner|bnr|lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i;
      const chapterLabel = /(?:chapter|episode|episodio|epis[oÃ³]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|Ã­tulo)?|cap\\\\.)/i;
      const chapterPattern = /(?:chapter|episode|episodio|epis[oÃ³]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|Ã­tulo)?|cap\\\\.)\\\\s*(?:#|[-_:])?\\\\s*(\\\\d{1,5}(?:[.,]\\\\d+)?)/ig;
      const hashPattern = /(?:^|\\\\s)#(\\\\d{1,5}(?:[.,]\\\\d+)?)(?=\\\\s|$)/g;
      const numberFromHref = /(?:chapter|episode|episodio|ep|ch|cap)[/_=-](\\\\d{1,5}(?:[.,]\\\\d+)?)/i;
      const platformAttributes = platform === "lezhin"
        ? ["data-episode", "data-episode-no", "data-episode-number"]
        : platform === "toomics"
          ? ["data-episode", "data-episode-no", "data-ep", "data-episode-number"]
          : ["data-episode", "data-episode-no", "data-chapter", "data-chapter-number", "data-ep"];
      const slash = String.fromCharCode(92);
      const digit = slash + "d";
      const whitespace = slash + "s";
      const numberPattern = new RegExp(
        "^" + digit + "{1,5}(?:" + slash + "." + digit + "+)?$",
      );
      const whitespacePattern = new RegExp(whitespace + "+", "g");
      const chapterLabelFixed = new RegExp(
        "(?:chapter|episode|episodio|epis[oÃ³]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|tÃ­tulo)?|cap" + slash + ".)",
        "i",
      );
      const chapterPatternFixed = new RegExp(
        "(?:chapter|episode|episodio|epis[oÃ³]dio|ep(?:isode)?|ch(?:apter)?|cap(?:itulo|tÃ­tulo)?|cap" +
          slash + ".)" + whitespace + "*(?:#|[-_:])?" + whitespace + "*(" + digit +
          "{1,5}(?:[.,]" + digit + "+)?)",
        "ig",
      );
      const hashPatternFixed = new RegExp(
        "(?:^|" + whitespace + ")#(" + digit + "{1,5}(?:[.,]" + digit + "+)?)(?=" +
          whitespace + "|$)",
        "g",
      );
      const koreanChapterPatternFixed = new RegExp(
        "ì " + whitespace + "*(" + digit + "{1,5}(?:[.,]" + digit + "+)?)" +
          whitespace + "*í",
        "ig",
      );
      const numberFromHrefFixed = new RegExp(
        "(?:chapter|episode|episodio|ep|ch|cap)[/_=-](" + digit +
          "{1,5}(?:[.,]" + digit + "+)?)",
        "i",
      );
      const internalChapterIdSelector = "[data-episode-id], [data-chapter-id], [data-episode-key], [data-chapter-key]";
      const datePattern = new RegExp(
        "(^|[^0-9])((?:20)?[0-9]{2})[./-]([0-9]{1,2})[./-]([0-9]{1,2})(?=[^0-9]|$)",
        "g",
      );

      const normalizeNumber = (value) =>
        String(value).replace(",", ".").trim().replace(/^0+/, "") || "0";

      const releaseDateFrom = (source) => {
        const match = datePattern.exec(source);
        datePattern.lastIndex = 0;
        if (!match) return "";
        const rawYear = Number(match[2]);
        const year = rawYear < 100 ? 2_000 + rawYear : rawYear;
        const month = Number(match[3]);
        const day = Number(match[4]);
        const date = new Date(Date.UTC(year, month - 1, day, 12));
        return Number.isNaN(date.getTime()) ||
          date.getUTCFullYear() !== year ||
          date.getUTCMonth() !== month - 1 ||
          date.getUTCDate() !== day
          ? ""
          : date.toISOString().slice(0, 10);
      };

      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 2 &&
          rect.height > 2;
      };

      const chapterNumbers = (element) => {
        const values = [];
        const add = (value) => {
          const normalized = normalizeNumber(value);
          if (numberPattern.test(normalized) && !values.includes(normalized)) {
            values.push(normalized);
          }
        };

        if (platform === "toomics") {
          const episodeLabels = element.matches(".ep__episode")
            ? [element]
            : Array.from(element.querySelectorAll(".ep__episode"));
          if (episodeLabels.length > 1) return values;
          const episodeLabel = episodeLabels[0];
          if (episodeLabel) {
            const label = episodeLabel.innerText || episodeLabel.textContent || "";
            const normalizedLabel = normalizeNumber(label);
            if (numberPattern.test(normalizedLabel)) {
              add(normalizedLabel);
              return values;
            }
            for (const attribute of Array.from(element.attributes)) {
              const routeNumber = attribute.value.match(
                new RegExp(
                  "/ep/(" + digit + "{1,5}(?:" + slash + "." + digit + "+)?)(?:/|[?#]|$)",
                  "i",
                ),
              );
              if (routeNumber) {
                add(routeNumber[1]);
                break;
              }
            }
            return values;
          }
        }

        if (platform === "toptoon") {
          const labelSelector = ".ep_title, .ep__episode, .episode-number, .episode-num, .chapter-number";
          const labels = element.matches(labelSelector)
            ? [element]
            : Array.from(element.querySelectorAll(labelSelector));
          for (const label of labels) {
            if (!visible(label)) continue;
            const labelText = (label.innerText || label.textContent || "").replace(whitespacePattern, " ").trim();
            const visibleNumbers = [];
            let match;
            while ((match = chapterPatternFixed.exec(labelText))) visibleNumbers.push(normalizeNumber(match[1]));
            chapterPatternFixed.lastIndex = 0;
            while ((match = koreanChapterPatternFixed.exec(labelText))) visibleNumbers.push(normalizeNumber(match[1]));
            koreanChapterPatternFixed.lastIndex = 0;
            const koreanEpisode = labelText.match(new RegExp("(?:ì " + whitespace + "*)?(" + digit + "{1,5}(?:[.,]" + digit + "+)?)" + whitespace + "*í", "i"));
            if (!visibleNumbers.length && koreanEpisode) visibleNumbers.push(normalizeNumber(koreanEpisode[1]));
            if (visibleNumbers.length) return [visibleNumbers[0]];
          }
        }

        for (const attribute of platformAttributes) {
          const value = element.getAttribute(attribute);
          if (value) {
            const match = value.match(new RegExp(digit + "{1,5}(?:[.,]" + digit + ")?"));
            if (match) add(match[0]);
          }
        }

        if (platform === "toomics") {
          const numberCell = element.querySelector(
            ".cell-num .num, .episode-number, .episode-num, .chapter-number",
          );
          if (numberCell) add(numberCell.textContent || "");
        }

        const hasInternalChapterId = Boolean(
          element.closest(internalChapterIdSelector),
        );
        const href = element.getAttribute("href") || "";
        if (!hasInternalChapterId) {
          const hrefMatch = href.match(numberFromHrefFixed);
          if (hrefMatch) add(hrefMatch[1]);
        }

        const text = (element.innerText || element.textContent || " ").replace(whitespacePattern, " ").trim();
        for (const source of [text, ...Array.from(element.attributes).map((attribute) => attribute.value)]) {
          if (platform === "toomics") {
            const toomicsEpisodeMatch = source.match(
              new RegExp("/ep/(" + digit + "{1,5})(?:/|$)", "i"),
            );
            if (toomicsEpisodeMatch) add(toomicsEpisodeMatch[1]);
          }
          let match;
          while ((match = chapterPatternFixed.exec(source))) add(match[1]);
          chapterPatternFixed.lastIndex = 0;
          while ((match = hashPatternFixed.exec(source))) add(match[1]);
          hashPatternFixed.lastIndex = 0;
          while ((match = koreanChapterPatternFixed.exec(source))) add(match[1]);
          koreanChapterPatternFixed.lastIndex = 0;
        }
        return values;
      };

      const nodes = Array.from(document.querySelectorAll(selector));
      const bestByNumber = new Map();
      const minimumCardHeight = platform === "toomics" ? 120 : 90;

      for (const element of nodes) {
        if (!visible(element)) continue;
        const text = (element.innerText || element.textContent || " ").replace(whitespacePattern, " ").trim();
        // A real chapter card can contain a promotional banner inside it
        // (Toptoon commonly renders "FULLVERSION APP" in the same card).
        // Rejecting the whole element here prevents the later media-level
        // filtering from preserving the actual chapter card.
        if (!text || text.length > 1_200) continue;

        const numbers = chapterNumbers(element);
        if (!numbers.length || numbers.length > 3) continue;

        let cardElement = element;
        for (
          let parent = element.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          const parentRect = parent.getBoundingClientRect();
          const parentText = (parent.innerText || parent.textContent || " ")
            .replace(whitespacePattern, " ")
            .trim();
          const parentNumbers = chapterNumbers(parent);
           const parentHasImage = Boolean(parent.querySelector("img, picture, source, [data-bg], [data-ep_thumb1], [data-ep_thumb2], [data-ep_thumb3]"));
          if (
            parentNumbers.length !== 1 ||
            !parentHasImage ||
            parentRect.width < 240 ||
            parentRect.height < minimumCardHeight ||
            parentRect.width > 1_400 ||
            parentRect.height > 600 ||
            parentText.length > 1_200
          ) {
            if (parentRect.height > 600 || parentRect.width > 1_400) break;
            continue;
          }
          cardElement = parent;
          // Pare no primeiro card vÃ¡lido. Continuar subindo pode selecionar
          // o contÃªiner da lista inteira e repetir a mesma imagem na captura.
          break;
        }

        const rect = cardElement.getBoundingClientRect();
        // Toomics has nested episode fragments that can look like a complete
        // card at 90px tall. Capturing that inner wrapper cuts off the rest of
        // the chapter row, so require a larger card or keep walking ancestors.
        if (rect.height < minimumCardHeight) continue;
        const cardText = (cardElement.innerText || cardElement.textContent || " ")
          .replace(whitespacePattern, " ")
          .trim();
        const classText = [
          cardElement.id || "",
          cardElement.className && typeof cardElement.className === "string" ? cardElement.className : "",
          ...Array.from(cardElement.attributes).map((attribute) => attribute.name)
        ].join(" ");
        const hasMarker = chapterLabelFixed.test(classText) ||
          platformAttributes.some((attribute) => cardElement.hasAttribute(attribute)) ||
          chapterLabelFixed.test(cardElement.getAttribute("href") || "");
         const hasImage = Boolean(cardElement.querySelector("img, picture, source, [data-bg], [data-ep_thumb1], [data-ep_thumb2], [data-ep_thumb3]"));
        const hasLink = cardElement.tagName.toLowerCase() === "a" || Boolean(cardElement.querySelector("a[href]"));
        const hasChapterText = chapterLabelFixed.test(cardText);
         const hasCardDimensions = rect.width >= 240 && rect.height >= minimumCardHeight;
         const mediaElements = [
           ...Array.from(cardElement.querySelectorAll("img, source, [data-bg], [data-ep_thumb1], [data-ep_thumb2], [data-ep_thumb3]")),
           cardElement,
         ];
        const mediaContext = (media) => [
          media.currentSrc || "",
          media.getAttribute("src") || "",
          media.getAttribute("data-src") || "",
          media.getAttribute("data-original") || "",
          media.getAttribute("data-lazy-src") || "",
          media.getAttribute("data-image") || "",
           media.getAttribute("data-bg") || "",
           media.getAttribute("data-ep_thumb1") || "",
          media.getAttribute("data-ep_thumb2") || "",
          media.getAttribute("data-ep_thumb3") || "",
          media.getAttribute("data-thumbnail") || "",
          media.getAttribute("data-thumb") || "",
          media.getAttribute("alt") || "",
          media.getAttribute("title") || "",
          media.getAttribute("class") || "",
          media.getAttribute("style") || "",
        ].join(" ");
          const mediaValues = (media) => {
            const currentValues = [
             media.currentSrc || "",
             media.getAttribute("src") || "",
             media.getAttribute("data-src") || "",
             media.getAttribute("data-original") || "",
             media.getAttribute("data-lazy-src") || "",
             media.getAttribute("data-image") || "",
             media.getAttribute("data-bg") || "",
             media.getAttribute("data-ep_thumb1") || "",
             media.getAttribute("data-ep_thumb2") || "",
             media.getAttribute("data-ep_thumb3") || "",
             media.getAttribute("data-thumbnail") || "",
             media.getAttribute("data-thumb") || "",
           ];
            const values = platform === "toomics"
              ? [
                  media.getAttribute("data-original") || "",
                  media.getAttribute("data-src") || "",
                  media.getAttribute("data-lazy-src") || "",
                  media.getAttribute("data-image") || "",
                  media.getAttribute("src") || "",
                  media.currentSrc || "",
                  media.getAttribute("data-ep_thumb1") || "",
                  media.getAttribute("data-ep_thumb2") || "",
                  media.getAttribute("data-ep_thumb3") || "",
                  media.getAttribute("data-thumbnail") || "",
                  media.getAttribute("data-thumb") || "",
                ]
              : currentValues;
           const style = media.getAttribute("style") || "";
           for (const match of style.matchAll(/url\\((?:"|')?([^"')]+)(?:"|')?\\)/ig)) {
             if (match[1]) values.push(match[1]);
           }
           return values;
         };
         const isPlaceholderImage = (value) => {
           const normalized = String(value || "").trim().toLowerCase();
           return !normalized ||
             normalized.startsWith("data:image/") ||
             /placeholder|no[-_ ]?image|transparent|spacer|blank[-_ ]?image/.test(normalized);
         };
         const thumbnailValue = mediaElements
           .flatMap((media) => mediaValues(media))
           .find((value) =>
             !blockedWords.test(String(value)) && !isPlaceholderImage(value),
           ) || "";

         // Schedule/status labels and internal episode links can carry a
         // chapter-like number without being a visual release card. A
         // candidate must have actual card media; otherwise it can produce a
         // phantom chapter notification with no photo.
          // A visible lock/blank placeholder is not a usable Toomics
          // thumbnail. Do not let it become a valid browser capture, because
          // Playwright would faithfully screenshot the white placeholder.
          if (!hasImage || !hasCardDimensions || (platform === "toomics" && !thumbnailValue)) continue;

        // A platform chapter card is expected to have a marker, link, or
        // image. This rejects the page wrapper and promotional banners.
        if (!hasMarker && !hasChapterText && !hasLink) continue;

        const score =
          (hasMarker ? 80 : 0) +
          (hasChapterText ? 45 : 0) +
          (hasImage ? 25 : 0) +
          (hasLink ? 15 : 0) -
          Math.max(0, numbers.length - 1) * 45 -
          Math.min(text.length, 1_000) / 35 -
          Math.min(rect.width * rect.height / 100_000, 20);

        for (const number of numbers) {
          const previous = bestByNumber.get(number);
          if (!previous || score > previous.score) {
            bestByNumber.set(number, {
              element: cardElement,
              number,
              score,
              thumbnailUrl: thumbnailValue ? new URL(thumbnailValue, location.href).toString() : "",
              rect: {
                x: rect.left + window.scrollX,
                y: rect.top + window.scrollY,
                width: rect.width,
                height: rect.height
              }
            });
          }
        }
      }

      const records = Array.from(bestByNumber.values())
        .sort((left, right) =>
          left.rect.y - right.rect.y ||
          left.rect.x - right.rect.x ||
          left.number.localeCompare(right.number, undefined, { numeric: true })
        );

      return records.map((record, index) => {
        const captureId = "monitor-card-" + index;
        record.element.setAttribute(CARD_ATTRIBUTE, captureId);
        const titleText = (selector) => {
          const node = record.element.querySelector(selector);
          if (!node) return "";
          return node.getAttribute("data-subtitle-en") ||
            node.getAttribute("data-title-en") ||
            node.getAttribute("data-ep-title-en") ||
            node.textContent?.trim() || "";
        };
        const genericTitle = titleText(
          platform === "toomics"
            ? ".ep_stitle,.episode-subtitle,.chapter-subtitle,[data-chapter-subtitle],.ep__title"
            : ".ep_stitle,.episode-subtitle,.chapter-subtitle,[data-chapter-subtitle]",
        );
        const pageLanguage = (document.documentElement.lang || (platform === "toomics" ? "ko" : "")).toLowerCase();
        const subtitleEn = platform === "toomics"
          ? titleText('[data-subtitle-en],[data-title-en],[data-ep-title-en],[lang|="en"],[data-lang="en"],.ep__title--en,.ep_stitle--en') ||
            (/^en(?:-|$)/.test(pageLanguage) ? genericTitle : "")
          : "";
        const subtitleKo = platform === "toomics"
          ? titleText('[data-subtitle-ko],[data-title-ko],[data-ep-title-ko],[lang|="ko"],[data-lang="ko"],.ep__title--ko,.ep_stitle--ko') ||
            (/^ko(?:-|$)/.test(pageLanguage) ? genericTitle : "")
          : "";
        return {
          number: record.number,
          thumbnailUrl: record.thumbnailUrl,
          subtitle: subtitleEn || subtitleKo || genericTitle || undefined,
          subtitleLanguage: subtitleEn ? "en" : subtitleKo ? "ko" : undefined,
          ...(subtitleEn ? { subtitleEn } : {}),
          ...(subtitleKo ? { subtitleKo } : {}),
          releaseDate: releaseDateFrom(
            record.element.innerText || record.element.textContent || "",
          ),
          captureId,
          captureOrder: index,
          box: record.rect
        };
      });
    })(${JSON.stringify({ platform })})`,
  )) as BrowserChapterSnapshot[];

  if (!snapshot.length) return [];

  const imageUrls = snapshot
    .map((chapter) => chapter.thumbnailUrl)
    .filter(Boolean);
  if (imageUrls.length) {
    await page
      .evaluate(
        `((urls) => Promise.all(urls.map((url) => {
          const image = Array.from(document.images).find((candidate) =>
            candidate.currentSrc === url ||
            candidate.src === url ||
            candidate.getAttribute("src") === url
          );
          if (!image || image.complete) return Promise.resolve();
          return new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
            setTimeout(resolve, 4_000);
          });
        })) )(${JSON.stringify(imageUrls)})`,
      )
      .catch(() => undefined);
  }

  return snapshot;
}

function unionBox(chapters: BrowserChapterSnapshot[]): ChapterBox {
  const left = Math.min(...chapters.map((chapter) => chapter.box.x));
  const top = Math.min(...chapters.map((chapter) => chapter.box.y));
  const right = Math.max(
    ...chapters.map((chapter) => chapter.box.x + chapter.box.width),
  );
  const bottom = Math.max(
    ...chapters.map((chapter) => chapter.box.y + chapter.box.height),
  );
  return {
    x: Math.max(0, left - CARD_PADDING),
    y: Math.max(0, top - CARD_PADDING),
    width: right - left + CARD_PADDING * 2,
    height: bottom - top + CARD_PADDING * 2,
  };
}

function fitsTogether(chapters: BrowserChapterSnapshot[]): boolean {
  const box = unionBox(chapters);
  return box.width <= MAX_CAPTURE_WIDTH && box.height <= MAX_CAPTURE_HEIGHT;
}

export function makeGreedyGroups(
  candidates: BrowserChapterSnapshot[],
  maxChaptersPerGroup = Number.POSITIVE_INFINITY,
): BrowserChapterSnapshot[][] {
  const groups: BrowserChapterSnapshot[][] = [];
  let current: BrowserChapterSnapshot[] = [];

  for (const candidate of candidates) {
    const next = [...current, candidate];
    const adjacent =
      !current.length ||
      candidate.captureOrder ===
        current[current.length - 1]!.captureOrder + 1;

    if (
      current.length &&
      (!adjacent || current.length >= maxChaptersPerGroup || !fitsTogether(next))
    ) {
      groups.push(current);
      current = [];
    }
    current.push(candidate);
  }

  if (current.length) groups.push(current);
  return groups;
}

export type CaptureThumbnailTarget = {
  captureId: string;
  thumbnailUrl: string;
};

async function waitForPrimaryThumbnails(
  page: Page,
  targets: CaptureThumbnailTarget[],
  platform: MonitorPlatform,
): Promise<boolean> {
  return page.evaluate(
    ({ targets, platform, timeoutMs, pollMs }) => {
      const blockedWords = platform === "toomics"
        ? /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[/._-])(?:lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i
        : /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[-_ ])banner(?:[-_ ]|$)|(?:^|[/._-])(?:banner|bnr|lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i;
      const imageAttributes = [
        "src",
        "data-src",
        "data-original",
        "data-lazy-src",
        "data-image",
        "data-bg",
        "data-ep_thumb1",
        "data-ep_thumb2",
        "data-ep_thumb3",
        "data-thumbnail",
        "data-thumb",
      ];
      const normalizeUrl = (value: string) => {
        try {
          return new URL(value, location.href).href;
        } catch {
          return "";
        }
      };
      const backgroundUrls = (value: string) =>
        [...value.matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/gi)]
          .map((match) => normalizeUrl(match[1] ?? ""))
          .filter(Boolean);
      const visibleAndLarge = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width >= 48 &&
          rect.height >= 30;
      };
      const contextOf = (element: HTMLElement) =>
        imageAttributes
          .map((attribute) => element.getAttribute(attribute) || "")
          .join(" ");
      const imageHasPrimaryUrl = (
        image: HTMLImageElement,
        expectedUrl: string,
      ) => {
        const urls = [
          image.currentSrc,
          image.src,
          ...imageAttributes.map((attribute) => image.getAttribute(attribute) || ""),
        ].map(normalizeUrl);
        return urls.includes(expectedUrl);
      };
      const hasLoadedPrimaryThumbnail = (
        card: Element,
        thumbnailUrl: string,
      ) => {
        const expectedUrl = normalizeUrl(thumbnailUrl);
        if (!expectedUrl) return false;

        const images = Array.from(card.querySelectorAll("img")).some((image) => {
          const element = image as HTMLImageElement;
          return visibleAndLarge(element) &&
            element.complete &&
            element.naturalWidth > 0 &&
            !blockedWords.test(contextOf(element)) &&
            imageHasPrimaryUrl(element, expectedUrl);
        });
        if (images) return true;

        const mediaNodes = [
          card,
          ...Array.from(card.querySelectorAll("*")),
        ].filter((node): node is HTMLElement => node instanceof HTMLElement);
        return mediaNodes.some((node) => {
          if (!visibleAndLarge(node) || blockedWords.test(contextOf(node))) return false;
          const styles = [
            getComputedStyle(node).backgroundImage,
            getComputedStyle(node, "::before").backgroundImage,
            getComputedStyle(node, "::after").backgroundImage,
          ];
          return styles.some((style) => backgroundUrls(style).includes(expectedUrl));
        });
      };

      const deadline = Date.now() + timeoutMs;
      return new Promise<boolean>((resolve) => {
        const check = () => {
          const ready = targets.every((target) => {
            const card = document.querySelector(
              `[data-monitor-capture-card="${target.captureId}"]`,
            );
            return Boolean(
              card && hasLoadedPrimaryThumbnail(card, target.thumbnailUrl),
            );
          });
          if (ready) {
            resolve(true);
          } else if (Date.now() >= deadline) {
            resolve(false);
          } else {
            setTimeout(check, pollMs);
          }
        };
        check();
      });
    },
    {
      targets,
      platform,
      timeoutMs: CARD_MEDIA_WAIT_MS,
      pollMs: CARD_MEDIA_POLL_MS,
    },
  );
}

export async function promotePrimaryThumbnails(
  page: Page,
  targets: CaptureThumbnailTarget[],
): Promise<void> {
  await page.evaluate(({ targets }) => {
    const normalizeUrl = (value: string) => {
      try {
        return new URL(value, location.href).href;
      } catch {
        return "";
      }
    };
    const sourceAttributes = [
      "src",
      "data-original",
      "data-src",
      "data-lazy-src",
      "data-image",
      "data-thumbnail",
      "data-thumb",
    ];
    const srcsetAttributes = ["srcset", "data-srcset"];
    const srcsetUrls = (value: string) =>
      value.split(",").map((entry) => entry.trim().split(/\s+/)[0] || "");

    for (const target of targets) {
      const card = document.querySelector(
        `[data-monitor-capture-card="${target.captureId}"]`,
      );
      if (!(card instanceof HTMLElement)) continue;
      const expectedUrl = normalizeUrl(target.thumbnailUrl);
      if (!expectedUrl) continue;

      const image = Array.from(card.querySelectorAll("img")).find((candidate) =>
        sourceAttributes.some((attribute) =>
          normalizeUrl(candidate.getAttribute(attribute) || "") === expectedUrl,
        ) || srcsetAttributes.some((attribute) =>
          srcsetUrls(candidate.getAttribute(attribute) || "")
            .some((url) => normalizeUrl(url) === expectedUrl),
        ),
      );
      if (!image) continue;

      const currentUrl = normalizeUrl(image.currentSrc || image.src || "");
      if (currentUrl !== expectedUrl || (image.complete && image.naturalWidth === 0)) {
        image.loading = "eager";
        image.removeAttribute("srcset");
        image.removeAttribute("sizes");
        image.src = expectedUrl;
      }
    }
  }, { targets });
}

export async function isolatePrimaryThumbnails(
  page: Page,
  targets: CaptureThumbnailTarget[],
): Promise<void> {
  const result = await page.evaluate(({ captureTargets, filterId }) => {
    const imageAttributes = [
      "src",
      "data-src",
      "data-original",
      "data-lazy-src",
      "data-image",
      "data-bg",
      "data-ep_thumb1",
      "data-ep_thumb2",
      "data-ep_thumb3",
      "data-thumbnail",
      "data-thumb",
    ];
    const normalizeUrl = (value: string) => {
      try {
        return new URL(value, location.href).href;
      } catch {
        return "";
      }
    };
    const backgroundUrls = (value: string) =>
      [...value.matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/gi)]
        .map((match) => normalizeUrl(match[1] ?? ""))
        .filter(Boolean);
    const visibleAndLarge = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number.parseFloat(style.opacity || "1") > 0 &&
        rect.width >= 48 &&
        rect.height >= 30;
    };
    const hideEmptyContainers = (
      node: HTMLElement,
      card: HTMLElement,
      primaryNode: HTMLElement,
    ) => {
      let current: HTMLElement | null = node;
      while (
        current &&
        current !== card &&
        current.textContent?.trim() === "" &&
        !current.contains(primaryNode)
      ) {
        const parent: HTMLElement | null = current.parentElement;
        current.style.setProperty("display", "none", "important");
        current = parent;
      }
    };
    const imageUrls = (image: HTMLImageElement) =>
      [
        image.currentSrc,
        image.src,
        ...imageAttributes.map((attribute) => image.getAttribute(attribute) || ""),
      ]
        .map(normalizeUrl)
        .filter(Boolean);
    const cssRules: string[] = [];
    const plans: Array<{
      card: HTMLElement;
      expectedUrl: string;
      primary: {
        kind: "image" | "background" | "before" | "after";
        node: HTMLElement;
      };
    }> = [];

    for (const [targetIndex, target] of captureTargets.entries()) {
      const card = document.querySelector(
        `[data-monitor-capture-card="${target.captureId}"]`,
      );
      const expectedUrl = normalizeUrl(target.thumbnailUrl);
      if (!(card instanceof HTMLElement) || !expectedUrl) {
        return {
          ok: false,
          error: `Chapter ${target.captureId} has no usable primary thumbnail URL`,
        };
      }

      let primary: {
        kind: "image" | "background" | "before" | "after";
        node: HTMLElement;
      } | null = null;
      for (const image of Array.from(card.querySelectorAll("img"))) {
        const element = image as HTMLImageElement;
        if (
          visibleAndLarge(element) &&
          element.complete &&
          element.naturalWidth > 0 &&
          imageUrls(element).includes(expectedUrl)
        ) {
          primary = { kind: "image", node: element };
          break;
        }
      }

      const nodes = [
        card,
        ...Array.from(card.querySelectorAll("*")),
      ].filter((node): node is HTMLElement => node instanceof HTMLElement);
      if (!primary) {
        for (const node of nodes) {
          if (!visibleAndLarge(node)) continue;
          if (backgroundUrls(getComputedStyle(node).backgroundImage).includes(expectedUrl)) {
            primary = { kind: "background", node };
            break;
          }
          if (backgroundUrls(getComputedStyle(node, "::before").backgroundImage).includes(expectedUrl)) {
            primary = { kind: "before", node };
            break;
          }
          if (backgroundUrls(getComputedStyle(node, "::after").backgroundImage).includes(expectedUrl)) {
            primary = { kind: "after", node };
            break;
          }
        }
      }
      if (!primary) {
        return {
          ok: false,
          error: `Primary thumbnail could not be isolated for chapter ${target.captureId}`,
        };
      }

      plans.push({ card, expectedUrl, primary });

      for (const node of nodes) {
        for (const pseudo of ["before", "after"] as const) {
          const pseudoUrls = backgroundUrls(
            getComputedStyle(node, `::${pseudo}`).backgroundImage,
          );
          if (!pseudoUrls.length) continue;
          const marker = `${filterId}-${targetIndex}-${pseudo}-${cssRules.length}`;
          const markerAttribute = `data-monitor-single-image-${pseudo}`;
          node.setAttribute(markerAttribute, marker);
          const selector = `[${markerAttribute}="${marker}"]::${pseudo}`;
          if (
            primary.kind === pseudo &&
            primary.node === node &&
            pseudoUrls.includes(expectedUrl)
          ) {
            cssRules.push(
              `${selector}{background-image:url(${JSON.stringify(expectedUrl)})!important}`,
            );
          } else {
            cssRules.push(
              `${selector}{background-image:none!important;content:none!important}`,
            );
          }
        }
      }
    }

    for (const { card, expectedUrl, primary } of plans) {
      for (const image of Array.from(card.querySelectorAll("img"))) {
        if (primary.kind !== "image" || image !== primary.node) {
          const element = image as HTMLImageElement;
          element.style.setProperty(
            "display",
            "none",
            "important",
          );
          hideEmptyContainers(element, card, primary.node);
        }
      }

      const nodes = [
        card,
        ...Array.from(card.querySelectorAll("*")),
      ].filter((node): node is HTMLElement => node instanceof HTMLElement);
      for (const node of nodes) {
        const urls = backgroundUrls(getComputedStyle(node).backgroundImage);
        if (!urls.length) continue;
        if (primary.kind === "background" && node === primary.node) {
          node.style.setProperty(
            "background-image",
            `url(${JSON.stringify(expectedUrl)})`,
            "important",
          );
          node.style.setProperty("background-size", "contain", "important");
          node.style.setProperty("background-position", "center", "important");
          node.style.setProperty("background-repeat", "no-repeat", "important");
        } else {
          node.style.setProperty("background-image", "none", "important");
          hideEmptyContainers(node, card, primary.node);
        }
      }

      for (const node of nodes) {
        if (node === primary.node || node.contains(primary.node)) continue;
        if (
          getComputedStyle(node, "::before").backgroundImage !== "none" ||
          getComputedStyle(node, "::after").backgroundImage !== "none"
        ) {
          hideEmptyContainers(node, card, primary.node);
        }
      }
    }

    if (cssRules.length) {
      const style = document.createElement("style");
      style.setAttribute("data-monitor-single-image-filter", "true");
      style.textContent = cssRules.join("\n");
      (document.head ?? document.documentElement).append(style);
    }
    return { ok: true, error: "" };
  }, {
    captureTargets: targets,
    filterId: `filter-${imageFilterSequence++}`,
  });

  if (!result.ok) {
    throw new Error(result.error || "Could not isolate the primary chapter thumbnail");
  }
}

async function captureGroup(
  page: Page,
  chapters: BrowserChapterSnapshot[],
  platform: MonitorPlatform,
  pairTest = false,
): Promise<Buffer> {
  if (!chapters.length) throw new Error("Cannot capture an empty chapter group");

  // Playwright clip coordinates are viewport-relative, while detection stores
  // document-relative boxes. Make the whole selected run fit in the viewport
  // before resolving the final clip; otherwise cards below the fold would
  // produce an "outside the resulting image" screenshot error.
  const documentBox = unionBox(chapters);
  const currentViewport = page.viewportSize();
  await page.setViewportSize({
    width: currentViewport?.width ?? 1_440,
    height: Math.min(
      MAX_CAPTURE_HEIGHT,
      Math.max(1_200, Math.ceil(documentBox.height + 24)),
    ),
  });

  await page
    .evaluate(
      `((ids, platform) => {
        const blockedWords = platform === "toomics"
          ? /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[/._-])(?:lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i
          : /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[-_ ])banner(?:[-_ ]|$)|(?:^|[/._-])(?:banner|bnr|lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i;
        for (const id of ids) {
          const card = document.querySelector('[data-monitor-capture-card="' + id + '"]');
          if (!card) continue;
          for (const media of card.querySelectorAll("img, picture, source")) {
            const context = [
              media.currentSrc || "",
              media.getAttribute("src") || "",
              media.getAttribute("data-src") || "",
              media.getAttribute("data-original") || "",
              media.getAttribute("data-lazy-src") || "",
              media.getAttribute("data-image") || "",
              media.getAttribute("alt") || "",
              media.getAttribute("title") || "",
              media.getAttribute("class") || "",
            ].join(" ");
            if (!blockedWords.test(context)) continue;
            const target = media instanceof HTMLElement ? media : media.parentElement;
            target?.style.setProperty("display", "none", "important");
          }
        }
      })(${JSON.stringify(chapters.map((chapter) => chapter.captureId))}, ${JSON.stringify(platform)})`,
    )
    .catch(() => undefined);

  const cardIds = chapters.map((chapter) => chapter.captureId);
  const captureTargets = chapters.map((chapter) => ({
    captureId: chapter.captureId,
    thumbnailUrl: chapter.thumbnailUrl,
  }));
  if (!(pairTest && platform === "toptoon")) {
    await promotePrimaryThumbnails(page, captureTargets);
  }
  if (pairTest && platform === "toptoon") {
    if (chapters.some(chapter => !chapter.extraThumbnailUrls)) {
      throw new Error("The selected test chapter does not provide both extra thumbnails");
    }
    await applyToptoonPairCapture(page, chapters.map(chapter => ({
      captureId: chapter.captureId, urls: chapter.extraThumbnailUrls!,
    })));
  }
  for (const cardId of cardIds) {
    await page
      .locator(`[data-monitor-capture-card="${cardId}"]`)
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await page.waitForTimeout(100);
  }

  // Some Toomics cards keep the real thumbnail only in lazy-load attributes
  // and rely on a page script that is not always run by headless Chromium.
  // Promote those values after the cards have entered the viewport so the
  // screenshot does not capture a text-only card.
  await page
    .evaluate(
      `((ids, platform) => {
       const blockedWords = platform === "toomics"
         ? /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[/._-])(?:lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i
         : /fullversion|full version|download app|app version|promotion|promo|advertisement|(?:^|[-_ ])banner(?:[-_ ]|$)|(?:^|[/._-])(?:banner|bnr|lock|locked|no[-_ ]?image|placeholder)(?:[/._-]|$)/i;
        const lazyAttributes = [
          "data-src",
          "data-srcset",
          "data-original",
          "data-lazy-src",
          "data-image",
          "data-bg",
          "data-ep_thumb1",
          "data-ep_thumb2",
          "data-ep_thumb3",
          "data-thumbnail",
          "data-thumb",
        ];
        const placeholder = (value) => {
          const normalized = String(value || "").trim().toLowerCase();
          return !normalized ||
            normalized.startsWith("data:image/") ||
            /placeholder|no[-_ ]?image|transparent|spacer|blank[-_ ]?image/.test(normalized);
        };
        const usable = (value) =>
          !placeholder(value) && !blockedWords.test(String(value || ""));
        const firstUsable = (element, attributes) => {
          for (const attribute of attributes) {
            const value = element.getAttribute(attribute);
            if (usable(value)) return value;
          }
          return "";
        };
        const setBackground = (element, value) => {
          if (!value || !(element instanceof HTMLElement)) return;
          const current = getComputedStyle(element).backgroundImage;
          if (current && current !== "none") return;
          element.style.setProperty(
            "background-image",
            "url(" + JSON.stringify(new URL(value, location.href).toString()) + ")",
            "important",
          );
        };

        for (const id of ids) {
          const card = document.querySelector(
            '[data-monitor-capture-card="' + id + '"]',
          );
          if (!card) continue;

          for (const image of card.querySelectorAll("img")) {
            const current = image.currentSrc || image.getAttribute("src") || "";
            if (!usable(current)) {
              const source = firstUsable(image, [
                "data-src",
                "data-original",
                "data-lazy-src",
                "data-image",
                "data-thumbnail",
                "data-thumb",
              ]);
              if (source) image.src = new URL(source, location.href).toString();
            }
            const srcset = firstUsable(image, ["data-srcset"]);
            if (srcset && (!image.srcset || !usable(current))) image.srcset = srcset;
          }

          // Keep the real <img> thumbnail already present in the chapter card.
          // Do not promote data-ep_thumb* values to CSS backgrounds: those
          // attributes describe additional background panels from the source
          // page, which makes the capture include three extra images.
        }
      })(${JSON.stringify(cardIds)}, ${JSON.stringify(platform)})`,
    )
    .catch(() => undefined);

  // Wait for the thumbnail selected during detection, not merely any image
  // inside the card. A site can render its extra thumb panels first.
  const mediaReady = pairTest && platform === "toptoon" ? true : await waitForPrimaryThumbnails(
    page,
    captureTargets,
    platform,
  );

  if (!mediaReady) {
    throw new Error("Selected primary chapter thumbnails did not finish loading");
  }

  await page.waitForTimeout(150);
  if (!pairTest || platform !== "toptoon") await isolatePrimaryThumbnails(page, captureTargets);

  const boxes = (
    await Promise.all(
      chapters.map((chapter) =>
        page
          .locator(`[data-monitor-capture-card="${chapter.captureId}"]`)
          .boundingBox(),
      ),
    )
  ).filter((box): box is ChapterBox => Boolean(box));

  if (!boxes.length) throw new Error("The selected chapter cards are no longer rendered");
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const clip = {
    x: Math.max(0, left),
    y: Math.max(0, top),
    width: right - left,
    height: bottom - top,
  };

  return page.screenshot({
    type: "png",
    animations: "disabled",
    clip,
  });
}

export async function openBrowserListing(
  listingUrl: string,
  platform: MonitorPlatform,
  retryAfterCrash = true,
  signal?: AbortSignal,
): Promise<BrowserListingSession> {
  assertMonitorPlatformEnabled(platform);
  signal?.throwIfAborted();
  const context = await getBrowserContext();
  signal?.throwIfAborted();
  let page = await context.newPage();
  const onAbort = () => { void page.close().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let pageCrashed = false;
  const setupPage = async (nextPage: Page) => {
    nextPage.setDefaultTimeout(8_000);
    nextPage.on("crash", () => {
      pageCrashed = true;
    });
    await prepareCapturePage(nextPage, platform);
    await nextPage.setExtraHTTPHeaders({
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
    });
  };

  try {
    if (signal?.aborted) onAbort();
    signal?.throwIfAborted();
    await setupPage(page);
    await page.goto(listingUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    await waitForRenderedPage(page);
    signal?.throwIfAborted();

    let authentication = "nÃ£o aplicÃ¡vel";
    let authenticationFailureStage: string | undefined;
    let authenticationAttempts: ToomicsLoginAttemptDiagnostic[] | undefined;
    if (platform === "toomics") {
      const discoveredLoginUrls = await discoverToomicsLoginUrls(page).catch(() => []);
      // Do not navigate the image-heavy listing page to the login flow.
      // Closing it first avoids keeping all chapter thumbnails alive while
      // Toomics creates the authentication page.
      await page.close().catch(() => undefined);
      pageCrashed = false;
      page = await context.newPage();
      signal?.throwIfAborted();
      await setupPage(page);
      authenticationAttempts = [];
      const loginProgress: ToomicsLoginProgress = { stage: "preparaÃ§Ã£o do login" };
      authentication = await loginToomics(
        page, listingUrl, discoveredLoginUrls, authenticationAttempts, loginProgress,
      );
      if (authentication.startsWith("erro no login")) authenticationFailureStage = loginProgress.stage;
      await page.close().catch(() => undefined);
      signal?.throwIfAborted();

      pageCrashed = false;
      page = await context.newPage();
      signal?.throwIfAborted();
      await setupPage(page);
      await page.goto(listingUrl, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      await waitForRenderedPage(page);
    }
    const koreanFontLoaded = platform !== "toomics" || await loadToomicsKoreanFont(page);
    const diagnostics: BrowserListingDiagnostics = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const lowerText = bodyText.toLocaleLowerCase();
      const signalEntries: Array<[name: string, present: boolean]> = [
        ["login", /login|sign in|entrar|conectar/.test(lowerText)],
        ["captcha", /captcha|recaptcha|verifique que eres humano|are you human/.test(lowerText)],
        ["cloudflare", /cloudflare|just a moment|checking your browser/.test(lowerText)],
        ["access-denied", /access denied|forbidden|acesso negado/.test(lowerText)],
      ];
      const signals = signalEntries
        .filter(([, present]) => present)
        .map(([name]) => name);
      const visibleImageCount = Array.from(document.images).filter((image) => {
        const style = getComputedStyle(image);
        const rect = image.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 2 &&
          rect.height > 2;
      }).length;
      return {
        finalUrl: location.href,
        pageTitle: document.title,
        bodyTextLength: bodyText.length,
        visibleImageCount,
        signals,
        authentication: "",
      };
    });
    diagnostics.authentication = authentication;
    if (authenticationFailureStage) diagnostics.authenticationFailureStage = authenticationFailureStage;
    if (authenticationAttempts?.length) diagnostics.authenticationAttempts = authenticationAttempts;
    if (!koreanFontLoaded) diagnostics.signals.push("korean-font-unavailable");
    const candidates = await findRenderedChapters(page, platform);
    const enriched = enrichChapterSubtitles(await page.content(), listingUrl, platform, candidates);

    return {
      candidates: enriched.map(({ box: _box, ...chapter }) => chapter),
      diagnostics,
      async captureGroups(chapterIds, subtitles = [], pairTest = false) {
        signal?.throwIfAborted();
        await applyCaptureSubtitles(page, subtitles);
        const selected = enriched
          .filter((chapter) => chapterIds.includes(chapter.captureId))
          .sort((left, right) => left.captureOrder - right.captureOrder);
        const groups = makeGreedyGroups(
          selected,
          platform === "toomics" ? MAX_TOOMICS_CHAPTERS_PER_IMAGE : undefined,
        );
        const captured: CapturedChapterGroup[] = [];

        for (const group of groups) {
          signal?.throwIfAborted();
          try {
            captured.push({
              chapterNumbers: group.map((chapter) => chapter.number),
              image: await captureGroup(page, group, platform, pairTest),
            });
          } catch (error) {
            if (group.length === 1) throw error;

            // A site can move cards after a lazy load. Splitting only the
            // failing group keeps the normal path economical without losing
            // the fallback for one problematic card.
            const middle = Math.ceil(group.length / 2);
            for (const smallerGroup of [
              group.slice(0, middle),
              group.slice(middle),
            ]) {
              captured.push({
                chapterNumbers: smallerGroup.map((chapter) => chapter.number),
                image: await captureGroup(page, smallerGroup, platform, pairTest),
              });
            }
          }
        }
        return captured;
      },
      async close() {
        signal?.removeEventListener("abort", onAbort);
        await page.close().catch(() => undefined);
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    await page.close().catch(() => undefined);
    // Cancelling a diagnostic must never reset the shared browser.
    signal?.throwIfAborted();
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (pageCrashed || /page crashed|target page, context or browser has been closed/i.test(errorMessage)) {
      await resetBrowserAfterCrash();
      if (retryAfterCrash) {
        return openBrowserListing(listingUrl, platform, false, signal);
      }
    }
    throw error;
  }
}