// Discloud entrypoint for the compiled Discord worker.
// Defaults are intentionally lightweight for a single 4 GB deployment.
process.env.NODE_ENV ??= "production";
process.env.DISCORD_LIGHT_MODE ??= "true";
process.env.MONITOR_INTERVAL_MINUTES ??= "60";
process.env.PLAYWRIGHT_EXECUTABLE_PATH ??= "/usr/bin/chromium";

import("./artifacts/api-server/dist/index.mjs").catch((error) => {
  console.error("Failed to start the compiled Discord worker:", error);
  process.exitCode = 1;
});