import type { scheduleConnection } from "./schedule-control.ts";
import type { queueConnection } from "./queue-control.ts";
import { workflowSchedules } from "./workflow-schedules.ts";
import { issueQueue } from "./issue-queue.ts";
import { notifyRuns } from "./notify.ts";
import type { HostSignals, QueueLimits } from "../queue-room.ts";
import { workspacePermits } from "../cli/workspace-permit.ts";
import type { QueueSource } from "../queue-settings.ts";
import { queueOffPort } from "./queue-control.ts";

interface LoopSettings extends ParametersOfSchedules {
  readonly scheduleConnection?: ReturnType<typeof scheduleConnection>;
  readonly queueConnection?: ReturnType<typeof queueConnection>;
  readonly notifyCommand?: readonly string[];
  readonly notifyMilliseconds?: number;
  readonly queueMilliseconds?: number;
  readonly queueIntervalSource?: QueueSource;
  readonly queueState?: "off";
  readonly queueLimits: () => QueueLimits;
  readonly hostSignals?: () => Promise<HostSignals>;
  readonly readyCommand?: readonly string[];
  readonly workspacePermits?: string;
  readonly resetQueue?: boolean;
  readonly queueWorkflowId: string | undefined;
}

type ParametersOfSchedules = Parameters<typeof workflowSchedules>[0];

function offQueue(settings: LoopSettings): void {
  const workflowId = settings.queueWorkflowId;
  if (workflowId !== undefined && settings.queueState === "off")
    settings.queueConnection?.connect(queueOffPort(workflowId));
}

function intervalSource(settings: LoopSettings) {
  return settings.queueIntervalSource === undefined
    ? {}
    : { intervalSource: settings.queueIntervalSource };
}

async function startedQueue(
  settings: LoopSettings,
): Promise<ReturnType<typeof issueQueue> | undefined> {
  offQueue(settings);
  const workflowId = settings.queueWorkflowId;
  if (settings.queueMilliseconds === undefined || workflowId === undefined)
    return undefined;
  const queue = issueQueue({
    directory: settings.directory,
    runtimeDirectory: settings.runtimeDirectory,
    intervalMilliseconds: settings.queueMilliseconds,
    ...intervalSource(settings),
    limits: settings.queueLimits,
    ...(settings.hostSignals === undefined
      ? {}
      : { signals: settings.hostSignals }),
    resetQueue: settings.resetQueue ?? false,
    ...(settings.readyCommand === undefined
      ? {}
      : { readyCommand: settings.readyCommand }),
    ...(settings.workspacePermits === undefined
      ? {}
      : { permit: workspacePermits(settings.workspacePermits) }),
    workflowId,
  });
  settings.queueConnection?.connect(queue.port);
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
    const queue = await startedQueue(settings);
    return {
      stop: async () => {
        await schedules.stop();
        await notifier?.stop();
        await queue?.stop();
      },
    };
  } catch (error) {
    await schedules.stop();
    throw error;
  }
}
