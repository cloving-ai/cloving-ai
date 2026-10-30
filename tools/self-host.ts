import {
  turnHarness,
  harnessDefaults,
  nativeHarness,
  type HarnessSettings,
  type NativeHarness,
} from "../src/harness-defaults.ts";
import { absoluteWorkflowFolder } from "../src/project-settings.ts";
import {
  projectConfiguration,
  projectRoot,
  topLevel,
} from "./project-configuration.ts";
import { isProfilesFile, type TurnProfiles } from "../src/turn-profile.ts";
import {
  parseCommands,
  parseCommandSeconds,
  type LocalCommands,
} from "../src/command-settings.ts";
import {
  parseFallbackModels,
  parseTokenPrices,
  type TokenPrices,
} from "../src/token-prices.ts";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  preparedProject,
  type RegisteredWorkflows,
} from "./self-host-project.ts";
import { selfUpdateMilliseconds } from "./self-update-host.ts";
import { hostedPrograms } from "./self-host-processes.ts";
import { workflowBundleLoader } from "./self-host-workflows.ts";
import { adoptRuntimeDirectory } from "./self-host-runtime.ts";
import { parseSchedulesSetting } from "../src/workflow-schedule.ts";

const product = resolve(import.meta.dirname, "..");
const flags = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = flags.findLastIndex(
    (argument) => argument === name || argument.startsWith(`${name}=`),
  );
  const argument = flags[index];
  return argument === name
    ? flags[index + 1]
    : argument?.slice(name.length + 1);
}

const runtimeArgument = flag("--runtime");
if (runtimeArgument === undefined)
  throw new Error("The start program needs --runtime. Use: cloving start");
const repository = await projectRoot(flag("--repository") ?? process.cwd());
const configuration = await projectConfiguration(repository, process.env);
const environment = configuration.environment;
const selectedRuntime = await adoptRuntimeDirectory({
  runtime: resolve(runtimeArgument),
  repository,
  legacyRuntime: flag("--legacy-runtime"),
  adoptionRecord: flag("--adoption-record"),
});
const runtime = selectedRuntime.runtime;
const directory = dirname(runtime);
const updateMilliseconds = await selfUpdateMilliseconds({
  seconds: environment["CLOVING_SELF_UPDATE_SECONDS"],
  repository,
  product:
    extname(import.meta.filename) === ".ts" ? topLevel(product) : product,
});
const client = flag("--client") ?? "cloving";
const project = join(directory, "project");
const concurrency = Number(environment["CLOVING_HOST_BOUND"] ?? "8");
const leaseText = environment["CLOVING_OWNERSHIP_LEASE_SECONDS"];
const leaseSeconds = leaseText === undefined ? undefined : Number(leaseText);

function selectedWorker(): string {
  return checkedWorker(environment["CLOVING_WORKER"] ?? "claude");
}

function checkedWorker(name: string): string {
  try {
    return turnHarness({
      worker: name,
      ...(configuration.harness === undefined
        ? {}
        : { harness: configuration.harness }),
    }).worker;
  } catch (error) {
    throw new Error(`The daemon did not start: harness-no-worker: ${name}`, {
      cause: error,
    });
  }
}

async function profilesFile(): Promise<TurnProfiles> {
  const path = environment["CLOVING_PROFILES"];
  if (path === undefined) return configuration.profiles;
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isProfilesFile(value)) return value.profiles;
  } catch {
    throw new Error("The daemon did not start: invalid-profiles");
  }
  throw new Error("The daemon did not start: invalid-profiles");
}

