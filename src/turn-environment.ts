export type TurnVariables = "inherit" | readonly string[];

export interface TurnVariableRequest {
  readonly worker?: string;
  readonly variables?: TurnVariables;
}

type Variables = Readonly<Record<string, string | undefined>>;

export const githubTokens: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

export const baseVariables: readonly string[] = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

const loginVariables: Readonly<Record<string, readonly string[]>> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
  ],
  codex: ["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  "cursor-agent": ["CURSOR_API_KEY"],
  gemini: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
  ],
  grok: ["GROK_API_KEY", "XAI_API_KEY"],
  opencode: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"],
};

export function harnessLoginVariables(worker: string): readonly string[] {
  return Object.hasOwn(loginVariables, worker)
    ? (loginVariables[worker] ?? [])
    : [];
}

function allowedNames(request: TurnVariableRequest): ReadonlySet<string> {
  const listed = request.variables === "inherit" ? [] : request.variables;
  return new Set([
    ...baseVariables,
    ...harnessLoginVariables(request.worker ?? ""),
    ...(listed ?? []),
  ]);
}

function passes(request: TurnVariableRequest): (name: string) => boolean {
  const allowed = allowedNames(request);
  return (name) =>
    !githubTokens.includes(name) &&
    (request.variables === "inherit" || allowed.has(name));
}

export function passedVariables(
  environment: Variables,
  request: TurnVariableRequest,
): Readonly<Record<string, string>> {
  const passed = passes(request);
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && passed(entry[0]),
    ),
  );
}

const variableName =
  /^(?!(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_CONFIG_DIR)$)[A-Za-z_][A-Za-z0-9_]*$/;

function listedNames(text: string): readonly string[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) &&
      value.every(
        (item: unknown) => typeof item === "string" && variableName.test(item),
      )
      ? value.map(String)
      : undefined;
  } catch {
    return undefined;
  }
}

export function turnVariablesSetting(text: string | undefined): TurnVariables {
  if (text === undefined) return [];
  if (text === "inherit") return "inherit";
  const names = listedNames(text);
  if (names === undefined)
    throw new Error("invalid-setting: CLOVING_TURN_ENVIRONMENT");
  return names;
}

export function withheldVariables(
  environment: Variables,
  request: TurnVariableRequest,
): readonly string[] {
  const passed = passes(request);
  return Object.keys(environment)
    .filter(
      (name) =>
        !name.startsWith("CLOVING_") &&
        name !== "GH_CONFIG_DIR" &&
        !githubTokens.includes(name) &&
        !passed(name),
    )
    .sort();
}
