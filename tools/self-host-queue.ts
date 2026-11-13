import {
  defaultRoom,
  isPressureLimit,
  type QueueLimits,
  type QueueConfiguration,
} from "../src/queue-room.ts";
import {
  declaredQueueValues,
  parseQueuesSetting,
  queuePollingConfigured,
  queueValues,
  queueValueSources,
  type GeneralQueueValues,
  type QueueSource,
  type QueueValues,
  type SourcedValue,
  type WorkflowQueueSetting,
} from "../src/queue-settings.ts";
import {
  declaresQueue,
  type DeclaredWorkflow,
} from "../src/workflow-declaration.ts";
import type { SettingSource } from "../src/project-settings.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type QueueWorkflow = Pick<DeclaredWorkflow, "workflowId" | "queue">;

export type QueuePlan =
  | { readonly kind: "none" }
  | { readonly kind: "off"; readonly workflowId: string }
  | {
      readonly kind: "on";
      readonly workflowId: string;
      readonly values: QueueValues;
    };

interface QueueContext {
  readonly environment: Environment;
  readonly plan: QueuePlan;
}

const noQueue: QueuePlan = { kind: "none" };

const laneCount = /^(?:[1-9]|1[0-6])$/;

function refusedStart(code: string): never {
  throw new Error(`The daemon did not start: ${code}`);
}

function queued(context: QueueContext, code: string): void {
  if (
    context.environment["CLOVING_QUEUE_SECONDS"] === undefined &&
    context.plan.kind === "none"
  )
    refusedStart(code);
}

function laneSetting(
  value: string | undefined,
  code: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!laneCount.test(value)) refusedStart(code);
  return Number(value);
}

export function queueLanes(
  environment: Environment,
  plan: QueuePlan = noQueue,
): number {
  const lanes = laneSetting(
    environment["CLOVING_QUEUE_LANES"],
    "invalid-queue-lanes",
  );
  if (plan.kind === "on") return plan.values.lanes.value;
  if (lanes === undefined) return 1;
  queued({ environment, plan }, "queue-lanes-needs-queue");
  return lanes;
}

function workingLanes(context: QueueContext, lanes: number): number {
  const { environment, plan } = context;
  if (plan.kind === "on") return plan.values.workingLanes.value;
  const value = environment["CLOVING_QUEUE_WORKING_LANES"];
  if (value === undefined) return lanes;
  if (!laneCount.test(value) || Number(value) > lanes)
    refusedStart("invalid-queue-working-lanes");
  queued(context, "queue-working-lanes-needs-queue");
  return Number(value);
}

function maxLoadPerCore(context: QueueContext): number {
  const value = context.environment["CLOVING_QUEUE_MAX_LOAD_PER_CORE"];
  if (value === undefined) return defaultRoom.maxLoadPerCore;
  const limit = Number(value);
  if (!/^\d+(?:\.\d+)?$/.test(value) || limit < 0.1 || limit > 4)
    refusedStart("invalid-queue-max-load-per-core");
  queued(context, "queue-max-load-needs-queue");
  return limit;
}

function maxMemoryPressure(context: QueueContext) {
  const value = context.environment["CLOVING_QUEUE_MAX_MEMORY_PRESSURE"];
  if (value === undefined) return defaultRoom.maxMemoryPressure;
  if (!isPressureLimit(value))
    refusedStart("invalid-queue-max-memory-pressure");
  queued(context, "queue-max-memory-needs-queue");
  return value;
}

function effectReserved(environment: Environment): number | undefined {
  const value = environment["CLOVING_EFFECT_RESERVED"];
  if (value === undefined) return undefined;
  if (!/^[0-8]$/.test(value)) refusedStart("invalid-effect-settings");
  return Number(value);
}

export function queueLimits(
  environment: Environment,
  plan: QueuePlan = noQueue,
): QueueLimits {
  const context = { environment, plan };
  const lanes = queueLanes(environment, plan);
  const reserved = effectReserved(environment);
  return {
    lanes,
    workingLanes: workingLanes(context, lanes),
    room: {
      maxLoadPerCore: maxLoadPerCore(context),
      maxMemoryPressure: maxMemoryPressure(context),
    },
    ...(reserved === undefined ? {} : { reserved }),
    ...(plan.kind === "on"
      ? {
          sources: {
            lanes: plan.values.lanes.source,
            workingLanes: plan.values.workingLanes.source,
          },
        }
      : {}),
  };
}

export function spendScope(environment: Environment): "queue" | "all" {
  const value = environment["CLOVING_SPEND_SCOPE"] ?? "queue";
  if (value === "queue" || value === "all") return value;
  refusedStart("invalid-spend-scope");
}

export function queueSpendLimit(
  environment: Environment,
  plan: QueuePlan = noQueue,
): number | undefined {
  const value = environment["CLOVING_QUEUE_DAILY_SPEND_USD"];
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0)
    refusedStart("invalid-queue-spend-limit");
  if (spendScope(environment) === "queue")
    queued({ environment, plan }, "queue-spend-limit-needs-queue");
  return limit;
}

export function readyTicketCommand(
  environment: Environment,
  plan: QueuePlan = noQueue,
): readonly string[] | undefined {
  const command = listedSetting(environment, "CLOVING_READY_COMMAND");
  if (command !== undefined)
    queued({ environment, plan }, "ready-command-needs-queue");
  return command;
}

function intervalSeconds(environment: Environment): number | undefined {
  const value = environment["CLOVING_QUEUE_SECONDS"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || seconds < 10 || seconds > 3600)
    refusedStart("invalid-queue-seconds");
  return seconds;
}

function sourced(
  value: number | undefined,
  source: QueueSource,
): SourcedValue | undefined {
  return value === undefined ? undefined : { value, source };
}

