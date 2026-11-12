import { record } from "./protocol.ts";
import type { QueueDeclaration } from "./workflow-declaration.ts";

export type QueueSource =
  | "queues setting (project file)"
  | "queues setting (private file)"
  | "queues setting"
  | "queue setting"
  | "environment"
  | "declaration"
  | "default";

export interface SourcedValue {
  readonly value: number;
  readonly source: QueueSource;
}

export interface QueueValues {
  readonly everySeconds: SourcedValue;
  readonly lanes: SourcedValue;
  readonly workingLanes: SourcedValue;
}

export interface WorkflowQueueSetting {
  readonly state?: "on" | "off";
  readonly everySeconds?: number;
  readonly lanes?: number;
  readonly workingLanes?: number;
}

export type QueuesSetting = Readonly<Record<string, WorkflowQueueSetting>>;

export interface GeneralQueueValues {
  readonly everySeconds?: SourcedValue;
  readonly lanes?: SourcedValue;
  readonly workingLanes?: SourcedValue;
}

export const defaultQueueSeconds = 120;

const queueSources: readonly QueueSource[] = [
  "queues setting (project file)",
  "queues setting (private file)",
  "queues setting",
  "queue setting",
  "environment",
  "declaration",
  "default",
];

export function isQueueSource(value: unknown): value is QueueSource {
  return queueSources.some((source) => source === value);
}

function sourced(
  candidates: readonly (SourcedValue | undefined)[],
  fallback: number,
): SourcedValue {
  return (
    candidates.find((candidate) => candidate !== undefined) ?? {
      value: fallback,
      source: "default",
    }
  );
}

function from(
  value: number | undefined,
  source: QueueSource,
): SourcedValue | undefined {
  return value === undefined ? undefined : { value, source };
}

export function declaredQueueValues(declaration: {
  readonly queue?: boolean | QueueDeclaration | undefined;
}): QueueDeclaration {
  return typeof declaration.queue === "object" ? declaration.queue : {};
}

interface QueueValuesInput {
  readonly declared: QueueDeclaration;
  readonly setting?: WorkflowQueueSetting | undefined;
  readonly settingSource?: QueueSource | undefined;
  readonly settingSources?:
    Readonly<Partial<Record<keyof QueueValues, QueueSource>>> | undefined;
  readonly general: GeneralQueueValues;
}

function settingValueSource(
  given: QueueValuesInput,
  field: keyof QueueValues,
): QueueSource {
  return (
    given.settingSources?.[field] ?? given.settingSource ?? "queues setting"
  );
}

export function queueIntervalValue(given: QueueValuesInput): SourcedValue {
  const { declared, setting, general } = given;
  return sourced(
    [
      from(setting?.everySeconds, settingValueSource(given, "everySeconds")),
      general.everySeconds,
      from(declared.everySeconds, "declaration"),
    ],
    defaultQueueSeconds,
  );
}

export function queueValues(given: QueueValuesInput): QueueValues {
  const { declared, setting, general } = given;
  const lanes = sourced(
    [
      from(setting?.lanes, settingValueSource(given, "lanes")),
      general.lanes,
      from(declared.lanes, "declaration"),
    ],
    1,
  );
  const workingLanes = sourced(
    [
      from(setting?.workingLanes, settingValueSource(given, "workingLanes")),
      general.workingLanes,
    ],
    lanes.value,
  );
  if (workingLanes.value > lanes.value)
    throw new Error("invalid-queue-working-lanes");
  return {
    everySeconds: queueIntervalValue(given),
    lanes,
    workingLanes,
  };
}

function whole(
  value: unknown,
  bounds: { readonly minimum: number; readonly maximum: number },
): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      Number(value) >= bounds.minimum &&
      Number(value) <= bounds.maximum)
  );
}

const maximumLanes = 16;

const laneBounds = { minimum: 1, maximum: maximumLanes };

