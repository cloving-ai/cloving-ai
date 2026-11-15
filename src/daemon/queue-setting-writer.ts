import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { changeConfigFile, readConfigFile } from "../cli/config-file.ts";
import { privateSettingsPath } from "../cli/project-settings.ts";
import {
  queueSettingRequest,
  type QueueSettingRequest,
} from "../queue-setting-operation.ts";
import type { QueueLaneChange } from "../queue-state.ts";
import { record, type Reply } from "../protocol.ts";
import type { QueueLimitsSource } from "./queue-limits.ts";
import {
  queueControlLimit,
  queueJournal,
  type QueueJournal,
} from "./queue-journal.ts";
import type { RecordedSource } from "../project-settings.ts";
import { declaredQueueValues } from "../queue-settings.ts";
import { parseConfiguration } from "../project-settings.ts";
import {
  queueSettingPair,
  type QueueSettingChange,
} from "../queue-setting-change.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import { openWork } from "./working-runs.ts";

interface Settings {
  readonly repository: string;
  readonly directory: string;
  readonly settingSources?: Readonly<Record<string, RecordedSource>>;
  readonly declarations?: readonly DeclaredWorkflow[];
}

const variables = {
  queues: "CLOVING_QUEUES",
  "queue.lanes": "CLOVING_QUEUE_LANES",
  "queue.workingLanes": "CLOVING_QUEUE_WORKING_LANES",
  "queue.globalLanes": "CLOVING_QUEUE_GLOBAL_LANES",
  "queue.globalWorkingLanes": "CLOVING_QUEUE_GLOBAL_WORKING_LANES",
};

function environment(
  settings: Settings,
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(variables).flatMap(([key, variable]) =>
      settings.settingSources?.[key] === "environment"
        ? [[variable, process.env[variable]]]
        : [],
    ),
  );
}

function effective(
  source: QueueLimitsSource,
  request: QueueSettingRequest,
): number {
  const limits = source.current(request.workflowId);
  if (request.scope === "workflow") return limits[request.field];
  return request.field === "lanes"
    ? (limits.global?.lanes ?? 16)
    : (limits.global?.workingLanes ?? limits.global?.lanes ?? 16);
}

async function savedSetting(
  settings: Settings,
  context: Pick<Editing, "source" | "request">,
): Promise<void> {
  await changeConfigFile(
    privateSettingsPath(process.env, settings.repository),
    await settingChange(settings, context),
  );
}

async function settingChange(
  settings: Settings,
  context: Pick<Editing, "source" | "request">,
): Promise<QueueSettingChange> {
  const { request, source } = context;
  const project = await readConfigFile(
    join(settings.repository, ".cloving/config.json"),
  );
  const declaration = settings.declarations?.find(
    (row) => row.workflowId === request.workflowId,
  );
  const fallback =
    declaration === undefined
      ? undefined
      : declaredQueueValues(declaration).lanes;
  const declaredLanes =
    source.declaredLanes?.(request.workflowId ?? "") ?? fallback;
  return {
    scope: "private",
    queueSetting: {
      request,
      environment: environment(settings),
      ...(project === undefined ? {} : { project }),
      ...(declaredLanes === undefined ? {} : { declaredLanes }),
    },
  };
}

async function currentSetting(
  settings: Settings,
  context: Pick<Editing, "source" | "request">,
) {
  const { request } = context;
  const change = await settingChange(settings, context);
  const text = await readConfigFile(
    privateSettingsPath(process.env, settings.repository),
  );
  const configuration = parseConfiguration(text, "private");
  const field =
    request.field === "lanes" ? "globalLanes" : "globalWorkingLanes";
  const own =
    request.scope === "global"
      ? configuration.queue?.[field]
      : configuration.queues?.[request.workflowId ?? ""]?.[request.field];
  return { pair: queueSettingPair(text, change.queueSetting), own };
}

async function apply(
  settings: Settings,
  context: {
    readonly source: QueueLimitsSource;
    readonly request: QueueSettingRequest;
    readonly reload: () => Promise<Reply>;
  },
): Promise<QueueLaneChange> {
  const { source, request, reload } = context;
  const expected = await currentSetting(settings, context);
  if (request.action === "inherit" && expected.own !== undefined)
    return {
      kind: "unavailable",
      detail:
        "A newer private override replaced this reset. Refresh before making another change.",
    };
  const reply = await reload();
  if (reply.kind === "error")
    return {
      kind: "unavailable",
      detail: `The setting was saved but not applied. ${reply.error.detail} Fix the cause and retry this request.`,
    };
  if (!appliedPair(source, { request, expected: expected.pair }))
    return {
      kind: "unavailable",
      detail: `The setting was saved but not applied. The running value is ${String(effective(source, request))}. Check its controlling source, then retry.`,
    };
  return { kind: "changed" };
}

function appliedPair(
  source: QueueLimitsSource,
  check: {
    readonly request: QueueSettingRequest;
    readonly expected: {
      readonly lanes: number;
      readonly workingLanes: number;
    };
  },
): boolean {
  const { request, expected } = check;
  const lanes = effective(source, { ...request, field: "lanes" });
  const working = effective(source, { ...request, field: "workingLanes" });
  if (lanes !== expected.lanes || working !== expected.workingLanes)
    return false;
  if (request.action === "set")
    return effective(source, request) === request.value;
  const limits = source.current(request.workflowId);
  const sources =
    request.scope === "global" ? limits.global?.sources : limits.sources;
  return sources?.[request.field]?.includes("private file") !== true;
}

