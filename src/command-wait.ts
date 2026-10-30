import type { HandoffValue, CommandWaitRequest } from "./step-bridge.ts";

export type {
  CommandWaitRequest,
  CommandWaitOutcome,
  CommandWaitProgress,
} from "./step-bridge.ts";

export function isCommandWaitRequest(
  value: unknown,
): value is CommandWaitRequest {
  if (!dataFields(value, ["name", "input"])) return false;
  const name: unknown = Reflect.get(value, "name");
  return (
    typeof name === "string" &&
    name.length > 0 &&
    commandWaitValue(Reflect.get(value, "input"))
  );
}

function dataFields(value: unknown, keys: readonly string[]): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable === true && Object.hasOwn(field, "value");
    })
  );
}

export function commandWaitValue(
  value: unknown,
  ancestors: ReadonlySet<unknown> = new Set(),
): value is HandoffValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  return commandWaitObject(value, ancestors);
}

function commandWaitObject(
  value: object,
  ancestors: ReadonlySet<unknown>,
): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  const expectedPrototype: unknown = Object.getPrototypeOf(
    Array.isArray(value) ? [] : {},
  );
  if (prototype !== expectedPrototype && prototype !== null) return false;
  const keys = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : Object.keys(value);
  const ownKeys = Reflect.ownKeys(value).filter(
    (key) => !Array.isArray(value) || key !== "length",
  );
  if (keys.length !== ownKeys.length) return false;
  const seen = new Set([...ancestors, value]);
  return keys.every((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return (
      field?.enumerable === true &&
      Object.hasOwn(field, "value") &&
      commandWaitValue(field.value, seen)
    );
  });
}
