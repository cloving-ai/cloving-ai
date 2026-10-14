import { execFileSync, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { workflowFiles, workflowManifests } from "./self-host-workflows.ts";
import { isWorkflowManifest } from "./workflow-manifest.ts";

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
const repository = topLevel(resolve(flag("--repository") ?? process.cwd()));
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

interface Commands {
  readonly command: readonly string[];
  readonly ticketCommand: readonly string[] | undefined;
  readonly githubCommand: readonly string[] | undefined;
  readonly checkCommand: readonly string[] | undefined;
  readonly privateTexts: readonly string[] | undefined;
}

function listed(name: string): readonly string[] | undefined {
  const given = process.env[name];
  if (given === undefined) return undefined;
  const list: unknown = JSON.parse(given);
  if (!Array.isArray(list) || !list.every((part) => typeof part === "string"))
    throw new Error(`${name} is not a JSON list of texts.`);
  return list.map(String);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function ended(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((settle, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: project,
      env: environment,
      stdio: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => child.kill(signal));
    child.once("error", reject);
    child.once("close", (status) => {
      settle(status ?? 1);
    });
  });
}

async function linkedPackages(): Promise<void> {
  const modules = join(project, "node_modules");
  await mkdir(join(modules, "cloving"), { recursive: true });
  for (const entry of await readdir(join(product, "node_modules")))
    await symlink(join(product, "node_modules", entry), join(modules, entry));
  const manifest = record(
    JSON.parse(await readFile(join(product, "package.json"), "utf8")),
  );
  const exported = Object.keys(record(manifest["exports"])).filter((subpath) =>
    subpath.startsWith("./workflows"),
  );
  await symlink(join(product, "src"), join(modules, "cloving", "src"));
  await writeFile(
    join(modules, "cloving", "package.json"),
    JSON.stringify({
      name: manifest["name"],
      version: manifest["version"],
      type: "module",
      exports: Object.fromEntries(
        exported.map((subpath) => [
          subpath,
          `./src/${subpath.slice("./workflows/".length) || "workflows"}.ts`,
        ]),
      ),
    }),
  );
}

async function registered(): Promise<Readonly<Record<string, string>>> {
  const compiled: unknown = JSON.parse(
    await readFile(join(project, "artifacts/manifest.json"), "utf8"),
  );
  if (!isWorkflowManifest(compiled))
    throw new Error("The compiled workflow manifest is invalid.");
  const paths: Record<string, string> = {};
  for (const [functionName, manifest] of Object.entries(
    workflowManifests(compiled),
  )) {
    const path = join(project, `${manifest.name}.workflow.json`);
    await writeFile(path, JSON.stringify(manifest));
    paths[functionName] = path;
  }
  return paths;
}

function source(file: string): string {
  return JSON.stringify(pathToFileURL(join(product, file)).href);
}

async function launchers(
  commands: Commands,
  manifests: Readonly<Record<string, string>>,
): Promise<void> {
  const settings = {
    ...commands,
    directory,
    repository,
    concurrency,
    runtimeDirectory: runtime,
    manifests,
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
const opening = await startDaemon({ ...${JSON.stringify(settings)}, workflows, handler: POST });
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

async function prepared(): Promise<Readonly<Record<string, string>>> {
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, "workflows"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    '{"name":"cloving-self-host","private":true,"type":"module"}',
  );
  for (const file of await workflowFiles(join(product, "workflows")))
    await copyFile(
      join(product, "workflows", file),
      join(project, "workflows", file),
    );
  await linkedPackages();
  const compiled = await ended(
    [join(product, "tools/compile-workflows.ts"), "workflows", "artifacts"],
    process.env,
  );
  if (compiled !== 0) throw new Error("The workflows did not compile.");
  return registered();
}

const manifests = await prepared();
await launchers(
  {
    command: listed("CLOVING_CLAUDE_COMMAND") ?? defaultCommand,
    ticketCommand: listed("CLOVING_TICKET_COMMAND"),
    githubCommand: listed("CLOVING_GH_COMMAND"),
    checkCommand: listed("CLOVING_CHECK_COMMAND"),
    privateTexts: listed("CLOVING_PRIVATE_TEXTS"),
  },
  manifests,
);
const watchPort = process.env["CLOVING_WATCH_PORT"] ?? "3663";
const watch =
  watchPort === "off"
    ? undefined
    : spawn(
        process.execPath,
        [join(product, "src/cli.ts"), "watch", "--port", watchPort],
        {
          stdio: "inherit",
          env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
        },
      );
process.exitCode = await ended([join(project, "start.mjs")], process.env);
watch?.kill("SIGTERM");
