import {
  configuration,
  settingFields,
  type Configuration,
  type RedGreenSettings,
} from "./configuration-schema.ts";
import type { TurnProfiles } from "./turn-profile.ts";
import type { TokenPrices } from "./token-prices.ts";
import type { LocalCommands } from "./command-settings.ts";
import type { Fields } from "./protocol.ts";

export type SettingSource = "environment" | "private" | "project";

export type RecordedSource = SettingSource | "default";

export const reloadedSettingFields: readonly string[] = [
  "fallbackModels",
  "profiles",
  "queue.lanes",
  "queue.maxLoadPerCore",
  "queue.maxMemoryPressure",
  "queue.workingLanes",
  "tokenPrices",
  "workflows.folder",
];

export interface TurnSettings {
  readonly profiles: TurnProfiles;
  readonly fallbackModels: readonly string[];
  readonly tokenPrices: TokenPrices;
}

export type SettingValue =
  | null
  | string
  | number
  | readonly string[]
  | TurnProfiles
  | TokenPrices
  | RedGreenSettings
  | LocalCommands
  | Readonly<Record<string, Fields>>;

export const settingVariables: Readonly<Record<string, string>> = {
  "checks.beforeMerge": "CLOVING_CHECK_COMMAND",
  "checks.required": "CLOVING_REQUIRED_CHECKS",
  "checks.redGreen": "CLOVING_RED_GREEN",
  "merge.mode": "CLOVING_MERGE_MODE",
  "tickets.command": "CLOVING_TICKET_COMMAND",
  "tickets.nextCommand": "CLOVING_NEXT_COMMAND",
  "tickets.readyCommand": "CLOVING_READY_COMMAND",
  "queue.everySeconds": "CLOVING_QUEUE_SECONDS",
  "queue.lanes": "CLOVING_QUEUE_LANES",
  "queue.workingLanes": "CLOVING_QUEUE_WORKING_LANES",
  "queue.maxLoadPerCore": "CLOVING_QUEUE_MAX_LOAD_PER_CORE",
  "queue.maxMemoryPressure": "CLOVING_QUEUE_MAX_MEMORY_PRESSURE",
  "queue.dailySpendLimitUsd": "CLOVING_QUEUE_DAILY_SPEND_USD",
  "limits.effects": "CLOVING_LIMIT_EFFECTS",
  "limits.chain": "CLOVING_LIMIT_CHAIN",
  "spend.scope": "CLOVING_SPEND_SCOPE",
  "harness.name": "CLOVING_WORKER",
  fallbackModels: "CLOVING_FALLBACK_MODELS",
  tokenPrices: "CLOVING_TOKEN_PRICES",
  privateTexts: "CLOVING_PRIVATE_TEXTS",
  "notify.command": "CLOVING_NOTIFY_COMMAND",
  "watch.port": "CLOVING_WATCH_PORT",
  "watch.actions": "CLOVING_WATCH_ACTIONS",
  "watch.theme": "CLOVING_WATCH_THEME",
  "selfUpdate.everySeconds": "CLOVING_SELF_UPDATE_SECONDS",
  "github.command": "CLOVING_GH_COMMAND",
  "workflows.folder": "CLOVING_WORKFLOW_FOLDER",
  "retention.days": "CLOVING_RETENTION_DAYS",
  "retention.action": "CLOVING_RETENTION_ACTION",
  "retention.archiveFolder": "CLOVING_RETENTION_ARCHIVE_FOLDER",
  "turns.environment": "CLOVING_TURN_ENVIRONMENT",
  commands: "CLOVING_COMMANDS",
  commandSeconds: "CLOVING_COMMAND_SECONDS",
  schedules: "CLOVING_SCHEDULES",
  "demo.tool": "CLOVING_DEMO_TOOL",
};

const environmentOnly = [
  "CLOVING_RUNTIME_DIR",
  "CLOVING_OWNERSHIP_LEASE_SECONDS",
  "CLOVING_HOST_BOUND",
  "CLOVING_WATCH_REPOSITORY",
  "CLOVING_PHONE_RELAY",
  "CLOVING_RELAY_ORIGIN",
];

export function absoluteWorkflowFolder(
  folder: string | undefined,
): string | undefined {
  if (folder === undefined || folder.startsWith("/")) return folder;
  throw new Error(
    "invalid-setting: CLOVING_WORKFLOW_FOLDER must be an absolute path",
  );
}

export function configurationRoot(
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string {
  const configured = environment["XDG_CONFIG_HOME"];
  return configured?.startsWith("/")
    ? configured
    : `${environment["HOME"] ?? home}/.config`;
}

export function parseConfiguration(
  contents: string | undefined,
  scope: "project" | "private",
): Partial<Configuration> {
  if (contents === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`invalid-config-json: ${scope}`);
  }
  return configuration(value, scope);
}

export function configurationValues(
  values: Partial<Configuration>,
): Readonly<Record<string, SettingValue>> {
  const entries: [string, SettingValue][] = [];
  const groups: Readonly<
    Record<string, Readonly<Record<string, SettingValue>> | undefined>
  > = {
    checks: values.checks,
    merge: values.merge,
    tickets: values.tickets,
    queue: values.queue,
    limits: values.limits,
    spend: values.spend,
    harness: values.harness,
    notify: values.notify,
    watch: values.watch,
    selfUpdate: values.selfUpdate,
    github: values.github,
    workflows: values.workflows,
    retention: values.retention,
    turns: values.turns,
    demo: values.demo,
  };
  for (const [name, group] of Object.entries(groups)) {
    if (group === undefined) continue;
    for (const [child, item] of Object.entries(group))
      entries.push([`${name}.${child}`, item]);
  }
  const direct = {
    profiles: values.profiles,
    fallbackModels: values.fallbackModels,
    tokenPrices: values.tokenPrices,
    privateTexts: values.privateTexts,
    commands: values.commands,
    commandSeconds: values.commandSeconds,
    schedules: values.schedules,
  };
  for (const [name, value] of Object.entries(direct))
    if (value !== undefined) entries.push([name, value]);
  return Object.fromEntries(entries);
}

