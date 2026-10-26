import {
  configuration,
  settingScope,
  validateSetting,
} from "./configuration-schema.ts";
import { parseConfiguration } from "./project-settings.ts";
import { record } from "./protocol.ts";

export interface SettingChange {
  readonly field: string;
  readonly action: "set" | "unset";
  readonly value?: string;
  readonly scope: "project" | "private";
}

export function settingValue(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
}

function trimHarness(root: Record<string, unknown>, field: string): void {
  const order = ["harness.name", "harness.kind", "harness.path"];
  const index = order.indexOf(field);
  const harness = record(root["harness"]);
  if (index < 0 || harness === undefined) return;
  const names = ["name", "kind", "path"].slice(0, index + 1);
  root["harness"] = Object.fromEntries(
    Object.entries(harness).filter(([name]) => names.includes(name)),
  );
}

function assign(
  root: Record<string, unknown>,
  change: SettingChange,
): Record<string, unknown> {
  const [name = "", ...tail] = change.field.split(".");
  if (tail.length === 0) {
    if (change.action === "unset")
      return Object.fromEntries(
        Object.entries(root).filter(([key]) => key !== name),
      );
    return { ...root, [name]: settingValue(change.value ?? "") };
  }
  const child = assign(
    { ...record(root[name]) },
    { ...change, field: tail.join(".") },
  );
  if (Object.keys(child).length === 0)
    return Object.fromEntries(
      Object.entries(root).filter(([key]) => key !== name),
    );
  return { ...root, [name]: child };
}

export function changedConfiguration(
  contents: string | undefined,
  change: SettingChange,
): string {
  settingScope(change.field);
  if (change.action === "set")
    validateSetting(change.field, settingValue(change.value ?? ""));
  const root: Record<string, unknown> = {
    version: 1,
    ...parseConfiguration(contents, change.scope),
  };
  trimHarness(root, change.field);
  const next = assign(root, change);
  configuration(next, change.scope);
  return JSON.stringify(next, null, 2) + "\n";
}
