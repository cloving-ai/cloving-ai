import type {
  Authority,
  CommandRecord,
  StoreReceipt,
} from "../broker/actor/authority.ts";
import { isRecordKey } from "../authority/commands.ts";
import type { Fields, Reply } from "../protocol.ts";
import type { Gateway } from "./gateway.ts";
import type { Registry } from "./registry.ts";

export interface ServiceContext {
  readonly authority: Authority;
  readonly registry: Registry;
  readonly gateway: Gateway;
  readonly clock: () => string;
  readonly livenessMilliseconds: number;
  readonly followMilliseconds: number;
  readonly resolverMilliseconds: number;
  readonly textBytes: number;
  readonly documentBytes: number;
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
