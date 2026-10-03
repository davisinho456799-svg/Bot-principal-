import { db } from "@workspace/db";
import { monitorConfigTable } from "@workspace/db/schema";
import { logger } from "../lib/logger";
import { openBrowserListing, type BrowserListingSession } from "./browser-chapter-capture";
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
};

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
    const results: WorkDiagnostic[] = [];
    logger.info({ event: "image_monitor_diagnostic_started", roundId, works: selected.length }, "Diagnóstico de imagens iniciado (somente leitura)");
    for (const work of selected) {
      if (signal.aborted) break;
      const workStarted = performance.now();
      let session: BrowserListingSession | undefined;
      const row: WorkDiagnostic = {
        workId: work.id, number: work.displayNumber, title: work.title, status: "completed",
        durationMs: 0, lookupMs: 0, captureMs: 0, cleanupMs: 0,
        chaptersFound: 0, imageCaptured: false,
      };
      let phaseStarted = performance.now();
      let phase: "lookupMs" | "captureMs" = "lookupMs";
      try {
        session = await openBrowserListing(work.listingUrl, work.platform as MonitorPlatform, true, signal);
        signal.throwIfAborted();
        row.lookupMs = Math.round(performance.now() - phaseStarted);
        row.chaptersFound = session.candidates.length;
        const sample = session.candidates[0];
        if (sample) {
          phase = "captureMs";
          phaseStarted = performance.now();
          const captured = await session.captureGroups([sample.captureId]);
          signal.throwIfAborted();
          row.captureMs = Math.round(performance.now() - phaseStarted);
          row.imageCaptured = captured.some(group => group.image.length > 0);
          if (!row.imageCaptured) row.status = "failed";
        } else {
          row.status = "empty";
        }
      } catch {
        row[phase] = Math.round(performance.now() - phaseStarted);
        row.status = signal.aborted ? "interrupted" : "failed";
      } finally {
        const cleanupStarted = performance.now();
        try { await session?.close(); }
        catch { if (!signal.aborted) row.status = "failed"; }
        row.cleanupMs = Math.round(performance.now() - cleanupStarted);
        row.durationMs = Math.round(performance.now() - workStarted);
        results.push(row);
        logger.info({ event: "image_monitor_diagnostic_work_completed", roundId, ...row }, "Tempo de diagnóstico por obra");
      }
    }
    const report = {
      roundId, status: signal.aborted ? "interrupted" : results.some(r => r.status === "failed") ? "partial" : "completed",
      durationMs: Math.round(performance.now() - started),
      worksSkipped: selected.length - results.length,
      results: results.sort((a, b) => b.durationMs - a.durationMs),
    };
    logger.info({ event: "image_monitor_diagnostic_completed", ...report, results: undefined }, "Diagnóstico de imagens concluído (sem publicações)");
    return report;
  });
}

export function formatMonitorDiagnostic(report: Awaited<ReturnType<typeof runMonitorDiagnostic>>) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  const status = { completed: "ok", empty: "sem capítulos", failed: "falha", interrupted: "interrompida" };
  return [
    "**Diagnóstico — da obra mais lenta para a mais rápida**",
    "Consulta pelo navegador + captura de 1 card por obra. Sem envio ao canal, fallback HTML ou alteração do banco/agendamento.",
    ...report.results.map(w => `Nº ${w.number} — ${w.title.replace(/[\r\n]/g, " ")}: **${seconds(w.durationMs)}** (${status[w.status]})\n  Consulta: ${seconds(w.lookupMs)} · captura: ${seconds(w.captureMs)} · fechamento: ${seconds(w.cleanupMs)} · capítulos: ${w.chaptersFound}`),
    `Total: ${seconds(report.durationMs)} · não verificadas: ${report.worksSkipped}`,
    report.status === "interrupted" ? "Diagnóstico interrompido pelo limite de tempo ou para dar prioridade à verificação normal." : "",
  ].filter(Boolean).join("\n");
}