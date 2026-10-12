import { isIdentifier } from "../../authority/commands.ts";
import type { CallResult } from "./adapter-calls.ts";

export type Settlement =
  | { readonly kind: "absent" }
  | {
      readonly kind: "accepted";
      readonly receipt: string;
      readonly worker: string;
    }
  | (Identity & {
      readonly kind: "completed";
      readonly receipt: string;
      readonly result: string | null;
      readonly reason: string | null;
    })
  | (Identity & { readonly kind: "failed"; readonly reason: string })
  | (Identity & { readonly kind: "stopped" })
  | { readonly kind: "unknown"; readonly reason: string };

interface Identity {
  readonly receipt: string | null;
  readonly worker: string | null;
}

function unknown(reason: string): Settlement {
  return { kind: "unknown", reason };
}

const malformed = unknown("invalid-adapter-reply");

function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

function accepted(reply: unknown): Settlement {
  const receipt = field(reply, "receipt");
  const worker = field(reply, "worker");
  if (!isIdentifier(receipt) || !isIdentifier(worker)) return malformed;
  return { kind: "accepted", receipt, worker };
}

function optionalIdentifier(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return isIdentifier(value) ? value : undefined;
}

function identity(reply: unknown): Identity | undefined {
  const receipt = optionalIdentifier(field(reply, "receipt"));
  const worker = optionalIdentifier(field(reply, "worker"));
  if (receipt === undefined || worker === undefined) return undefined;
  return { receipt, worker };
}

function completed(reply: unknown, resultBytes: number): Settlement {
  const result = field(reply, "result");
  const given = identity(reply);
  if (typeof result !== "string" || given?.receipt == null) return malformed;
  const { receipt, worker } = given;
  const large = Buffer.byteLength(result) > resultBytes;
  return {
    kind: "completed",
    receipt,
    worker,
    result: large ? null : result,
    reason: large ? "result-too-large" : null,
  };
}

function failed(reply: unknown): Settlement {
  const reason = field(reply, "reason");
  const given = identity(reply);
  if (!isIdentifier(reason) || given === undefined) return malformed;
  return { kind: "failed", ...given, reason };
}

function stopped(reply: unknown): Settlement {
  const given = identity(reply);
  return given === undefined ? malformed : { kind: "stopped", ...given };
}

type Mapping = (reply: unknown, resultBytes: number) => Settlement;

const mappings: Readonly<Record<string, Mapping>> = {
  absent: () => ({ kind: "absent" }),
  accepted,
  completed,
  failed,
  stopped,
  unknown: () => unknown("adapter-unknown"),
};

const failures: Readonly<Record<"thrown" | "overdue", Settlement>> = {
  thrown: unknown("adapter-failure"),
  overdue: unknown("time-limit"),
};

function mappingOf(reply: unknown): Mapping | undefined {
  const kind = field(reply, "kind");
  if (kind === undefined) return accepted;
  const known = typeof kind === "string" && Object.hasOwn(mappings, kind);
  return known ? mappings[kind] : undefined;
}

export function settlement(
  result: CallResult<unknown>,
  resultBytes: number,
): Settlement {
  if (result.kind !== "replied") return failures[result.kind];
  const mapping = mappingOf(result.reply);
  return mapping === undefined ? malformed : mapping(result.reply, resultBytes);
}
