import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { workflowTestLoader } from "./workflow-test-loader.ts";
import { preparedProject } from "./self-host-project.ts";
import type { WorkflowListing } from "./workflow-folders.ts";

const usage =
  "Usage: cloving workflows list [--json] [--repository <directory>]\n       cloving workflows test [<id>] [--repository <directory>]\n";

function invocation(argumentsList: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...argumentsList],
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      repository: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, id, ...extra] = positionals;
  if (extra.length > 0 || (command === "list" && id !== undefined))
    throw new Error("unexpected-argument");
  if (command !== "list" && command !== "test")
    throw new Error("unknown-command");
  if (command === "test" && values.json) throw new Error("unexpected-option");
  return { ...values, command, id };
}

export async function workflowCommand(
  argumentsList: readonly string[],
): Promise<number> {
  let selected;
  try {
    selected = invocation(argumentsList);
  } catch {
    process.stderr.write("invalid-invocation: " + usage);
    return 2;
  }
  if (selected.help) {
    process.stdout.write(usage);
    return 0;
  }
  const temporary = await mkdtemp(join(tmpdir(), "cloving-workflows-"));
  try {
    const repository = resolve(selected.repository ?? process.cwd());
    const result = await preparedProject({
      product: resolve(import.meta.dirname, ".."),
      project: join(temporary, "project"),
      repository,
      home: homedir(),
      xdgConfigHome: process.env["XDG_CONFIG_HOME"],
    });
    if (selected.command === "test")
      return await testWorkflows(result.workflows, {
        id: selected.id,
        repository,
      });
    presentWorkflows(result.workflows, { json: selected.json === true });
    return 0;
  } catch (error) {
    process.stderr.write(
      "workflow-inspection-failed: " +
        (error instanceof Error ? error.message : "unavailable") +
        "\n",
    );
    return 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function presentWorkflows(
  workflows: readonly WorkflowListing[],
  options: { readonly json: boolean },
): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(workflows) + "\n");
    return;
  }
  for (const workflow of workflows)
    process.stdout.write(
      `${workflow.workflowId ?? "unknown"} (${workflow.scope}, ${workflow.admitted ? "admitted" : "refused: " + workflow.codes.join(", ")}) ${JSON.stringify(workflow.file)}\n`,
    );
}

async function testWorkflows(
  workflows: readonly WorkflowListing[],
  options: { readonly id: string | undefined; readonly repository: string },
): Promise<number> {
  const { id, repository } = options;
  const selected = workflows.filter(
    (workflow) =>
      workflow.scope !== "bundled" &&
      (id === undefined || workflow.workflowId === id),
  );
  if (
    id !== undefined &&
    !workflows.some((workflow) => workflow.workflowId === id)
  ) {
    process.stderr.write("unknown-workflow: " + id + "\n");
    return 1;
  }
  const files: string[] = [];
  for (const workflow of selected) {
    const file = workflow.file.replace(/\.ts$/, ".test.ts");
    const exists = await lstat(file).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (exists?.isFile()) files.push(file);
  }
  if (files.length === 0) {
    process.stderr.write(
      "workflow-test-missing: " + (id ?? "no project or user tests") + "\n",
    );
    return 1;
  }
  return await runTests(files, repository);
}

function runTests(
  files: readonly string[],
  repository: string,
): Promise<number> {
  return new Promise((settle, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        workflowTestLoader(),
        "--test",
        ...files,
      ],
      {
        cwd: repository,
        stdio: "inherit",
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
    const interrupt = (): void => {
      child.kill("SIGINT");
    };
    const terminate = (): void => {
      child.kill("SIGTERM");
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = (): void => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      settle(code ?? 1);
    });
  });
}

if (process.argv[1] === import.meta.filename)
  process.exitCode = await workflowCommand(process.argv.slice(2));
