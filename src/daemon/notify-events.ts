import { alertScan, type RunCache } from "../cli/alert-reads.ts";
import { notifyEvent, type NotifyEvent } from "./notify-message.ts";

export type OutcomeCache = RunCache;

export async function notificationEvents(
  runtimeDirectory: string,
  cache: OutcomeCache,
): Promise<readonly NotifyEvent[]> {
  return (await alertScan(runtimeDirectory, cache)).map(notifyEvent);
}
