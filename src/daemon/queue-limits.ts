import { changeConfigFile } from "../cli/config-file.ts";
import { privateSettingsPath } from "../cli/project-settings.ts";
export type { QueueConfiguration } from "../queue-room.ts";
import {
  maximumQueueLanes,
  type QueueLimits,
  type QueueConfiguration,
} from "../queue-room.ts";
import { declaredQueueValues, type QueueSource } from "../queue-settings.ts";
import {
  declaresQueue,
  type DeclaredWorkflow,
} from "../workflow-declaration.ts";

export interface QueueLimitsSource {
  readonly current: (workflowId?: string) => QueueLimits;
  readonly replace: (
    next: QueueLimits,
    queues?: Readonly<Record<string, QueueLimits>>,
  ) => void;
}

export interface QueueSettings {
  readonly queueLanes?: number;
  readonly queueLimits?: QueueLimits;
  readonly declarations?: readonly DeclaredWorkflow[];
  readonly queueConfigurations?: Readonly<Record<string, QueueConfiguration>>;
  readonly queueMilliseconds?: number;
  readonly queueIntervalSource?: QueueSource;
  readonly queueState?: "off";
}

export function queueConfiguration(
  settings: QueueSettings,
  workflowId: string,
): QueueConfiguration | undefined {
  if (settings.queueConfigurations !== undefined)
    return settings.queueConfigurations[workflowId];
  const declaration = settings.declarations?.find(
    (row) => row.workflowId === workflowId,
  );
  if (declaration === undefined || !declaresQueue(declaration.queue))
    return undefined;
  return legacyConfiguration(settings, declaration);
}

function legacyConfiguration(
  settings: QueueSettings,
  declaration: DeclaredWorkflow,
): QueueConfiguration {
  const lanes =
    settings.queueLanes ?? declaredQueueValues(declaration).lanes ?? 1;
  return {
    limits: settings.queueLimits ?? { lanes, workingLanes: lanes },
    ...(settings.queueMilliseconds === undefined
      ? {}
      : { intervalMilliseconds: settings.queueMilliseconds }),
    ...(settings.queueIntervalSource === undefined
      ? {}
      : { intervalSource: settings.queueIntervalSource }),
    ...(settings.queueState === undefined
      ? {}
      : { state: settings.queueState }),
  };
}

function aggregate(
  current: QueueLimits,
  queues: readonly QueueLimits[],
): QueueLimits {
  if (queues.length === 0) return current;
  return {
    ...current,
    lanes: Math.min(
      maximumQueueLanes,
      queues.reduce((total, limits) => total + limits.lanes, 0),
    ),
    workingLanes: Math.min(
      maximumQueueLanes,
      queues.reduce((total, limits) => total + limits.workingLanes, 0),
    ),
  };
}

export function queueLimitsSource(settings: QueueSettings): QueueLimitsSource {
  const lanes = settings.queueLanes ?? 1;
  let current = settings.queueLimits ?? { lanes, workingLanes: lanes };
  let queues = Object.fromEntries(
    (settings.declarations ?? []).flatMap((row) => {
      const configuration = queueConfiguration(settings, row.workflowId);
      return configuration === undefined
        ? []
        : [[row.workflowId, configuration.limits]];
    }),
  );
  return {
    current: (workflowId) =>
      workflowId === undefined
        ? aggregate(
            current,
            Object.entries(queues)
              .filter(
                ([id]) => queueConfiguration(settings, id)?.state !== "off",
              )
              .map(([, limits]) => limits),
          )
        : (queues[workflowId] ?? current),
    replace: (next, replacements) => {
      current = next;
      queues =
        replacements === undefined
          ? Object.fromEntries(Object.keys(queues).map((id) => [id, next]))
          : { ...queues, ...replacements };
    },
  };
}

export function queueLaneWriter(
  settings: { readonly repository: string },
  source: QueueLimitsSource,
): (workflowId: string, lanes: number) => Promise<void> {
  return async (workflowId, lanes) => {
    const previous = source.current(workflowId);
    const workingSource = previous.sources?.workingLanes ?? "default";
    const workingLanes =
      workingSource === "default" ? lanes : previous.workingLanes;
    if (workingLanes > lanes) throw new Error("invalid-queue-working-lanes");
    await changeConfigFile(
      privateSettingsPath(process.env, settings.repository),
      {
        scope: "private",
        queueLanes: { workflowId, lanes },
      },
    );
    source.replace(source.current(), {
      [workflowId]: {
        ...source.current(workflowId),
        lanes,
        workingLanes,
        sources: {
          lanes: "queues setting (private file)",
          workingLanes: workingSource,
        },
      },
    });
  };
}
