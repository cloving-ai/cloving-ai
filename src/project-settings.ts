import { configuration, type Configuration } from "./configuration-schema.ts";
import type { TurnProfiles } from "./turn-profile.ts";
import type { TokenPrices } from "./token-prices.ts";

export type SettingSource = "environment" | "private" | "project";

type SettingValue =
  string | number | readonly string[] | TurnProfiles | TokenPrices;

const fields: Readonly<Record<string, string>> = {
  "checks.beforeMerge": "CLOVING_CHECK_COMMAND",
  "checks.required": "CLOVING_REQUIRED_CHECKS",
  "tickets.command": "CLOVING_TICKET_COMMAND",
  "tickets.nextCommand": "CLOVING_NEXT_COMMAND",
  "queue.everySeconds": "CLOVING_QUEUE_SECONDS",
  "queue.lanes": "CLOVING_QUEUE_LANES",
  "harness.name": "CLOVING_WORKER",
  fallbackModels: "CLOVING_FALLBACK_MODELS",
  tokenPrices: "CLOVING_TOKEN_PRICES",
  privateTexts: "CLOVING_PRIVATE_TEXTS",
  "notify.command": "CLOVING_NOTIFY_COMMAND",
  "watch.port": "CLOVING_WATCH_PORT",
  "watch.actions": "CLOVING_WATCH_ACTIONS",
  "selfUpdate.everySeconds": "CLOVING_SELF_UPDATE_SECONDS",
  "github.command": "CLOVING_GH_COMMAND",
};

const environmentOnly = [
  "CLOVING_RUNTIME_DIR",
  "CLOVING_OWNERSHIP_LEASE_SECONDS",
  "CLOVING_HOST_BOUND",
  "CLOVING_WATCH_REPOSITORY",
  "CLOVING_COMMANDS",
  "CLOVING_COMMAND_SECONDS",
  "CLOVING_PHONE_RELAY",
  "CLOVING_RELAY_ORIGIN",
];

export function configurationRoot(
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string {
  const configured = environment["XDG_CONFIG_HOME"];
  return configured?.startsWith("/")
    ? configured
    : `${environment["HOME"] ?? home}/.config`;
}

function parse(
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

function flatten(
  values: Partial<Configuration>,
): Readonly<Record<string, SettingValue>> {
  const entries: [string, SettingValue][] = [];
  const groups: Readonly<
    Record<string, Readonly<Record<string, SettingValue>> | undefined>
  > = {
    checks: values.checks,
    tickets: values.tickets,
    queue: values.queue,
    harness: values.harness,
    notify: values.notify,
    watch: values.watch,
    selfUpdate: values.selfUpdate,
    github: values.github,
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
  };
  for (const [name, value] of Object.entries(direct))
    if (value !== undefined) entries.push([name, value]);
  return Object.fromEntries(entries);
}

function encoded(value: SettingValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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
  readonly sources: Readonly<Record<string, SettingSource>>;
} {
  const project = flatten(parse(files.project, "project"));
  const privateConfiguration = parse(files.private, "private");
  const privateFile = flatten(privateConfiguration);
  const values = { ...project, ...privateFile };
  const resolved = { ...environment };
  const sources: Record<string, SettingSource> = {};
  const worker = environment["CLOVING_WORKER"] ?? values["harness.name"];
  const commandVariable =
    worker === "codex" ? "CLOVING_CODEX_COMMAND" : "CLOVING_CLAUDE_COMMAND";
  const mapped = {
    ...fields,
    "harness.command": commandVariable,
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
  return { environment: resolved, profiles, sources };
}
