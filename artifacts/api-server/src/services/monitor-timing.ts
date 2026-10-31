import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";

type TimingLog = { info(fields: Record<string, unknown>, message: string): void };
type TimingOptions = { log?: TimingLog; now?: () => number; roundId?: string };
export type ImageMonitorTiming = {
  startWork(workId: number, title: string): {
    fail(error: unknown): void;
    finish(): void;
  };
};

/** Measure elapsed time with a monotonic clock, including browser cleanup. */
export async function measureImageMonitorRound<T>(
  operation: (timing: ImageMonitorTiming) => Promise<T>,
  { log = logger, now = () => performance.now(), roundId = randomUUID() }: TimingOptions = {},
): Promise<T> {
  const started = now();
  const context = { monitorType: "image", roundId };
  let worksChecked = 0;
  let worksFailed = 0;
  let failed = false;
  const duration = (since: number) => {
    const durationMs = Math.max(0, Math.round(now() - since));
    return { durationMs, durationSeconds: durationMs / 1000 };
  };
  log.info({ ...context, event: "image_monitor_round_started" }, "Verificação do monitor de imagens iniciada");
  const timing: ImageMonitorTiming = {
    startWork(workId, title) {
      const workStarted = now();
      let errorName: string | undefined;
      let workFailed = false;
      let finished = false;
      const work = { ...context, workId, title };
      log.info({ ...work, event: "image_monitor_work_started" }, "Verificação de obra do monitor de imagens iniciada");
      return {
        fail(error) {
          workFailed = true;
          const name = error instanceof Error ? error.name : "Error";
          errorName = /^[\w.-]{1,100}$/.test(name) ? name : "Error";
        },
        finish() {
          if (finished) return;
          finished = true;
          worksChecked++;
          if (workFailed) worksFailed++;
          log.info({
            ...work, event: "image_monitor_work_completed",
            status: workFailed ? "failed" : "completed", errorName,
            ...duration(workStarted),
          }, "Verificação de obra do monitor de imagens concluída");
        },
      };
    },
  };
  try {
    return await operation(timing);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    log.info({
      ...context, event: "image_monitor_round_completed",
      status: failed ? "failed" : worksFailed ? "partial" : "completed",
      worksChecked, worksFailed, ...duration(started),
    }, "Verificação do monitor de imagens concluída");
  }
}