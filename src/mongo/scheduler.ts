/**
 * Scheduler: run MongoDB sync (import + charts) on an interval.
 * Default: every 2 hours. Set SYNC_INTERVAL_HOURS in .env to override.
 * Run once immediately on start, then every N hours.
 */
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_INTERVAL_HOURS = 2;
const intervalHours = Math.max(
  0.25,
  Number(process.env.SYNC_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS
);
const intervalMs = Math.round(intervalHours * 60 * 60 * 1000);

async function sync(): Promise<void> {
  const start = Date.now();
  console.log(`[SYNC] Starting at ${new Date().toISOString()}`);
  try {
    const { run: runImport } = await import("./import-job");
    await runImport();
    const { run: runSnapshots } = await import("./snapshots-job");
    await runSnapshots();
    const { run: runCharts } = await import("./charts-job");
    await runCharts();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[SYNC] Completed in ${elapsed}s`);
  } catch (e) {
    console.error("[SYNC] Error:", e);
  }
}

async function main(): Promise<void> {
  console.log(`[SCHEDULER] Sync every ${intervalHours}h (${intervalMs}ms)`);
  await sync();
  setInterval(sync, intervalMs);
  console.log("[SCHEDULER] Next run in", intervalHours, "hour(s).");
}

main().catch((e) => {
  console.error("[SCHEDULER] Fatal:", e);
  process.exit(1);
});
