import { watchFile, unwatchFile } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export function restartWakeup(settings: {
  readonly directory: string;
  readonly milliseconds: number;
  readonly stopping: AbortSignal;
}): {
  readonly wait: () => Promise<boolean>;
  readonly close: () => void;
} {
  let changed = Promise.withResolvers<boolean>();
  const watcher = observed(settings.directory, () => {
    changed.resolve(true);
  });
  return {
    wait: async () => {
      const waiting = changed;
      const completed = new AbortController();
      try {
        return await Promise.race([
          waiting.promise,
          delay(settings.milliseconds, true, {
            signal: AbortSignal.any([settings.stopping, completed.signal]),
          }).catch(() => false),
        ]);
      } finally {
        changed = Promise.withResolvers<boolean>();
        completed.abort();
      }
    },
    close: () => {
      watcher();
      changed.resolve(false);
    },
  };
}

function observed(directory: string, changed: () => void): () => void {
  try {
    watchFile(directory, { interval: 100 }, changed);
    return () => {
      unwatchFile(directory, changed);
    };
  } catch {
    return () => undefined;
  }
}
