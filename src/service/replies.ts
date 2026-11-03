import type { SchedulePort } from "../schedule-progress.ts";
import type {
  Authority,
  CommandRecord,
  StoreReceipt,
} from "../broker/actor/authority.ts";
import { isRecordKey } from "../authority/commands.ts";
import type { Fields, Reply } from "../protocol.ts";
import type { ChangeSignal } from "./changes.ts";
import type { Gateway } from "./gateway.ts";
import type { Registry } from "./registry.ts";
import {
  workflowRefusals,
  type WorkflowRefusal,
} from "../workflow-refusals.ts";
import type { CommandEffects } from "../command-settings.ts";
import type { RunTurns, TurnDetails } from "../record-retention.ts";

export interface ServiceReads {
  readonly workerHarness?: (operationId: string) => Promise<string | undefined>;
  readonly turnDetails?: (turns: RunTurns) => Promise<TurnDetails | undefined>;
}

export interface ServiceContext extends ServiceReads {
  readonly version?: string;
  readonly schedule?: SchedulePort;
  readonly queueDailySpendLimitUsd?: number;
  readonly commandEffects?: CommandEffects;
  readonly authority: Authority;
  readonly registry: Registry;
  readonly workflowRefusals?: readonly WorkflowRefusal[];
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

export function queryMetadata(
  options: ServiceReads & {
    readonly version?: string;
    readonly schedule?: SchedulePort;
    readonly queueDailySpendLimitUsd?: number;
    readonly commandEffects?: CommandEffects;
    readonly workflowRefusals?: readonly WorkflowRefusal[];
  },
): Pick<
  ServiceContext,
  | "schedule"
  | "workerHarness"
  | "turnDetails"
  | "commandEffects"
  | "workflowRefusals"
  | "queueDailySpendLimitUsd"
  | "version"
> {
  return {
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.queueDailySpendLimitUsd === undefined
      ? {}
      : { queueDailySpendLimitUsd: options.queueDailySpendLimitUsd }),
    ...(options.workerHarness === undefined
      ? {}
      : { workerHarness: options.workerHarness }),
    ...(options.turnDetails === undefined
      ? {}
      : { turnDetails: options.turnDetails }),
    ...(options.commandEffects === undefined
      ? {}
      : { commandEffects: options.commandEffects }),
    workflowRefusals: workflowRefusals(options.workflowRefusals),
  };
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
