import { db } from "@workspace/db";
import { monitorConfigTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import {
  openBrowserListing,
  type BrowserListingSession,
  type ToomicsLoginAttemptDiagnostic,
} from "./browser-chapter-capture";
import type { MonitorPlatform } from "./parsers/index";
import { getActiveNumberedMonitorWorks } from "./monitor-work-list";
import { getMonitorIntervalMinutes } from "./monitor-interval";
import { getMonitorDelayMs } from "./monitor-schedule";
import { monitorExecution, MonitorUnavailableError } from "./monitor-execution";
import { randomUUID } from "node:crypto";

const MINIMUM_FREE_WINDOW_MS = 10 * 60_000;
const MAX_DIAGNOSTIC_MS = 6 * 60_000;

export type WorkDiagnostic = {
  workId: number; number: number; title: string;
  status: "completed" | "empty" | "failed" | "interrupted";
  durationMs: number; lookupMs: number; captureMs: number; cleanupMs: number;
  chaptersFound: number; imageCaptured: boolean;
  browser?: {
    page: string;
    title: string;
    bodyTextLength: number;
    visibleImageCount: number;
    signals: string[];
    authentication: string;
    authenticationFailureStage?: string;
    authenticationAttempts?: ToomicsLoginAttemptDiagnostic[];
  };
  issue?: { stage: "listing" | "capture" | "cleanup"; reason: string };
};

function safeDiagnosticError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const safe = raw
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database-url]")
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(?:bearer|bot)\s+[A-Za-z0-9._-]{8,}/gi, "[redacted-credential]")
    .replace(/\b(authorization|access[-_ ]?token|refresh[-_ ]?token|token|api[-_ ]?(?:key|token)|password|secret|cookie)\s*[:=]\s*[^\s&,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/@(everyone|here)\b/gi, "@\u200b$1")
    .trim()
    .slice(0, 180);
  return safe || "Falha sem detalhe.";
}

