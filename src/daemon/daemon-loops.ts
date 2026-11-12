import type { scheduleConnection } from "./schedule-control.ts";
import type { queueConnection } from "./queue-control.ts";
import { workflowSchedules } from "./workflow-schedules.ts";
import { issueQueue } from "./issue-queue.ts";
import { notifyRuns } from "./notify.ts";
import type { HostSignals, QueueLimits } from "../queue-room.ts";
import { workspacePermits } from "../cli/workspace-permit.ts";
import type { QueueSource } from "../queue-settings.ts";
import { queueDirectory } from "./queue-journal.ts";
import { queueConfiguration, type QueueConfiguration } from "./queue-limits.ts";
import { queueOffPort } from "./queue-control.ts";

interface LoopSettings extends ParametersOfSchedules {
  readonly scheduleConnection?: ReturnType<typeof scheduleConnection>;
  readonly queueConnection?: ReturnType<typeof queueConnection>;
  readonly notifyCommand?: readonly string[];
  readonly notifyMilliseconds?: number;
  readonly queueMilliseconds?: number;
  readonly queueIntervalSource?: QueueSource;
  readonly queueState?: "off";
  readonly queueLimits?: QueueLimits;
  readonly queueLanes?: number;
  readonly limits: (workflowId?: string) => QueueLimits;
  readonly queueConfigurations?: Readonly<Record<string, QueueConfiguration>>;
  readonly hostSignals?: () => Promise<HostSignals>;
  readonly readyCommand?: readonly string[];
  readonly workspacePermits?: string;
  readonly resetQueue?: boolean;
  readonly queueWorkflowIds: readonly string[];
}

type ParametersOfSchedules = Parameters<typeof workflowSchedules>[0];

function queueAdapters(settings: LoopSettings) {
  return {
    ...(settings.hostSignals === undefined
      ? {}
      : { signals: settings.hostSignals }),
    ...(settings.readyCommand === undefined
      ? {}
      : { readyCommand: settings.readyCommand }),
    ...(settings.workspacePermits === undefined
      ? {}
      : { permit: workspacePermits(settings.workspacePermits) }),
  };
}

async function startedQueue(
  settings: LoopSettings,
  workflowId: string,
): Promise<ReturnType<typeof issueQueue> | undefined> {
  const configuration = queueConfiguration(settings, workflowId);
  if (configuration?.state === "off") {
    settings.queueConnection?.connect(queueOffPort(workflowId), workflowId);
    return undefined;
  }
  const intervalMilliseconds = configuration?.intervalMilliseconds;
  if (intervalMilliseconds === undefined) return undefined;
  const queue = issueQueue({
    directory: settings.directory,
    queueDirectory: await queueDirectory(settings.directory, {
      workflowId,
      migrate: settings.queueWorkflowIds.length === 1,
    }),
    runtimeDirectory: settings.runtimeDirectory,
    intervalMilliseconds,
    ...(configuration?.intervalSource === undefined
      ? {}
      : { intervalSource: configuration.intervalSource }),
    limits: () => settings.limits(workflowId),
    ...queueAdapters(settings),
    resetQueue: settings.resetQueue ?? false,
    workflowId,
  });
  settings.queueConnection?.connect(queue.port, workflowId);
  await queue.ready;
  return queue;
}

export async function daemonLoops(
  settings: LoopSettings,
): Promise<{ readonly stop: () => Promise<void> }> {
  const schedules = await workflowSchedules(settings);
  settings.scheduleConnection?.connect(schedules.request);
  try {
    const notifier =
      settings.notifyCommand === undefined
        ? undefined
        : await notifyRuns({
            directory: settings.directory,
            runtimeDirectory: settings.runtimeDirectory,
            command: settings.notifyCommand,
            ...(settings.notifyMilliseconds === undefined
              ? {}
              : { intervalMilliseconds: settings.notifyMilliseconds }),
          });
    const queues: ReturnType<typeof issueQueue>[] = [];
    for (const workflowId of settings.queueWorkflowIds) {
      const queue = await startedQueue(settings, workflowId);
      if (queue !== undefined) queues.push(queue);
    }
    return {
      stop: async () => {
        await schedules.stop();
        await notifier?.stop();
        await Promise.all(queues.map((queue) => queue.stop()));
      },
    };
  } catch (error) {
    await schedules.stop();
    throw error;
  }
}
