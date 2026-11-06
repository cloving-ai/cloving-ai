import type { DaemonSettings } from "./daemon-adapters.ts";
import { scheduleConnection } from "./schedule-control.ts";
import { queueConnection } from "./queue-control.ts";
import { restartMarks } from "./restart-marks.ts";
import type { RestartPort } from "../restart-request.ts";
import { currentBundle, type CurrentBundle } from "./bundle-sweep.ts";
import { threadPoolWatch, type ThreadPoolWatch } from "../cli/thread-pool.ts";
import { stalledLine } from "../thread-pool-check.ts";
import { queueLimitsSource, type QueueLimitsSource } from "./queue-limits.ts";

export function controlConnections(settings: DaemonSettings): {
  readonly schedules: ReturnType<typeof scheduleConnection>;
  readonly queues: ReturnType<typeof queueConnection>;
  readonly current: CurrentBundle;
  readonly pool: ThreadPoolWatch;
  readonly restart: RestartPort;
  readonly queueLimitSource: QueueLimitsSource;
} {
  return {
    restart: restartMarks(settings.directory),
    queueLimitSource: queueLimitsSource(settings),
    schedules: scheduleConnection(),
    queues: queueConnection(),
    pool: threadPoolWatch({
      ...settings.threadPool,
      stalled: (check) => {
        process.stderr.write(stalledLine(check));
      },
    }),
    current: currentBundle({
      directory: settings.directory,
      bundleDigest: settings.bundleDigest,
      now: settings.retentionClock ?? Date.now,
      log: (line) => process.stderr.write(line),
    }),
  };
}

export function controlPorts(controls: ReturnType<typeof controlConnections>) {
  return {
    schedule: controls.schedules.request,
    queue: controls.queues.port,
    threadPool: controls.pool.latest,
    restart: controls.restart,
  };
}
