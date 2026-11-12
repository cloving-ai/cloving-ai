import { record } from "./protocol.ts";
import type { QueueDeclaration } from "./workflow-declaration.ts";

export type QueueSource =
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
  readonly general: GeneralQueueValues;
}

export function queueIntervalValue(given: QueueValuesInput): SourcedValue {
  const { declared, setting, general } = given;
  return sourced(
    [
      from(setting?.everySeconds, "queues setting"),
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
      from(setting?.lanes, "queues setting"),
      general.lanes,
      from(declared.lanes, "declaration"),
    ],
    1,
  );
  const workingLanes = sourced(
    [from(setting?.workingLanes, "queues setting"), general.workingLanes],
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