function encoded(value: SettingValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function harnessCommandMapping(
  name: SettingValue | undefined,
): Readonly<Record<string, string>> {
  if (name === "opencode")
    return { "harness.command": "CLOVING_OPENCODE_COMMAND" };
  if (name === "grok") return { "harness.command": "CLOVING_GROK_COMMAND" };
  if (name === "codex") return { "harness.command": "CLOVING_CODEX_COMMAND" };
  if (name === "gemini") return { "harness.command": "CLOVING_GEMINI_COMMAND" };
  if (name === undefined || name === "claude")
    return { "harness.command": "CLOVING_CLAUDE_COMMAND" };
  return {};
}

export interface HiddenFileValue {
  readonly field: string;
  readonly variable: string;
  readonly file: "private" | "project";
}

function hiddenFileValues(given: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly mapped: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, SettingValue>>;
  readonly privateFile: Readonly<Record<string, SettingValue>>;
}): readonly HiddenFileValue[] {
  return Object.entries(given.mapped).flatMap(
    ([field, variable]): HiddenFileValue[] =>
      given.environment[variable] === undefined ||
      given.values[field] === undefined
        ? []
        : [
            {
              field,
              variable,
              file: Object.hasOwn(given.privateFile, field)
                ? "private"
                : "project",
            },
          ],
  );
}

export function settingSourceMap(
  sources: Readonly<Record<string, SettingSource>>,
): Readonly<Record<string, RecordedSource>> {
  return {
    ...Object.fromEntries(
      settingFields().map((field): [string, RecordedSource] => [
        field,
        "default",
      ]),
    ),
    ...sources,
  };
}

export function startSettingLines(settings: {
  readonly sources: Readonly<Record<string, SettingSource>>;
  readonly hidden: readonly HiddenFileValue[];
}): readonly string[] {
  return [
    ...Object.entries(settings.sources).map(
      ([field, source]) => `${field}: ${source}`,
    ),
    ...settings.hidden.map(
      (value) =>
        `Warning: ${value.variable} in the environment hides ${value.field} in the ${value.file} file.`,
    ),
  ];
}

const harnessNames = ["claude", "codex", "gemini", "grok", "opencode"];

export function withoutFileVariables(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const names = new Set([
    ...Object.values(settingVariables),
    ...harnessNames.flatMap((name) =>
      Object.values(harnessCommandMapping(name)),
    ),
    "CLOVING_PROFILES",
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !names.has(name)),
  );
}

export function resolveSettings(
  environment: Readonly<NodeJS.ProcessEnv>,
  files: {
    readonly project: string | undefined;
    readonly private: string | undefined;
  },
): {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly profiles: TurnProfiles;
  readonly harness?: Configuration["harness"];
  readonly sources: Readonly<Record<string, SettingSource>>;
  readonly hidden: readonly HiddenFileValue[];
  readonly values: Readonly<Record<string, SettingValue>>;
} {
  const project = configurationValues(
    parseConfiguration(files.project, "project"),
  );
  const privateConfiguration = parseConfiguration(files.private, "private");
  const privateFile = configurationValues(privateConfiguration);
  const values = { ...project, ...privateFile };
  const resolved = { ...environment };
  const sources: Record<string, SettingSource> = {};
  const mapped = {
    ...settingVariables,
    ...harnessCommandMapping(values["harness.name"]),
    profiles: "CLOVING_PROFILES",
    ...Object.fromEntries(environmentOnly.map((name) => [name, name])),
  };
  for (const field of Object.keys(values))
    sources[field] = Object.hasOwn(privateFile, field) ? "private" : "project";
  for (const [field, variable] of Object.entries(mapped)) {
    const value = values[field];
    if (environment[variable] !== undefined) sources[field] = "environment";
    else if (field !== "profiles" && value !== undefined)
      resolved[variable] = encoded(value);
  }
  const profiles = privateConfiguration.profiles ?? {};
  return {
    environment: resolved,
    profiles,
    sources,
    hidden: hiddenFileValues({ environment, mapped, values, privateFile }),
    values,
    ...(privateConfiguration.harness === undefined
      ? {}
      : { harness: privateConfiguration.harness }),
  };
}

interface ResolvedFields {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly values: Readonly<Record<string, SettingValue>>;
  readonly profiles: TurnProfiles;
}

function resolvedValue(
  resolved: ResolvedFields & {
    readonly variables: Readonly<Record<string, string>>;
  },
  field: string,
): SettingValue | undefined {
  if (field === "profiles") return resolved.profiles;
  const variable = resolved.variables[field];
  return variable === undefined
    ? resolved.values[field]
    : resolved.environment[variable];
}

export function settingDigests(
  resolved: ResolvedFields,
  digest: (text: string) => string,
): Readonly<Record<string, string>> {
  const fields = {
    ...resolved,
    variables: {
      ...settingVariables,
      ...harnessCommandMapping(resolved.values["harness.name"]),
    },
  };
  return Object.fromEntries(
    settingFields().map((field) => [
      field,
      digest(JSON.stringify(resolvedValue(fields, field) ?? null)),
    ]),
  );
}
