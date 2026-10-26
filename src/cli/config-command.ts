import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { settingScope, validateSetting } from "../configuration-schema.ts";
import { settingValue } from "../configuration-change.ts";
import {
  configurationEntries,
  type SettingEntry,
} from "../configuration-display.ts";
import { isProfilesFile, type TurnProfiles } from "../turn-profile.ts";
import type { ConfigInvocation } from "./config-arguments.ts";
import { changeConfigFile, readConfigFile } from "./config-file.ts";
import { privateSettingsPath } from "./project-settings.ts";
import { configNotice } from "./config-notice.ts";

type ConfigResult =
  | SettingEntry
  | { readonly settings: readonly SettingEntry[] }
  | {
      readonly field: string;
      readonly scope: "project" | "private";
      readonly action: "set" | "unset";
      readonly notice: string | null;
    };

async function environmentProfiles(): Promise<TurnProfiles | undefined> {
  const path = process.env["CLOVING_PROFILES"];
  if (path === undefined) return undefined;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isProfilesFile(value)) throw new Error("invalid-setting: profiles");
  return value.profiles;
}

async function entries(
  repository: string,
  field?: string,
): Promise<readonly SettingEntry[]> {
  const [project, privateFile, profiles] = await Promise.all([
    readConfigFile(join(repository, ".cloving/config.json")),
    readConfigFile(privateSettingsPath(process.env, repository)),
    environmentProfiles(),
  ]);
  return configurationEntries({
    project,
    private: privateFile,
    environment: process.env,
    ...(profiles === undefined ? {} : { profiles }),
    ...(field === undefined ? {} : { field }),
  });
}

function entryLine(entry: SettingEntry): string {
  const hidden = entry.hidden
    .map((item) => `; hidden ${item.source}: ${JSON.stringify(item.value)}`)
    .join("");
  return `${entry.field} = ${JSON.stringify(entry.value)} (${entry.source})${hidden}\n`;
}

function present(invocation: ConfigInvocation, result: ConfigResult): void {
  if (invocation.json) {
    process.stdout.write(
      JSON.stringify({ schemaVersion: 1, ...result }) + "\n",
    );
    return;
  }
  if ("settings" in result) {
    for (const entry of result.settings) process.stdout.write(entryLine(entry));
    return;
  }
  if ("source" in result) {
    process.stdout.write(entryLine(result));
    return;
  }
  process.stdout.write(`${result.action}: ${result.field}\n`);
  if (result.notice !== null) process.stdout.write(result.notice + "\n");
}

async function execute(
  invocation: ConfigInvocation,
  repository: string,
): Promise<ConfigResult> {
  if (invocation.action === "list")
    return { settings: await entries(repository) };
  const field = invocation.field ?? "";
  const defaultScope = settingScope(field);
  const scope = invocation.private ? "private" : defaultScope;
  if (invocation.action === "set")
    validateSetting(field, settingValue(invocation.value ?? ""));
  const [current] = await entries(repository, field);
  if (current === undefined) throw new Error(`unknown-setting: ${field}`);
  if (invocation.action === "get") return current;
  const path =
    scope === "private"
      ? privateSettingsPath(process.env, repository)
      : join(repository, ".cloving/config.json");
  await changeConfigFile(path, {
    field,
    scope,
    action: invocation.action,
    ...(invocation.value === undefined ? {} : { value: invocation.value }),
  });
  const notice = await configNotice(repository, {
    scope,
    entry: (await entries(repository, field))[0],
  });
  return { field, scope, action: invocation.action, notice };
}

export async function configCommand(
  invocation: ConfigInvocation,
  repository: string | undefined,
): Promise<number> {
  try {
    if (repository === undefined) throw new Error("repository-unknown");
    present(invocation, await execute(invocation, repository));
    return 0;
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "configuration-error";
    if (invocation.json)
      process.stdout.write(
        JSON.stringify({
          schemaVersion: 1,
          kind: "error",
          code: detail.split(":")[0],
          detail,
        }) + "\n",
      );
    else process.stderr.write(detail + "\n");
    return 2;
  }
}
