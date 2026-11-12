import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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
  settings: LoopSettings & { readonly resumeQueue: boolean },
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
    resumeQueue: settings.resumeQueue,
    workflowId,
  });
  settings.queueConnection?.connect(queue.port, workflowId);
  await queue.ready;
  return queue;
}

async function resumeRequested(directory: string): Promise<boolean> {
  return readFile(join(directory, "resume-queue")).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    },
  );
}

export async function daemonLoops(
  settings: LoopSettings,
): Promise<{ readonly stop: () => Promise<void> }> {
  const schedules = await workflowSchedules(settings);
  settings.scheduleConnection?.connect(schedules.request);
  const queues: ReturnType<typeof issueQueue>[] = [];
  let notifier: Awaited<ReturnType<typeof notifyRuns>> | undefined;
  const stop = async () => {
    await Promise.all([
      schedules.stop(),
      notifier?.stop(),
      ...queues.map((queue) => queue.stop()),
    ]);
  };
  try {
    notifier =
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
    const resumeQueue = await resumeRequested(settings.directory);
    await rm(join(settings.directory, "queue-submission"), { force: true });
    for (const workflowId of settings.queueWorkflowIds) {
      const queue = await startedQueue(
        { ...settings, resumeQueue },
        workflowId,
      );
      if (queue !== undefined) queues.push(queue);
    }
    if (resumeQueue)
      await rm(join(settings.directory, "resume-queue"), { force: true });
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