function lanesInOrder(fields: Readonly<Record<string, unknown>>): boolean {
  const { lanes, workingLanes } = fields;
  return (
    whole(lanes, laneBounds) &&
    whole(workingLanes, laneBounds) &&
    Number(workingLanes ?? 0) <= Number(lanes ?? maximumLanes)
  );
}

function isQueueState(state: unknown): boolean {
  return state === undefined || state === "on" || state === "off";
}

function isWorkflowQueueSetting(value: unknown): value is WorkflowQueueSetting {
  const fields = record(value);
  if (fields === undefined) return false;
  const known = ["state", "everySeconds", "lanes", "workingLanes"];
  const { state, everySeconds } = fields;
  return (
    Object.keys(fields).every((key) => known.includes(key)) &&
    isQueueState(state) &&
    whole(everySeconds, { minimum: 10, maximum: 3600 }) &&
    lanesInOrder(fields)
  );
}

export function isQueuesSetting(value: unknown): value is QueuesSetting {
  const fields = record(value);
  return (
    fields !== undefined &&
    Object.entries(fields).every(
      ([workflowId, setting]) =>
        /^[A-Za-z0-9-]{1,64}$/.test(workflowId) &&
        isWorkflowQueueSetting(setting),
    )
  );
}

export function parseQueuesSetting(text: string | undefined): QueuesSetting {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid-setting: queues");
  }
  if (!isQueuesSetting(value)) throw new Error("invalid-setting: queues");
  return value;
}

function parsedQueues(value: unknown): QueuesSetting | undefined {
  try {
    return parseQueuesSetting(typeof value === "string" ? value : undefined);
  } catch {
    return undefined;
  }
}

export function queuesDigest(
  value: unknown,
  digest: (text: string) => string,
): string {
  const settings = parsedQueues(value);
  if (settings === undefined) return `${digest(JSON.stringify(value))}:`;
  const rows = Object.entries(settings).sort(([first], [second]) =>
    first < second ? -1 : Number(first > second),
  );
  const part = (names: readonly (keyof WorkflowQueueSetting)[]) =>
    digest(
      JSON.stringify(
        rows.flatMap(([workflowId, setting]) => {
          const values = names.map((name) => setting[name] ?? null);
          return values.every((value) => value === null)
            ? []
            : [[workflowId, ...values]];
        }),
      ),
    );
  return `${part(["state", "everySeconds"])}:${part(["lanes", "workingLanes"])}`;
}

export function queueFileLayers(
  project: QueuesSetting | undefined,
  privateFile: QueuesSetting | undefined,
): {
  readonly values: QueuesSetting | undefined;
  readonly sources: Readonly<Record<string, "project" | "private">>;
} {
  const values: Record<string, WorkflowQueueSetting> = {};
  const sources: Record<string, "project" | "private"> = {};
  if (project === undefined && privateFile === undefined)
    return { values: undefined, sources };
  for (const [source, layer] of [
    ["project", project],
    ["private", privateFile],
  ] as const) {
    for (const [workflowId, setting] of Object.entries(layer ?? {})) {
      values[workflowId] = { ...values[workflowId], ...setting };
      for (const field of Object.keys(setting))
        sources[`queues.${workflowId}.${field}`] = source;
    }
  }
  return { values, sources };
}

export function queueValueSources(
  sources: Readonly<Record<string, string>>,
  workflowId: string,
): Readonly<Record<keyof QueueValues, QueueSource>> {
  const source = (field: keyof QueueValues): QueueSource => {
    const origin =
      sources["queues"] === "environment"
        ? "environment"
        : (sources[`queues.${workflowId}.${field}`] ?? sources["queues"]);
    if (origin === "private") return "queues setting (private file)";
    if (origin === "project") return "queues setting (project file)";
    if (origin === "environment") return "environment";
    return "queues setting";
  };
  return {
    everySeconds: source("everySeconds"),
    lanes: source("lanes"),
    workingLanes: source("workingLanes"),
  };
}
