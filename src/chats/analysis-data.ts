import type { AnalysisCode } from "./analysis-contract.ts";
import { isProxy } from "node:util/types";

export function forbiddenAnalysisField(key: string): boolean {
  const name = key.replaceAll(/[-_]/g, "").toLowerCase();
  return /authority|permission|credential|publish|spend|tdd|^(?:code|scripts?|prompts?|workflows?|executable(?:workflow)?|commands?)$/.test(
    name,
  );
}

function plainPrototype(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  const expected: unknown = Object.getPrototypeOf(
    Array.isArray(value) ? [] : {},
  );
  return (
    prototype === expected || (prototype === null && !Array.isArray(value))
  );
}

function arrayKeys(
  value: readonly unknown[],
  keys: readonly PropertyKey[],
): boolean {
  return (
    keys.length === value.length + 1 &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        (key === "length" ||
          (/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)),
    )
  );
}

function dataMember(
  value: object,
  key: string,
): { key: string; value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return;
  const member: unknown = descriptor.value;
  return { key, value: member };
}

function members(
  value: object,
): readonly { key: string; value: unknown }[] | undefined {
  if (!plainPrototype(value)) return;
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && !arrayKeys(value, keys)) return;
  const result: { key: string; value: unknown }[] = [];
  for (const key of keys) {
    if (typeof key !== "string") return;
    if (Array.isArray(value) && key === "length") continue;
    const member = dataMember(value, key);
    if (!member) return;
    result.push(member);
  }
  return result;
}

function primitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function inspectAnalysisData(value: unknown): readonly AnalysisCode[] {
  const active = new Set<object>();
  const stack: { value: unknown; leave?: object }[] = [{ value }];
  const codes = new Set<AnalysisCode>();
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    if (item.leave) {
      active.delete(item.leave);
      continue;
    }
    if (!enqueueData(item.value, { active, stack, codes }))
      return ["not-plain-data"];
  }
  return [...codes];
}

function enqueueData(
  value: unknown,
  context: {
    active: Set<object>;
    stack: { value: unknown; leave?: object }[];
    codes: Set<AnalysisCode>;
  },
): boolean {
  if (primitive(value)) return true;
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    context.active.has(value)
  )
    return false;
  const entries = members(value);
  if (!entries) return false;
  context.active.add(value);
  context.stack.push({ value: null, leave: value });
  for (const entry of entries) {
    if (forbiddenAnalysisField(entry.key)) context.codes.add("authority-field");
    context.stack.push({ value: entry.value });
  }
  return true;
}