interface Commands extends HarnessSettings {
  readonly commands: LocalCommands;
  readonly commandSeconds: number;
  readonly schedules: unknown;
  readonly fallbackModels: readonly string[];
  readonly tokenPrices: TokenPrices;
  readonly profiles: TurnProfiles;
  readonly worker: ReturnType<typeof selectedWorker>;
  readonly command: readonly string[];
  readonly ticketCommand: readonly string[] | undefined;
  readonly nextCommand: readonly string[] | undefined;
  readonly notifyCommand: readonly string[] | undefined;
  readonly githubCommand: readonly string[] | undefined;
  readonly requiredChecks: readonly string[] | null;
  readonly checkCommand: readonly string[] | undefined;
  readonly privateTexts: readonly string[] | undefined;
  readonly queueMilliseconds: number | undefined;
  readonly queueLanes: number;
  readonly queueDailySpendLimitUsd: number | undefined;
  readonly resetQueue: boolean;
}

function queueLanes(): number {
  const value = environment["CLOVING_QUEUE_LANES"];
  if (value === undefined) return 1;
  if (!/^[1-4]$/.test(value))
    throw new Error("The daemon did not start: invalid-queue-lanes");
  if (environment["CLOVING_QUEUE_SECONDS"] === undefined)
    throw new Error("The daemon did not start: queue-lanes-needs-queue");
  return Number(value);
}

function queueSpendLimit(): number | undefined {
  const value = environment["CLOVING_QUEUE_DAILY_SPEND_USD"];
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0)
    throw new Error("The daemon did not start: invalid-queue-spend-limit");
  if (environment["CLOVING_QUEUE_SECONDS"] === undefined)
    throw new Error("The daemon did not start: queue-spend-limit-needs-queue");
  return limit;
}

function queueInterval(
  commands: Pick<Commands, "nextCommand" | "ticketCommand">,
): number | undefined {
  const value = environment["CLOVING_QUEUE_SECONDS"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(seconds) ||
    seconds < 10 ||
    seconds > 3600
  )
    throw new Error("The daemon did not start: invalid-queue-seconds");
  if (!commands.nextCommand?.length)
    throw new Error("The daemon did not start: queue-needs-next-command");
  if (!commands.ticketCommand?.length)
    throw new Error("The daemon did not start: queue-needs-ticket-command");
  return seconds * 1000;
}

function listed(name: string): readonly string[] | undefined {
  const given = environment[name];
  if (given === undefined) return undefined;
  const list: unknown = JSON.parse(given);
  if (!Array.isArray(list) || !list.every((part) => typeof part === "string"))
    throw new Error(`${name} is not a JSON list of texts.`);
  return list.map(String);
}

function source(file: string): string {
  return JSON.stringify(
    pathToFileURL(
      join(product, file.replace(/\.ts$/, extname(import.meta.filename))),
    ).href,
  );
}

async function launchers(
  commands: Commands,
  workflows: RegisteredWorkflows,
): Promise<void> {
  const settings = {
    ...commands,
    directory,
    concurrency,
    runtimeDirectory: runtime,
    ...workflows,
  };
  await writeFile(
    join(project, "start.mjs"),
    `import { hostEnvironment } from ${source("src/daemon/host-environment.ts")};
Object.assign(process.env, hostEnvironment(${JSON.stringify({ directory, concurrency, leaseSeconds })}));
await import("./main.mjs");
`,
  );
  await writeFile(
    join(project, "main.mjs"),
    `import * as workflows from "./artifacts/client.mjs";
import { POST } from "./artifacts/flow.mjs";
import { startDaemon } from ${source("src/daemon/daemon.ts")};
${workflowBundleLoader()}
const opening = await startDaemon({ ...JSON.parse(${JSON.stringify(JSON.stringify(settings))}), workflows, handler: POST, loadBundle: loadWorkflowBundle });
if (opening.kind !== "started") {
  process.stderr.write("The daemon did not start: " + opening.reason + ": " + opening.detail + "\\n");
  process.exit(1);
}
process.stdout.write(${JSON.stringify(guide(workflows))});
const stop = async () => { await opening.daemon.close(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
`,
  );
}

