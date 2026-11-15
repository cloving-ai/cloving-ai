import { changeConfigFile, readConfigFile } from "../cli/config-file.ts";
import { privateSettingsPath } from "../cli/project-settings.ts";
import { send } from "../cli/client.ts";
import type { Reply } from "../protocol.ts";
import {
  parseConfiguration,
  type RecordedSource,
} from "../project-settings.ts";
import { join } from "node:path";
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

export interface QueueLimitReplacement extends QueueLimits {
  readonly declarations?: readonly DeclaredWorkflow[];
}

export interface QueueLimitsSource {
  readonly declaredLanes?: (workflowId: string) => number | undefined;
  readonly current: (workflowId?: string) => QueueLimits;
  readonly replace: (
    next: QueueLimitReplacement,
    queues?: Readonly<Record<string, QueueLimits>>,
  ) => void;
}

function declarationLanes(
  declarations: readonly DeclaredWorkflow[],
): ReadonlyMap<string, number> {
  return new Map(
    declarations
      .filter((row) => declaresQueue(row.queue))
      .map((row) => [row.workflowId, declaredQueueValues(row).lanes ?? 1]),
  );
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
  let declared = declarationLanes(settings.declarations ?? []);
  let queues = Object.fromEntries(
    (settings.declarations ?? []).flatMap((row) => {
      const configuration = queueConfiguration(settings, row.workflowId);
      return configuration === undefined
        ? []
        : [[row.workflowId, configuration.limits]];
    }),
  );
  return {
    declaredLanes: (id) => declared.get(id),
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
    replace: ({ declarations, ...next }, replacements) => {
      const nextDeclared =
        declarations === undefined ? declared : declarationLanes(declarations);
      current = next;
      declared = nextDeclared;
      queues =
        replacements === undefined
          ? Object.fromEntries(Object.keys(queues).map((id) => [id, next]))
          : { ...queues, ...replacements };
    },
  };
}

interface QueueLaneWriteSettings {
  readonly repository: string;
  readonly runtimeDirectory: string;
  readonly settingSources?: Readonly<Record<string, RecordedSource>>;
  readonly reload?: () => Promise<Reply>;
}

export function queueLaneWriter(
  settings: QueueLaneWriteSettings,
  source: QueueLimitsSource,
): (workflowId: string, lanes: number) => Promise<void> {
  return async (workflowId, lanes) => {
    if (settings.settingSources?.["queues"] === "environment")
      throw new Error(
        "queue-lanes-apply: CLOVING_QUEUES controls this queue through the environment or a retained start override. Change that override before editing lanes here.",
      );
    await changeConfigFile(
      privateSettingsPath(process.env, settings.repository),
      {
        scope: "private",
        queueLanes: {
          workflowId,
          lanes,
          working: await workingContext(settings, workflowId),
        },
      },
    );
    const reply = await (settings.reload?.() ??
      send(settings.runtimeDirectory, { operation: "reload", parameters: {} }));
    if (reply.kind === "error")
      throw new Error(
        `queue-lanes-apply: The setting was saved but not applied. ${reply.error.code}: ${reply.error.detail} Fix the cause and retry.`,
      );
    checkedAppliedLanes(source.current(workflowId), lanes);
  };
}

async function workingContext(
  settings: QueueLaneWriteSettings,
  workflowId: string,
) {
  const project = parseConfiguration(
    await readConfigFile(join(settings.repository, ".cloving/config.json")),
    "project",
  );
  const projectQueue = project.queues?.[workflowId]?.workingLanes;
  const projectGeneral = project.queue?.workingLanes;
  const environmentGeneral =
    settings.settingSources?.["queue.workingLanes"] === "environment"
      ? Number(process.env["CLOVING_QUEUE_WORKING_LANES"])
      : undefined;
  return {
    ...(projectQueue === undefined ? {} : { projectQueue }),
    ...(projectGeneral === undefined ? {} : { projectGeneral }),
    ...(environmentGeneral === undefined ? {} : { environmentGeneral }),
  };
}

function checkedAppliedLanes(effective: QueueLimits, lanes: number): void {
  if (effective.lanes !== lanes || effective.workingLanes > lanes)
    throw new Error(
      `queue-lanes-apply: The setting was saved but not applied. The running limit is ${String(effective.lanes)} lanes (${effective.sources?.lanes ?? "default"}) and ${String(effective.workingLanes)} working lanes. Refresh and check the controlling setting.`,
    );
}