interface Editing {
  readonly source: QueueLimitsSource;
  readonly journal: QueueJournal;
  readonly request: QueueSettingRequest;
  readonly reload: () => Promise<Reply>;
}

async function replay(
  settings: Settings,
  context: Editing,
): Promise<QueueLaneChange> {
  const { request, source, reload } = context;
  const current = await currentSetting(settings, context);
  if (request.action === "set" && current.pair[request.field] !== request.value)
    return {
      kind: "unavailable",
      detail:
        "A newer private setting replaced this request. Refresh before making another change.",
    };
  if (
    appliedPair(source, { request, expected: current.pair }) &&
    (request.action === "set" || current.own === undefined)
  )
    return { kind: "replayed" };
  const previous = context.journal.controls.find(
    (entry) => entry.commandId === request.commandId,
  );
  if (previous?.command === "setting" && previous.applied === true)
    return {
      kind: "unavailable",
      detail:
        "The effective setting changed after this request. Refresh before editing again.",
    };
  return finished(context, await apply(settings, { source, request, reload }));
}

async function finished(
  context: Editing,
  outcome: QueueLaneChange,
): Promise<QueueLaneChange> {
  if (outcome.kind !== "changed") return outcome;
  const index = context.journal.controls.findIndex(
    (entry) => entry.commandId === context.request.commandId,
  );
  context.journal.controls[index] = {
    ...context.request,
    command: "setting",
    saved: true,
    applied: true,
  };
  await context.journal.save();
  return outcome;
}

function sameRequest(previous: unknown, request: QueueSettingRequest): boolean {
  return (
    JSON.stringify(queueSettingRequest(requestFields(previous))) ===
    JSON.stringify(queueSettingRequest(request))
  );
}

async function recordPending(context: Editing): Promise<void> {
  context.journal.commands.add(context.request.commandId);
  context.journal.controls.push({
    ...context.request,
    command: "setting",
    saved: false,
  });
  if (context.journal.controls.length > queueControlLimit)
    context.journal.controls.shift();
  await context.journal.save();
}

function ambiguousPending(previous: unknown): boolean {
  const receipt = record(previous);
  return receipt?.["command"] === "setting" && receipt["saved"] === false;
}

function receiptRefusal(
  previous: unknown,
  context: Editing,
): QueueLaneChange | undefined {
  const { request, journal, source } = context;
  if (previous !== undefined && !sameRequest(previous, request))
    return { kind: "conflicting-command" };
  if (ambiguousPending(previous))
    return {
      kind: "unavailable",
      detail:
        "The previous save is uncertain. Refresh the configuration and effective limits before making a new change; this request will not overwrite a newer edit.",
    };
  if (previous !== undefined) return undefined;
  if (journal.commands.has(request.commandId))
    return {
      kind: "unavailable",
      detail:
        "The detailed receipt of this old request expired. Refresh before making a new change; this request will not be applied again.",
    };
  return effective(source, request) === request.expectedValue
    ? undefined
    : { kind: "stale" };
}

async function change(
  settings: Settings,
  context: Editing,
): Promise<QueueLaneChange> {
  const { source, journal, request, reload } = context;
  const previous = journal.controls.find(
    (entry) => entry.commandId === request.commandId,
  );
  const refused = receiptRefusal(previous, context);
  if (refused !== undefined) return refused;
  if (previous?.command === "setting" && previous.saved)
    return replay(settings, context);
  if (previous === undefined) await recordPending(context);
  await savedSetting(settings, context);
  const index = journal.controls.findIndex(
    (entry) => entry.commandId === request.commandId,
  );
  journal.controls[index] = { ...request, command: "setting", saved: true };
  await journal.save();
  return finished(context, await apply(settings, { source, request, reload }));
}

function requestFields(entry: unknown) {
  return Object.fromEntries(
    Object.entries(record(entry) ?? {}).filter(
      ([key]) => !["command", "saved", "applied"].includes(key),
    ),
  );
}

export function queueSettingWriter(
  settings: Settings,
  source: QueueLimitsSource,
) {
  let journal: Promise<QueueJournal> | undefined;
  return async (
    request: QueueSettingRequest,
    reload: () => Promise<Reply>,
  ): Promise<QueueLaneChange> => {
    const directory = join(settings.directory, "queue-settings");
    journal ??= mkdir(directory, { recursive: true, mode: 0o700 }).then(() =>
      queueJournal(directory),
    );
    return change(settings, {
      source,
      journal: await journal,
      request,
      reload,
    });
  };
}

export function queueSettingPorts(
  settings: Settings,
  source: QueueLimitsSource,
) {
  return {
    queueSettings: {
      change: queueSettingWriter(settings, source),
      global: () => source.current().global,
      work: async () => {
        const work = await openWork(settings.directory);
        return { working: [...work.working], github: [...work.github] };
      },
    },
  };
}