function guide(workflows: RegisteredWorkflows): string {
  return [
    "Cloving runs. Stop it with Control-C.",
    `Repository: ${repository}`,
    `Runtime directory: ${runtime}`,
    `Work trees: ${join(directory, "worktrees")}`,
    ...(selectedRuntime.note === "" ? [] : [selectedRuntime.note]),
    ...Object.entries(configuration.sources).map(
      ([field, source]) => `${field}: ${source}`,
    ),
    ...workflows.workflowRefusals.map(
      (refusal) =>
        `Refused workflow ${refusal.scope} ${refusal.label}: ${refusal.codes.join(", ")}`,
    ),
    "Commands for a second terminal:",
    `  ${client} run develop-ticket --ticket <ticket-id>`,
    `  ${client} run develop-issue --ticket <ticket-id>`,
    `  ${client} run develop-prompt --prompt "<the text of the task>"`,
    `  ${client} run develop-prd --prompt "<the idea>"`,
    `  ${client} status`,
    `  ${client} questions`,
    `  ${client} watch`,
    "",
  ].join("\n");
}

const tokenPrices = parseTokenPrices(environment["CLOVING_TOKEN_PRICES"]);
const commands = parseCommands(environment["CLOVING_COMMANDS"]);
const commandSeconds = parseCommandSeconds(
  environment["CLOVING_COMMAND_SECONDS"],
);
const fallbackModels = parseFallbackModels(
  environment["CLOVING_FALLBACK_MODELS"],
);
const profiles = await profilesFile();
const schedules = parseSchedulesSetting(environment["CLOVING_SCHEDULES"]);
const worker = selectedWorker();
function nativeCommands(): Readonly<
  Partial<Record<NativeHarness, readonly string[]>>
> {
  const names = new Set([
    worker,
    ...Object.values(profiles).map((profile) =>
      checkedWorker(profile.harness ?? worker),
    ),
  ]);
  return Object.fromEntries(
    [...names].filter(nativeHarness).flatMap((name) => {
      const variable = harnessDefaults(name).variable;
      const command = variable === undefined ? undefined : listed(variable);
      return command === undefined ? [] : [[name, command]];
    }),
  );
}
const workerCommands = nativeCommands();
const harness = configuration.harness ?? {};
const command = turnHarness({ worker, workerCommands, harness }).command;
const nextCommand = listed("CLOVING_NEXT_COMMAND");
const ticketCommand = listed("CLOVING_TICKET_COMMAND");
const queueDailySpendLimitUsd = queueSpendLimit();
const lanes = queueLanes();
const queueMilliseconds = queueInterval({ nextCommand, ticketCommand });
const manifests = await preparedProject({
  product,
  project,
  repository,
  home: homedir(),
  xdgConfigHome: environment["XDG_CONFIG_HOME"],
  userFolder: absoluteWorkflowFolder(environment["CLOVING_WORKFLOW_FOLDER"]),
});
await launchers(
  {
    commands,
    commandSeconds,
    schedules,
    tokenPrices,
    fallbackModels,
    worker,
    workerCommands,
    harness,
    shell: environment["SHELL"] ?? "/bin/sh",
    profiles,
    command,
    ticketCommand,
    nextCommand,
    queueMilliseconds,
    queueLanes: lanes,
    queueDailySpendLimitUsd,
    resetQueue: flags.includes("--reset-queue"),
    notifyCommand: listed("CLOVING_NOTIFY_COMMAND"),
    githubCommand: listed("CLOVING_GH_COMMAND"),
    requiredChecks: listed("CLOVING_REQUIRED_CHECKS") ?? null,
    checkCommand: listed("CLOVING_CHECK_COMMAND"),
    privateTexts: listed("CLOVING_PRIVATE_TEXTS"),
  },
  manifests,
);
process.exitCode = await hostedPrograms({
  project,
  product,
  runtime,
  directory,
  repository,
  updateMilliseconds,
  watchPort: environment["CLOVING_WATCH_PORT"] ?? "3663",
  phoneRelay: environment["CLOVING_PHONE_RELAY"] ?? "on",
});
