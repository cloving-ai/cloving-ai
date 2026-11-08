import type { SchedulePort } from "../schedule-progress.ts";
import type { QueuePort } from "../queue-state.ts";
import type {
  Authority,
  CommandRecord,
  StoreReceipt,
} from "../broker/actor/authority.ts";
import { isRecordKey } from "../authority/commands.ts";
import type { Fields, Reply } from "../protocol.ts";
import type { ChangeSignal } from "./changes.ts";
import type { Gateway } from "./gateway.ts";
import type { Registry, WorkflowCatalog } from "./registry.ts";
import type { CommandEffects } from "../command-settings.ts";
import type { RunTurns, TurnDetails } from "../record-retention.ts";
import type { ThreadPoolCheck } from "../thread-pool-check.ts";
import { serviceIdentity, type ServiceIdentity } from "./service-identity.ts";
import type { EffectLeaseSource } from "../queue-room.ts";

export interface GithubReader {
  readonly read: (path: string) => Promise<unknown>;
}

export interface NoteReceipts {
  readonly read: (
    operationIds: readonly string[],
  ) => Promise<Readonly<Record<string, string>>>;
}

export interface SteerReply {
  readonly delivery: "now" | "queued";
  readonly reason?: string;
  readonly operationId?: string;
}

export interface TurnSteering {
  readonly steer: (request: {
    readonly runId: string;
    readonly noteId: string;
    readonly text: string;
  }) => Promise<SteerReply>;
}

export interface ServiceReads {
  readonly workerHarness?: (operationId: string) => Promise<string | undefined>;
  readonly noteReceipts?: NoteReceipts;
  readonly turnSteering?: TurnSteering;
  readonly turnDetails?: (turns: RunTurns) => Promise<TurnDetails | undefined>;
  readonly retentionExpired?: (runId: string) => Promise<boolean>;
  readonly githubRead?: GithubReader;
  readonly threadPool?: () => ThreadPoolCheck | undefined;
  readonly effectLeases?: EffectLeaseSource;
}

export interface ServiceContext extends ServiceReads, ServiceIdentity {
  readonly schedule?: SchedulePort;
  readonly queue?: QueuePort;
  readonly queueDailySpendLimitUsd?: number;
  readonly spendScope?: "queue" | "all";
  readonly commandEffects?: CommandEffects;
  readonly authority: Authority;
  readonly registry: Registry;
  readonly workflowCatalog?: WorkflowCatalog;
  readonly reload?: () => Promise<Reply>;
  readonly gateway: Gateway;
  readonly clock: () => string;
  readonly livenessMilliseconds: number;
  readonly followMilliseconds: number;
  readonly resolverMilliseconds: number;
  readonly textBytes: number;
  readonly documentBytes: number;
  readonly worldReports?: () => readonly unknown[];
  readonly changed?: ChangeSignal["next"];
}

export function spendSettings(
  options: Pick<ServiceContext, "queueDailySpendLimitUsd" | "spendScope">,
): Pick<ServiceContext, "queueDailySpendLimitUsd" | "spendScope"> {
  return {
    ...(options.queueDailySpendLimitUsd === undefined
      ? {}
      : { queueDailySpendLimitUsd: options.queueDailySpendLimitUsd }),
    ...(options.spendScope === undefined
      ? {}
      : { spendScope: options.spendScope }),
  };
}

export function queryMetadata(
  options: ServiceReads &
    ServiceIdentity & {
      readonly schedule?: SchedulePort;
      readonly queue?: QueuePort;
      readonly queueDailySpendLimitUsd?: number;
      readonly spendScope?: "queue" | "all";
      readonly commandEffects?: CommandEffects;
    },
): Pick<
  ServiceContext,
  | "schedule"
  | "queue"
  | "workerHarness"
  | "noteReceipts"
  | "turnSteering"
  | "turnDetails"
  | "retentionExpired"
  | "githubRead"
  | "threadPool"
  | "effectLeases"
  | "commandEffects"
  | "queueDailySpendLimitUsd"
  | "spendScope"
  | keyof ServiceIdentity
> {
  return {
    ...serviceIdentity(options),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    ...spendSettings(options),
    ...turnReads(options),
    ...(options.turnDetails === undefined
      ? {}
      : { turnDetails: options.turnDetails }),
    ...(options.retentionExpired === undefined
      ? {}
      : { retentionExpired: options.retentionExpired }),
    ...(options.githubRead === undefined
      ? {}
      : { githubRead: options.githubRead }),
    ...(options.commandEffects === undefined
      ? {}
      : { commandEffects: options.commandEffects }),
    ...(options.threadPool === undefined
      ? {}
      : { threadPool: options.threadPool }),
    ...(options.effectLeases === undefined
      ? {}
      : { effectLeases: options.effectLeases }),
  };
}

function turnReads(
  options: ServiceReads,
): Pick<ServiceReads, "workerHarness" | "noteReceipts" | "turnSteering"> {
  return {
    ...(options.workerHarness === undefined
      ? {}
      : { workerHarness: options.workerHarness }),
    ...(options.noteReceipts === undefined
      ? {}
      : { noteReceipts: options.noteReceipts }),
    ...(options.turnSteering === undefined
      ? {}
      : { turnSteering: options.turnSteering }),
  };
}

export function effectLeaseField(context: ServiceReads): Fields {
  const limits = context.effectLeases?.current();
  return limits === undefined ? {} : { effectLeases: { ...limits } };
}

export function threadPoolField(context: ServiceReads): Fields {
  const check = context.threadPool?.();
  return check === undefined ? {} : { threadPool: check };
}

const codes: Readonly<Record<string, string>> = {
  "invalid-command": "invalid-request",
  "request-too-large": "input-too-large",
  "missing-document": "invalid-request",
  "unknown-gate": "unknown-decision",
  "missing-manifest": "workflow-unavailable",
};

export function result(kind: string, fields: Fields): Reply {
  return { kind: "result", result: { schemaVersion: 1, kind, ...fields } };
}

export function failed(code: string, extra: Fields): Reply {
  const detail: unknown = extra["detail"];
  return {
    kind: "error",
    error: {
      ...extra,
      code,
      detail: typeof detail === "string" ? detail : code,
    },
  };
}

export function invalidRequest(detail: string): Reply {
  return failed("invalid-request", { detail });
}

export function rejection(receipt: StoreReceipt, identity: Fields): Reply {
  if (receipt.kind === "failed")
    return failed("authority-unavailable", {
      ...identity,
      detail: `${receipt.reason}: ${receipt.detail}`,
    });
  if (receipt.kind !== "rejected") return failed("invalid-request", identity);
  return failed(codes[receipt.reason] ?? receipt.reason, {
    ...identity,
    detail: receipt.detail ?? receipt.reason,
  });
}

export function committed(receipt: StoreReceipt): boolean {
  return receipt.kind === "accepted" || receipt.kind === "duplicate";
}

export function isIdentifier(value: unknown): value is string {
  return isRecordKey(value);
}

export function wholeNumber(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

export function publicReceipt(record: CommandRecord): Fields {
  return {
    commandId: record.commandId,
    sequence: record.sequence,
    runId: record.runId,
    recordedAt: record.recordedAt,
    commandDigest: record.commandDigest,
  };
}

export function scheduleRequest(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  return (
    context.schedule?.(parameters) ??
    Promise.resolve(failed("schedules-unavailable", {}))
  );
}

export function errorMessage(error: unknown): string {
  return String(Reflect.get(Object(error), "message"));
}
