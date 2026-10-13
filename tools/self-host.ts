import { spawn } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ticketWorkflowSource } from "./ticket-workflow.ts";

const product = resolve(import.meta.dirname, "..");
const [directoryArgument, repositoryArgument] = process.argv.slice(2);
if (!directoryArgument)
  throw new Error(
    "Usage: npm run self:start -- HOST_DIRECTORY [REPOSITORY_DIRECTORY]",
  );
const directory = resolve(directoryArgument);
const repository = resolve(repositoryArgument ?? product);
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
  "Bash,Read,Edit,Write,Glob,Grep",
  "--max-budget-usd",
  "5",
];

interface Commands {
  readonly command: readonly string[];
  readonly ticketCommand: readonly string[] | undefined;
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

function identifiers(category: unknown, key: string): string[] {
  return Object.values(record(category)).flatMap((entries) =>
    Object.values(record(entries)).map((entry) => String(record(entry)[key])),
  );
}

async function registered(): Promise<void> {
  const compiled = record(
    JSON.parse(
      await readFile(join(project, "artifacts/manifest.json"), "utf8"),
    ),
  );
  const workflowId = identifiers(compiled["workflows"], "workflowId").find(
    (identifier) => identifier.endsWith("//developTicket"),
  );
  await writeFile(
    join(project, "cloving.workflow.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "develop-ticket",
      workflowId,
      steps: identifiers(compiled["steps"], "stepId").filter((identifier) =>
        identifier.startsWith("step//cloving/"),
      ),
      capabilities: ["claude"],
      resources: [],
      artifacts: "artifacts",
    }),
  );
}

function source(file: string): string {
  return JSON.stringify(pathToFileURL(join(product, file)).href);
}

async function launchers(commands: Commands): Promise<void> {
  const settings = {
    ...commands,
    directory,
    repository,
    concurrency,
    manifest: join(project, "cloving.workflow.json"),
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
const opening = await startDaemon({ ...${JSON.stringify(settings)}, workflows: { "develop-ticket": workflows.developTicket, "develop-prompt": workflows.developTicket }, handler: POST });
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
  const client = `CLOVING_RUNTIME_DIR=${join(directory, "runtime")} node ${join(product, "src/cli.ts")}`;
  return [
    "Cloving runs. Stop it with Control-C.",
    `Repository: ${repository}`,
    `Work trees: ${join(directory, "worktrees")}`,
    "Commands for a second terminal:",
    `  ${client} run develop-ticket --ticket <ticket-id>`,
    `  ${client} run develop-prompt --prompt "<the text of the task>"`,
    `  ${client} status`,
    `  ${client} questions`,
    `  ${client} approve <decision-ref> --expected-revision <n> --generation <n> --subject-digest <digest>`,
    "",
  ].join("\n");
}

async function prepared(): Promise<void> {
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, "workflows"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    '{"name":"cloving-self-host","private":true,"type":"module"}',
  );
  await writeFile(
    join(project, "workflows/develop-ticket.ts"),
    ticketWorkflowSource(repository),
  );
  await linkedPackages();
  const compiled = await ended(
    [join(product, "tools/compile-workflows.ts"), "workflows", "artifacts"],
    process.env,
  );
  if (compiled !== 0) throw new Error("The ticket workflow did not compile.");
  await registered();
}

await prepared();
await launchers({
  command: listed("CLOVING_CLAUDE_COMMAND") ?? defaultCommand,
  ticketCommand: listed("CLOVING_TICKET_COMMAND"),
});
process.exitCode = await ended([join(project, "start.mjs")], process.env);
