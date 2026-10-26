import { settingFields, settingScope } from "./configuration-schema.ts";
import {
  configurationValues,
  parseConfiguration,
  settingVariables,
} from "./project-settings.ts";
import { settingValue } from "./configuration-change.ts";
import { defaultCommand, defaultCodexCommand } from "./harness-defaults.ts";
import { builtInPriceTable } from "./token-prices.ts";
import type { TurnProfiles } from "./turn-profile.ts";

type Source = "environment" | "private" | "project" | "default";
interface ValueSource {
  readonly value: unknown;
  readonly source: Source;
}
export interface SettingEntry extends ValueSource {
  readonly field: string;
  readonly hidden: readonly ValueSource[];
}

const defaults: Readonly<Record<string, unknown>> = {
  "queue.lanes": 1,
  "harness.name": "claude",
  tokenPrices: builtInPriceTable.prices,
  fallbackModels: [],
  profiles: {},
  "watch.port": 3663,
  "watch.actions": "on",
  "github.command": ["gh"],
};

export function configurationEntries(input: {
  readonly project: string | undefined;
  readonly private: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly field?: string;
  readonly profiles?: TurnProfiles;
}): readonly SettingEntry[] {
  const project = configurationValues(
    parseConfiguration(input.project, "project"),
  );
  const privateFile = configurationValues(
    parseConfiguration(input.private, "private"),
  );
  const worker =
    input.environment["CLOVING_WORKER"] ??
    privateFile["harness.name"] ??
    "claude";
  const variables = {
    ...settingVariables,
    profiles: "CLOVING_PROFILES",
    "harness.command":
      worker === "codex" ? "CLOVING_CODEX_COMMAND" : "CLOVING_CLAUDE_COMMAND",
  };
  const environment = Object.fromEntries(
    Object.entries(variables).flatMap(([field, variable]) => {
      const value = input.environment[variable];
      return value === undefined ? [] : [[field, settingValue(value)]];
    }),
  );
  if (input.profiles !== undefined) environment["profiles"] = input.profiles;
  const effectiveDefaults: Readonly<Record<string, unknown>> = {
    ...defaults,
    "harness.command":
      worker === "codex" ? defaultCodexCommand : defaultCommand,
  };
  const fields = input.field === undefined ? settingFields() : [input.field];
  return fields.map((field) => {
    settingScope(field);
    const layers: readonly [Source, Readonly<Record<string, unknown>>][] = [
      ["environment", environment],
      ["private", privateFile],
      ["project", project],
    ];
    const configured = layers.flatMap(([source, values]) => {
      const value = values[field];
      return value === undefined ? [] : [{ source, value }];
    });
    const [effective, ...hidden] = configured;
    return {
      field,
      ...(effective ?? {
        source: "default",
        value: effectiveDefaults[field] ?? null,
      }),
      hidden,
    };
  });
}
