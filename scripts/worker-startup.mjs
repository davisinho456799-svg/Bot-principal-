import { safeBuildEvent } from "./worker-build-history.mjs";

/** Optional recovery must never prevent the required worker from loading. */
export async function startWorker({ history, validate, load, prepare, warn = console.warn }) {
  await history.phase("validate.worker-cache", validate);
  await history.phase("load.worker-module", load);
  const optional = Promise.resolve().then(async () => {
    try { await history.phase("prepare.optional-monitors", prepare); }
    catch (error) {
      await history.record({ phase: "prepare.optional-monitors", status: "degraded", code: error.code, errorName: error.name });
      warn("Optional monitor preparation failed; Discord remains running:", JSON.stringify(safeBuildEvent({ code: error.code, errorName: error.name })));
    }
  });
  return { optional };
}