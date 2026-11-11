import { runScan, scheduleAlerts, type RunCache } from "../cli/alert-reads.ts";
import { notifyEvent, type NotifyEvent } from "./notify-message.ts";

export type OutcomeCache = RunCache;

export async function notificationEvents(
  runtimeDirectory: string,
  cache: OutcomeCache,
): Promise<readonly NotifyEvent[]> {
  const runs = await runScan(runtimeDirectory, cache);
  return [...runs, ...(await scheduleAlerts(runtimeDirectory))].map((alert) =>
    notifyEvent(alert),
  );
}
