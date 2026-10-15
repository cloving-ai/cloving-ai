export interface TurnProfile {
  readonly env?: Readonly<Record<string, string>>;
  readonly allowedTools?: readonly string[];
  readonly model?: string;
  readonly permissionMode?: string;
  readonly maxBudgetUsd?: number;
  readonly workflows?: readonly string[];
}

export type TurnProfiles = Readonly<Record<string, TurnProfile>>;

const fields = [
  "env",
  "allowedTools",
  "model",
  "permissionMode",
  "maxBudgetUsd",
  "workflows",
];
const reserved = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function texts(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text);
}

function environment(value: unknown): boolean {
  return (
    record(value) &&
    Object.entries(value).every(
      ([name, item]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !reserved.includes(name) &&
        text(item),
    )
  );
}

function validField(name: string, value: unknown): boolean {
  if (name === "env") return environment(value);
  if (name === "allowedTools" || name === "workflows") return texts(value);
  if (name === "model" || name === "permissionMode") return text(value);
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function profile(value: unknown): value is TurnProfile {
  return (
    record(value) &&
    Object.entries(value).every(
      ([name, item]) => fields.includes(name) && validField(name, item),
    )
  );
}

export function isProfilesFile(
  value: unknown,
): value is { readonly profiles: TurnProfiles } {
  if (
    !record(value) ||
    Object.keys(value).length !== 1 ||
    !record(value["profiles"])
  )
    return false;
  return Object.entries(value["profiles"]).every(
    ([name, item]) => /^[A-Za-z0-9_-]{1,119}$/.test(name) && profile(item),
  );
}

function replacements(profile: TurnProfile): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  if (profile.allowedTools !== undefined)
    values.set("--allowedTools", profile.allowedTools.join(","));
  if (profile.model !== undefined) values.set("--model", profile.model);
  if (profile.permissionMode !== undefined)
    values.set("--permission-mode", profile.permissionMode);
  if (profile.maxBudgetUsd !== undefined)
    values.set("--max-budget-usd", String(profile.maxBudgetUsd));
  return values;
}

function following(argumentsList: readonly string[], index: number): number {
  let next = index + 1;
  while (next < argumentsList.length && !argumentsList[next]?.startsWith("-"))
    next += 1;
  return next;
}

function retained(
  argumentsList: readonly string[],
  values: ReadonlyMap<string, string>,
): readonly string[] {
  const kept: string[] = [];
  for (let index = 0; index < argumentsList.length;) {
    const argument = argumentsList[index] ?? "";
    const name = argument.split("=")[0] ?? "";
    const flag = name === "--allowed-tools" ? "--allowedTools" : name;
    if (!values.has(flag)) {
      kept.push(argument);
      index += 1;
      continue;
    }
    if (argument.includes("=")) {
      index += 1;
      continue;
    }
    index =
      flag === "--allowedTools" ? following(argumentsList, index) : index + 2;
  }
  return kept;
}

export function profileCommand(
  command: readonly string[],
  profile: TurnProfile,
): readonly string[] {
  const [executable = "", ...argumentsList] = command;
  const separator = argumentsList.indexOf("--");
  const boundary = separator === -1 ? argumentsList.length : separator;
  const values = replacements(profile);
  return [
    executable,
    ...retained(argumentsList.slice(0, boundary), values),
    ...[...values].flat(),
    ...argumentsList.slice(boundary),
  ];
}
