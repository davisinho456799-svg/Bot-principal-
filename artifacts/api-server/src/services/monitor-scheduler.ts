import { db } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { monitorConfigTable, monitoredWorksTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import { runMonitor } from "./monitor-service.js";
import { getMonitorIntervalMinutes } from "./monitor-interval.js";
import { getMonitorDelayMs } from "./monitor-schedule.js";

const RETRY_DELAY_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
let enabled = false;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

function isCurrent(currentGeneration: number) {
  return enabled && currentGeneration === generation;
}

async function readSchedule() {
  const [[config], [summary]] = await Promise.all([
    db.select().from(monitorConfigTable).limit(1),
    db.select({
      lastCheckedAt: sql<Date | string | null>`max(${monitoredWorksTable.lastCheckedAt})`,
      activeWorks: sql<number>`count(*)::integer`,
      uncheckedWorks: sql<number>`count(*) filter (where ${monitoredWorksTable.lastCheckedAt} is null)::integer`,
    }).from(monitoredWorksTable).where(eq(monitoredWorksTable.active, true)),
  ]);
  if (!summary) throw new Error("Image monitor schedule summary is missing");
  const intervalMinutes = getMonitorIntervalMinutes(config?.intervalMinutes);
  const delayMs = getMonitorDelayMs(
    summary.uncheckedWorks > 0 ? null : summary.lastCheckedAt,
    intervalMinutes,
  );
  return {
    activeWorks: summary.activeWorks,
    // Empty monitors poll for new works without a zero-delay loop.
    delayMs: summary.activeWorks > 0 ? delayMs : intervalMinutes * 60_000,
  };
}

function armTimer(delayMs: number, currentGeneration: number) {
  if (!isCurrent(currentGeneration)) return;
  if (timer !== undefined) clearTimeout(timer);
  const boundedDelay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs));
  timer = setTimeout(() => {
    timer = undefined;
    void runWhenDue(currentGeneration);
  }, boundedDelay);
  const nextCheck = new Date(Date.now() + boundedDelay);
  logger.info({
    event: "image_monitor_next_check_scheduled",
    nextCheckAt: nextCheck.toISOString(),
    nextCheckBrasilia: nextCheck.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
  }, "Próxima verificação de imagens agendada");
}

async function scheduleNext(currentGeneration: number, minimumDelay = 0): Promise<void> {
  if (!isCurrent(currentGeneration)) return;
  try {
    const schedule = await readSchedule();
    armTimer(Math.max(minimumDelay, schedule.delayMs), currentGeneration);
  } catch (error) {
    if (!isCurrent(currentGeneration)) return;
    logger.error({ err: error }, "Não foi possível consultar o agendamento do monitor de imagens; nova tentativa em 1 minuto");
    armTimer(RETRY_DELAY_MS, currentGeneration);
  }
}

async function runWhenDue(currentGeneration: number): Promise<void> {
  if (!isCurrent(currentGeneration)) return;
  if (running) {
    await scheduleNext(currentGeneration, RETRY_DELAY_MS);
    return;
  }
  try {
    // A manual check or another process may have updated the saved timestamps.
    const schedule = await readSchedule();
    if (!isCurrent(currentGeneration)) return;
    if (schedule.delayMs > 0 || schedule.activeWorks === 0) {
      armTimer(schedule.delayMs, currentGeneration);
      return;
    }
  } catch (error) {
    if (!isCurrent(currentGeneration)) return;
    logger.error({ err: error }, "Falha ao consultar a próxima verificação do monitor de imagens");
    armTimer(RETRY_DELAY_MS, currentGeneration);
    return;
  }

  running = true;
  try {
    await runMonitor();
  } catch (error) {
    logger.error({ err: error }, "Scheduled monitor run failed");
  } finally {
    running = false;
    // Back off if a failed/incomplete check left timestamps unchanged.
    await scheduleNext(currentGeneration, RETRY_DELAY_MS);
  }
}

export async function startMonitorScheduler(): Promise<void> {
  if (enabled) return;
  enabled = true;
  generation++;
  await scheduleNext(generation);
}

export function stopMonitorScheduler(): void {
  enabled = false;
  generation++;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}