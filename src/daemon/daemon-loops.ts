import { workflowSchedules } from "./workflow-schedules.ts";
import { issueQueue } from "./issue-queue.ts";
import { notifyRuns } from "./notify.ts";

interface LoopSettings extends ParametersOfSchedules {
  readonly notifyCommand?: readonly string[];
  readonly notifyMilliseconds?: number;
  readonly queueMilliseconds?: number;
  readonly queueLanes?: number;
  readonly resetQueue?: boolean;
  readonly queueWorkflowId: string | undefined;
}

type ParametersOfSchedules = Parameters<typeof workflowSchedules>[0];

export async function daemonLoops(
  settings: LoopSettings,
): Promise<{ readonly stop: () => Promise<void> }> {
  const schedules = await workflowSchedules(settings);
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
    const queue =
      settings.queueMilliseconds === undefined ||
      settings.queueWorkflowId === undefined
        ? undefined
        : issueQueue({
            directory: settings.directory,
            runtimeDirectory: settings.runtimeDirectory,
            intervalMilliseconds: settings.queueMilliseconds,
            lanes: settings.queueLanes ?? 1,
            resetQueue: settings.resetQueue ?? false,
            workflowId: settings.queueWorkflowId,
          });
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
