export interface ContainerRunner {
  readonly kind: "container";
  readonly engine: string;
  readonly image: string;
}

export interface SeatbeltRunner {
  readonly kind: "seatbelt";
  readonly command?: string;
  readonly network?: readonly string[];
}

export type TurnRunner =
  { readonly kind: "host" } | SeatbeltRunner | ContainerRunner;

export interface RunnerPlaces {
  readonly directory: string;
  readonly commonFolder: string;
  readonly attachments?: string;
  readonly temporary: string;
  readonly settingsFile: string;
  readonly name: string;
  readonly variables: readonly string[];
}

function command(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.startsWith("-") &&
    !value.includes("\0")
  );
}

function hosts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === "string" && /^[A-Za-z0-9*][A-Za-z0-9*.:-]*$/.test(item),
    )
  );
}

const runnerFields: Readonly<Record<string, readonly string[]>> = {
  host: ["kind"],
  seatbelt: ["kind", "command", "network"],
  container: ["kind", "engine", "image"],
};

function runnerField(name: string, value: unknown): boolean {
  return name === "network" ? hosts(value) : name === "kind" || command(value);
}

export function isTurnRunner(value: unknown): value is TurnRunner {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const kind: unknown = Reflect.get(value, "kind");
  const allowed =
    typeof kind === "string" && Object.hasOwn(runnerFields, kind)
      ? runnerFields[kind]
      : undefined;
  if (allowed === undefined) return false;
  const required = kind === "container" ? ["engine", "image"] : [];
  return (
    required.every((name) => Object.hasOwn(value, name)) &&
    Object.entries(value).every(
      ([name, item]) => allowed.includes(name) && runnerField(name, item),
    )
  );
}

const hostOnlyVariables = [
  "GH_CONFIG_DIR",
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

const gitSettings = [
  "GIT_CONFIG_COUNT=1",
  "GIT_CONFIG_KEY_0=safe.directory",
  "GIT_CONFIG_VALUE_0=*",
];

function probed(
  command: readonly string[],
  places: RunnerPlaces,
): readonly string[] {
  return [
    "sh",
    "-c",
    'test -w "$1" || { echo runner-git-readonly >&2; exit 78; }; shift; exec "$@"',
    "cloving-runner",
    places.commonFolder,
    ...command,
  ];
}

function mounted(path: string): readonly string[] {
  return ["-v", `${path}:${path}`];
}

function protectedGit(commonFolder: string): readonly string[] {
  return ["hooks", "config"].flatMap((name) => {
    const path = `${commonFolder}/${name}`;
    return ["-v", `${path}:${path}:ro`];
  });
}

function volumeName(directory: string): string {
  const name = directory.slice(directory.lastIndexOf("/") + 1);
  return `cloving-modules-${name.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

function containerCommand(
  runner: ContainerRunner,
  start: { readonly command: readonly string[]; readonly places: RunnerPlaces },
): readonly string[] {
  const { places } = start;
  return [
    runner.engine,
    "run",
    "--rm",
    "-i",
    "--name",
    places.name,
    ...mounted(places.directory),
    ...mounted(places.commonFolder),
    ...protectedGit(places.commonFolder),
    ...(places.attachments === undefined ? [] : mounted(places.attachments)),
    "-v",
    `${volumeName(places.directory)}:${places.directory}/node_modules`,
    "-w",
    places.directory,
    ...[
      ...gitSettings,
      ...places.variables.filter((name) => !hostOnlyVariables.includes(name)),
    ].flatMap((variable) => ["-e", variable]),
    runner.image,
    ...probed(start.command, places),
  ];
}

export function runnerCommand(
  runner: TurnRunner | undefined,
  start: { readonly command: readonly string[]; readonly places: RunnerPlaces },
): readonly string[] {
  if (runner === undefined || runner.kind === "host") return start.command;
  if (runner.kind === "container") return containerCommand(runner, start);
  return [
    runner.command ?? "srt",
    "--settings",
    start.places.settingsFile,
    "--",
    ...probed(start.command, start.places),
  ];
}

export function seatbeltSettings(
  runner: SeatbeltRunner,
  places: Omit<RunnerPlaces, "settingsFile" | "name" | "variables">,
) {
  return {
    network: { allowedDomains: runner.network ?? [], deniedDomains: [] },
    filesystem: {
      denyRead: [],
      allowWrite: [
        places.directory,
        places.commonFolder,
        ...(places.attachments === undefined ? [] : [places.attachments]),
        places.temporary,
      ],
      denyWrite: [
        `${places.commonFolder}/hooks`,
        `${places.commonFolder}/config`,
      ],
    },
  };
}

export function runnerRefusal(
  runner: TurnRunner | undefined,
  end: { readonly exitCode: number | null; readonly result: unknown },
): string | undefined {
  if (runner === undefined || runner.kind === "host") return undefined;
  return end.exitCode === 78 && end.result === undefined
    ? "runner-git-readonly"
    : undefined;
}