function safeAuthenticationStatus(value: string): string {
  const knownStatuses = new Set([
    "não aplicável",
    "credenciais não configuradas",
    "formulário de login não encontrado",
    "botão de login não encontrado",
    "captcha ou verificação manual necessária",
    "login rejeitado",
    "login concluído",
  ]);
  if (knownStatuses.has(value)) return value;
  if (value.startsWith("erro no login")) {
    const rawDetail = value.slice("erro no login".length);
    const detail = rawDetail.toLowerCase();
    const errorName = rawDetail.match(/^\s*\(?\s*\[([a-z][a-z0-9]{0,39})\]/i)?.[1];
    if (/page crashed|browser crashed|browser has crashed/.test(detail)) {
      return "erro técnico no login (navegador travou)";
    }
    if (/target page.*closed|page has been closed|context.*closed|browser has been closed/.test(detail)) {
      return "erro técnico no login (página fechada)";
    }
    if (/timeout|timed out|exceeded/.test(detail)) {
      return "erro técnico no login (tempo esgotado)";
    }
    if (/net::err_|enotfound|econn|network|socket/.test(detail)) {
      return "erro técnico no login (falha de rede)";
    }
    if (/execution context was destroyed|frame.*detached|navigation interrupted/.test(detail)) {
      return "erro técnico no login (navegação interrompida)";
    }
    if (/locator|selector|fill|click|editable|pointer events/.test(detail)) {
      return "erro técnico no login (campo ou botão)";
    }
    if (errorName === "ReferenceError") {
      const missingSymbol = rawDetail.match(
        /\[ReferenceError\]\s*\(\s*(?:([A-Za-z_$][A-Za-z0-9_$]{0,59})\s+is not defined|Can't find variable:\s*([A-Za-z_$][A-Za-z0-9_$]{0,59})|Cannot access ['"]([A-Za-z_$][A-Za-z0-9_$]{0,59})['"] before initialization)/i,
      );
      const symbol = missingSymbol?.[1] ?? missingSymbol?.[2] ?? missingSymbol?.[3];
      if (symbol && !/(token|secret|password|passwd|pwd|email|credential|api.?key|private.?key|signing.?key|cookie|authorization|bearer)/i.test(symbol)) {
        return `erro técnico no login (símbolo ${symbol} não definido)`;
      }
    }
    if (errorName && errorName !== "UnknownError") {
      return errorName === "Error"
        ? "erro técnico no login (erro genérico)"
        : `erro técnico no login (tipo ${errorName})`;
    }
    return "erro técnico no login (causa não classificada)";
  }
  return "estado de autenticação desconhecido";
}

function safePageLabel(finalUrl: string): string {
  try {
    const url = new URL(finalUrl);
    return `${url.hostname}${url.pathname}`.slice(0, 160);
  } catch {
    return "página desconhecida";
  }
}

function safeBrowserTitle(title: string): string {
  return safeDiagnosticError(title).slice(0, 100);
}

function formatBrowserSummary(browser?: WorkDiagnostic["browser"]): string {
  if (!browser) return "";
  const signals = browser.signals.length ? `; sinais=${browser.signals.join(", ")}` : "";
  const loginFailureStage = browser.authenticationFailureStage
    ? `; etapa-login=${browser.authenticationFailureStage}`
    : "";
  const attempts = browser.authenticationAttempts?.length
    ? `\n  Tentativas de login: ${browser.authenticationAttempts.map(attempt => `${attempt.page} [HTTP ${attempt.httpStatus ?? "?"}; links=${attempt.loginLinks}; clique=${attempt.loginClicked ? "sim" : "não"}${attempt.loginClickError ? `; erro-clique=${attempt.loginClickError}` : ""}; email=${attempt.emailFields}; senha=${attempt.passwordFields}; quadros=${attempt.frames}${attempt.signals.length ? `; sinais=${attempt.signals.join(", ")}` : ""}]`).join(" · ")}`
    : "";
  return `\n  Navegador: página=${browser.page}; título="${browser.title || "sem título"}"; autenticação=${browser.authentication}${loginFailureStage}; imagens=${browser.visibleImageCount}; texto=${browser.bodyTextLength} caracteres${signals}${attempts}`;
}

/** Read-only sampling: one browser card per work; no notification or DB writes. */
export async function runMonitorDiagnostic(workId?: number) {
  return monitorExecution.runDiagnostic(async prioritySignal => {
    const roundId = randomUUID();
    const started = performance.now();
    const works = await getActiveNumberedMonitorWorks();
    const [config] = await db.select().from(monitorConfigTable).limit(1);
    const lastCheck = works.some(w => !w.lastCheckedAt) ? null
      : works.reduce<Date | null>((latest, w) =>
        w.lastCheckedAt && (!latest || w.lastCheckedAt > latest) ? w.lastCheckedAt : latest, null);
    const nextDelay = getMonitorDelayMs(lastCheck, getMonitorIntervalMinutes(config?.intervalMinutes));
    const selected = workId === undefined ? works : works.filter(w => w.id === workId);
    if (workId !== undefined && !selected.length) throw new MonitorUnavailableError("A obra selecionada não está mais ativa.");
    if (selected.length && nextDelay < MINIMUM_FREE_WINDOW_MS) {
      throw new MonitorUnavailableError("A rodada automática está próxima ou pendente. Execute o diagnóstico depois dela para preservar seu horário.");
    }
    const signal = AbortSignal.any([prioritySignal, AbortSignal.timeout(MAX_DIAGNOSTIC_MS)]);
    const deadline = performance.now() + MAX_DIAGNOSTIC_MS;
    const isInterrupted = () => signal.aborted || performance.now() >= deadline;
    const ensureWithinDeadline = () => {
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("Monitor diagnostic time limit reached");
    };
    const results: WorkDiagnostic[] = [];
    let previewImage: Buffer | undefined;
    logger.info({ event: "image_monitor_diagnostic_started", roundId, works: selected.length }, "Diagnóstico de imagens iniciado (somente leitura)");
    for (const work of selected) {
      if (isInterrupted()) break;
      const workStarted = performance.now();
      let session: BrowserListingSession | undefined;
      const row: WorkDiagnostic = {
        workId: work.id, number: work.displayNumber, title: work.title, status: "completed",
        durationMs: 0, lookupMs: 0, captureMs: 0, cleanupMs: 0,
        chaptersFound: 0, imageCaptured: false,
      };
      let phaseStarted = performance.now();
      let phase: "listing" | "capture" = "listing";
      try {
        session = await openBrowserListing(work.listingUrl, work.platform as MonitorPlatform, true, signal);
        ensureWithinDeadline();
        row.lookupMs = Math.round(performance.now() - phaseStarted);
        if (session.diagnostics) {
          row.browser = {
            page: safePageLabel(session.diagnostics.finalUrl),
            title: safeBrowserTitle(session.diagnostics.pageTitle),
            bodyTextLength: session.diagnostics.bodyTextLength,
            visibleImageCount: session.diagnostics.visibleImageCount,
            signals: session.diagnostics.signals.filter(signal =>
              ["login", "captcha", "cloudflare", "access-denied", "korean-font-unavailable"].includes(signal),
            ),
            authentication: safeAuthenticationStatus(session.diagnostics.authentication),
            ...(session.diagnostics.authenticationFailureStage
              ? { authenticationFailureStage: session.diagnostics.authenticationFailureStage }
              : {}),
            authenticationAttempts: session.diagnostics.authenticationAttempts,
          };
        }
        row.chaptersFound = session.candidates.length;
        const sample = session.candidates[0];
        if (sample) {
          phase = "capture";
          phaseStarted = performance.now();
          const captured = await session.captureGroups(
            [sample.captureId],
            [],
            work.platform === "toptoon",
          );
          ensureWithinDeadline();
          row.captureMs = Math.round(performance.now() - phaseStarted);
          row.imageCaptured = captured.some(group => group.image.length > 0);
          if (workId !== undefined) {
            previewImage = captured.find(group => group.image.length > 0)?.image;
          }
          if (!row.imageCaptured) {
            row.status = "failed";
            row.issue = { stage: "capture", reason: "A captura não retornou uma imagem." };
          }
        } else {
          row.status = "empty";
          row.issue = { stage: "listing", reason: "A listagem não encontrou capítulos utilizáveis." };
        }
      } catch (error) {
        row[phase === "listing" ? "lookupMs" : "captureMs"] = Math.round(performance.now() - phaseStarted);
        row.status = isInterrupted() ? "interrupted" : "failed";
        if (!isInterrupted()) row.issue = { stage: phase, reason: safeDiagnosticError(error) };
      } finally {
        const cleanupStarted = performance.now();
        try { await session?.close(); }
        catch (error) {
          if (!signal.aborted) {
            row.status = "failed";
            row.issue ??= { stage: "cleanup", reason: safeDiagnosticError(error) };
          }
        }
        row.cleanupMs = Math.round(performance.now() - cleanupStarted);
        row.durationMs = Math.round(performance.now() - workStarted);
        results.push(row);
        logger.info({ event: "image_monitor_diagnostic_work_completed", roundId, ...row }, "Tempo de diagnóstico por obra");
      }
    }
    const report = {
      roundId, status: isInterrupted() ? "interrupted" : results.some(r => r.status === "failed") ? "partial" : "completed",
      durationMs: Math.round(performance.now() - started),
      worksSkipped: selected.length - results.length,
      results: results.sort((a, b) => b.durationMs - a.durationMs),
      ...(previewImage ? { previewImage } : {}),
    };
    logger.info({ event: "image_monitor_diagnostic_completed", ...report, results: undefined, previewImage: undefined }, "Diagnóstico de imagens concluído (sem publicações)");
    return report;
  });
}

export function formatMonitorDiagnostic(report: Awaited<ReturnType<typeof runMonitorDiagnostic>>) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  const status = { completed: "ok", empty: "sem capítulos", failed: "falha", interrupted: "interrompida" };
  const stage = { listing: "listagem", capture: "captura", cleanup: "fechamento" };
  return [
    "**Diagnóstico — da obra mais lenta para a mais rápida**",
    "Consulta pelo navegador + captura do formato usado pelo monitor (Toptoon: imagens 2 e 3; demais: miniatura principal). Sem envio ao canal, fallback HTML ou alteração do banco/agendamento.",
    ...report.results.map(w => `Nº ${w.number} — ${w.title.replace(/[\r\n]/g, " ")}: **${seconds(w.durationMs)}** (${status[w.status]})\n  Consulta: ${seconds(w.lookupMs)} · captura: ${seconds(w.captureMs)} · fechamento: ${seconds(w.cleanupMs)} · capítulos: ${w.chaptersFound}${formatBrowserSummary(w.browser)}${w.issue ? `\n  Etapa: ${stage[w.issue.stage]} · motivo: ${w.issue.reason}` : ""}`),
    `Total: ${seconds(report.durationMs)} · não verificadas: ${report.worksSkipped}`,
    report.status === "interrupted" ? "Diagnóstico interrompido pelo limite de tempo ou para dar prioridade à verificação normal." : "",
  ].filter(Boolean).join("\n");
}