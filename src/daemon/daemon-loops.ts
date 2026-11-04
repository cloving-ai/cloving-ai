import type { scheduleConnection } from "./schedule-control.ts";
import type { queueConnection } from "./queue-control.ts";
import { workflowSchedules } from "./workflow-schedules.ts";
import { issueQueue } from "./issue-queue.ts";
import { notifyRuns } from "./notify.ts";

interface LoopSettings extends ParametersOfSchedules {
  readonly scheduleConnection?: ReturnType<typeof scheduleConnection>;
  readonly queueConnection?: ReturnType<typeof queueConnection>;
  readonly notifyCommand?: readonly string[];
  readonly notifyMilliseconds?: number;
  readonly queueMilliseconds?: number;
  readonly queueLanes?: number;
  readonly readyCommand?: readonly string[];
  readonly resetQueue?: boolean;
  readonly queueWorkflowId: string | undefined;
}

type ParametersOfSchedules = Parameters<typeof workflowSchedules>[0];

async function startedQueue(
  settings: LoopSettings,
): Promise<ReturnType<typeof issueQueue> | undefined> {
  if (
    settings.queueMilliseconds === undefined ||
    settings.queueWorkflowId === undefined
  )
    return undefined;
  const queue = issueQueue({
    directory: settings.directory,
    runtimeDirectory: settings.runtimeDirectory,
    intervalMilliseconds: settings.queueMilliseconds,
    lanes: settings.queueLanes ?? 1,
    resetQueue: settings.resetQueue ?? false,
    ...(settings.readyCommand === undefined
      ? {}
      : { readyCommand: settings.readyCommand }),
    workflowId: settings.queueWorkflowId,
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