function generalValues(
  environment: Environment,
  sources: Readonly<Record<string, SettingSource>>,
): GeneralQueueValues {
  const source = (field: string): QueueSource =>
    sources[field] === "private" || sources[field] === "project"
      ? "queue setting"
      : "environment";
  const everySeconds = sourced(
    intervalSeconds(environment),
    source("queue.everySeconds"),
  );
  const lanes = sourced(
    laneSetting(environment["CLOVING_QUEUE_LANES"], "invalid-queue-lanes"),
    source("queue.lanes"),
  );
  const workingLanes = sourced(
    laneSetting(
      environment["CLOVING_QUEUE_WORKING_LANES"],
      "invalid-queue-working-lanes",
    ),
    source("queue.workingLanes"),
  );
  return {
    ...(everySeconds === undefined ? {} : { everySeconds }),
    ...(lanes === undefined ? {} : { lanes }),
    ...(workingLanes === undefined ? {} : { workingLanes }),
  };
}

function queuesSetting(environment: Environment) {
  try {
    return parseQueuesSetting(environment["CLOVING_QUEUES"]);
  } catch {
    return refusedStart("invalid-queues");
  }
}

function ticketCommands(
  environment: Environment,
  setting: WorkflowQueueSetting | undefined,
): boolean {
  const next = listedSetting(environment, "CLOVING_NEXT_COMMAND") ?? [];
  const ticket = listedSetting(environment, "CLOVING_TICKET_COMMAND") ?? [];
  if (next.length > 0 && ticket.length > 0) return true;
  if (
    environment["CLOVING_QUEUE_SECONDS"] === undefined &&
    setting === undefined
  )
    return false;
  return refusedStart(
    next.length === 0
      ? "queue-needs-next-command"
      : "queue-needs-ticket-command",
  );
}

function plannedValues(given: Parameters<typeof queueValues>[0]): QueueValues {
  try {
    return queueValues(given);
  } catch {
    return refusedStart("invalid-queue-working-lanes");
  }
}

interface QueueConfigurationInput {
  readonly declarations: readonly QueueWorkflow[];
  readonly sources: Readonly<Record<string, SettingSource>>;
}

function queueConfiguration(
  environment: Environment,
  given: QueueConfigurationInput,
) {
  const general = generalValues(environment, given.sources);
  const settings = queuesSetting(environment);
  const declared = given.declarations.find((declaration) =>
    declaresQueue(declaration.queue),
  );
  if (declared === undefined) return undefined;
  return {
    declared,
    settingSources: queueValueSources(given.sources, declared.workflowId),
    setting: Object.hasOwn(settings, declared.workflowId)
      ? settings[declared.workflowId]
      : undefined,
    general,
  };
}

function configuredPlan(
  configuration: NonNullable<ReturnType<typeof queueConfiguration>>,
): QueuePlan {
  const { declared, setting, general } = configuration;
  return {
    kind: "on",
    workflowId: declared.workflowId,
    values: plannedValues({
      declared: declaredQueueValues(declared),
      setting,
      settingSources: configuration.settingSources,
      general,
    }),
  };
}

export function queuePlan(
  environment: Environment,
  given: QueueConfigurationInput,
): QueuePlan {
  const configuration = queueConfiguration(environment, given);
  if (configuration === undefined || !queuePollingConfigured(configuration))
    return noQueue;
  const { declared, setting } = configuration;
  if (setting?.state === "off")
    return { kind: "off", workflowId: declared.workflowId };
  if (!ticketCommands(environment, setting)) return noQueue;
  return configuredPlan(configuration);
}

export function queueConfigurations(
  environment: Environment,
  given: QueueConfigurationInput,
): Readonly<Record<string, QueueConfiguration>> {
  return Object.fromEntries(
    given.declarations
      .filter((row) => declaresQueue(row.queue))
      .map((declaration) => {
        const input = { ...given, declarations: [declaration] };
        const plan = queuePlan(environment, input);
        const limits = reloadedQueueLimits(environment, input);
        const configuration: QueueConfiguration =
          plan.kind === "on"
            ? {
                limits,
                intervalMilliseconds: plan.values.everySeconds.value * 1000,
                intervalSource: plan.values.everySeconds.source,
              }
            : {
                limits,
                ...(plan.kind === "off" ? { state: "off" as const } : {}),
              };
        return [declaration.workflowId, configuration];
      }),
  );
}

export function queueWorkflowLimits(
  environment: Environment,
  given: QueueConfigurationInput,
): Readonly<Record<string, QueueLimits>> {
  return Object.fromEntries(
    given.declarations
      .filter((row) => declaresQueue(row.queue))
      .map((declaration) => [
        declaration.workflowId,
        reloadedQueueLimits(environment, {
          ...given,
          declarations: [declaration],
        }),
      ]),
  );
}

export function reloadedQueueLimits(
  environment: Environment,
  given: QueueConfigurationInput,
): QueueLimits {
  const configuration = queueConfiguration(environment, given);
  const plan =
    configuration === undefined ? noQueue : configuredPlan(configuration);
  return queueLimits(environment, plan);
}

export function queueMilliseconds(plan: QueuePlan): number | undefined {
  return plan.kind === "on" ? plan.values.everySeconds.value * 1000 : undefined;
}

export function listedSetting(
  environment: Environment,
  name: string,
): readonly string[] | undefined {
  const given = environment[name];
  if (given === undefined) return undefined;
  const list: unknown = JSON.parse(given);
  if (!Array.isArray(list) || !list.every((part) => typeof part === "string"))
    throw new Error(`${name} is not a JSON list of texts.`);
  return list.map(String);
}
