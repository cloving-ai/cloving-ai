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
import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
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

const product = resolve(import.meta.dirname, "..");
const flags = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = flags.lastIndexOf(name);
  return index === -1 ? undefined : flags[index + 1];
}

function topLevel(given: string): string {
  try {
    return execFileSync("git", ["-C", given, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return given;
  }
}

const runtimeArgument = flag("--runtime");
if (runtimeArgument === undefined)
  throw new Error("The start program needs --runtime. Use: cloving start");
const runtime = resolve(runtimeArgument);
const directory = dirname(runtime);
const repository = await realpath(
  topLevel(resolve(flag("--repository") ?? process.cwd())),
);
const updateMilliseconds = await selfUpdateMilliseconds({
  seconds: process.env["CLOVING_SELF_UPDATE_SECONDS"],
  repository,
  product:
    extname(import.meta.filename) === ".ts" ? topLevel(product) : product,
});
const client = flag("--client") ?? "cloving";
const project = join(directory, "project");
const concurrency = Number(process.env["CLOVING_HOST_BOUND"] ?? "8");
const leaseText = process.env["CLOVING_OWNERSHIP_LEASE_SECONDS"];
const leaseSeconds = leaseText === undefined ? undefined : Number(leaseText);
const defaultCommand = [
  "claude",
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch",
  "--max-budget-usd",
  "5",
];
const defaultCodexCommand = [
  "codex",
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "-",
];

function selectedWorker(): "claude" | "codex" {
  const worker = process.env["CLOVING_WORKER"] ?? "claude";
  if (worker === "claude" || worker === "codex") return worker;
  throw new Error(`The daemon did not start: invalid-worker: ${worker}`);
}

async function profilesFile(): Promise<TurnProfiles> {
  const path = process.env["CLOVING_PROFILES"];
  if (path === undefined) return {};
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isProfilesFile(value)) return value.profiles;
  } catch {
    throw new Error("The daemon did not start: invalid-profiles");
  }
  throw new Error("The daemon did not start: invalid-profiles");
}

interface Commands {
  readonly commands: LocalCommands;
  readonly commandSeconds: number;
  readonly fallbackModels: readonly string[];
  readonly tokenPrices: TokenPrices;
  readonly profiles: TurnProfiles;
  readonly worker: ReturnType<typeof selectedWorker>;
  readonly command: readonly string[];
  readonly ticketCommand: readonly string[] | undefined;
  readonly nextCommand: readonly string[] | undefined;
  readonly notifyCommand: readonly string[] | undefined;
  readonly githubCommand: readonly string[] | undefined;
  readonly checkCommand: readonly string[] | undefined;
  readonly privateTexts: readonly string[] | undefined;
  readonly queueMilliseconds: number | undefined;
  readonly queueLanes: number;
  readonly resetQueue: boolean;
}

function queueLanes(): number {
  const value = process.env["CLOVING_QUEUE_LANES"];
  if (value === undefined) return 1;
  if (!/^[1-4]$/.test(value))
    throw new Error("The daemon did not start: invalid-queue-lanes");
  if (process.env["CLOVING_QUEUE_SECONDS"] === undefined)
    throw new Error("The daemon did not start: queue-lanes-needs-queue");
  return Number(value);
}

function queueInterval(
  commands: Pick<Commands, "nextCommand" | "ticketCommand">,
): number | undefined {
  const value = process.env["CLOVING_QUEUE_SECONDS"];
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
  const given = process.env[name];
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
process.stdout.write(${JSON.stringify(guide())});
const stop = async () => { await opening.daemon.close(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
`,
  );
}

function guide(): string {
  return [
    "Cloving runs. Stop it with Control-C.",
    `Repository: ${repository}`,
    `Work trees: ${join(directory, "worktrees")}`,
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

const tokenPrices = parseTokenPrices(process.env["CLOVING_TOKEN_PRICES"]);
const commands = parseCommands(process.env["CLOVING_COMMANDS"]);
const commandSeconds = parseCommandSeconds(
  process.env["CLOVING_COMMAND_SECONDS"],
);
const fallbackModels = parseFallbackModels(
  process.env["CLOVING_FALLBACK_MODELS"],
);
const profiles = await profilesFile();
const worker = selectedWorker();
const command =
  worker === "codex"
    ? (listed("CLOVING_CODEX_COMMAND") ?? defaultCodexCommand)
    : (listed("CLOVING_CLAUDE_COMMAND") ?? defaultCommand);
const nextCommand = listed("CLOVING_NEXT_COMMAND");
const ticketCommand = listed("CLOVING_TICKET_COMMAND");
const lanes = queueLanes();
const queueMilliseconds = queueInterval({ nextCommand, ticketCommand });
const manifests = await preparedProject({
  product,
  project,
  repository,
  home: homedir(),
  xdgConfigHome: process.env["XDG_CONFIG_HOME"],
});
await launchers(
  {
    commands,
    commandSeconds,
    tokenPrices,
    fallbackModels,
    worker,
    profiles,
    command,
    ticketCommand,
    nextCommand,
    queueMilliseconds,
    queueLanes: lanes,
    resetQueue: flags.includes("--reset-queue"),
    notifyCommand: listed("CLOVING_NOTIFY_COMMAND"),
    githubCommand: listed("CLOVING_GH_COMMAND"),
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
  watchPort: process.env["CLOVING_WATCH_PORT"] ?? "3663",
});
