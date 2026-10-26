import { configuration } from "./configuration-schema.ts";
import { record } from "./protocol.ts";
import { isProfilesFile, type TurnProfiles } from "./turn-profile.ts";

export type SettingSource = "environment" | "private" | "project";

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
): Readonly<Record<string, unknown>> {
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
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const entries: [string, unknown][] = [];
  for (const [name, value] of Object.entries(values)) {
    if (
      [
        "checks",
        "tickets",
        "queue",
        "harness",
        "notify",
        "watch",
        "selfUpdate",
        "github",
      ].includes(name)
    ) {
      for (const [child, item] of Object.entries(record(value) ?? {}))
        entries.push([`${name}.${child}`, item]);
    } else if (name !== "version") entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function encoded(value: unknown): string {
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
  const privateFile = flatten(parse(files.private, "private"));
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
    if (environment[variable] !== undefined) sources[field] = "environment";
    else if (field !== "profiles" && Object.hasOwn(values, field))
      resolved[variable] = encoded(values[field]);
  }
  const inline = { profiles: values["profiles"] };
  const profiles = isProfilesFile(inline) ? inline.profiles : {};
  return { environment: resolved, profiles, sources };
}
