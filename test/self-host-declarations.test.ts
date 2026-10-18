import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ended, field, reached } from "./self-host-fixture.ts";
import { call, parsed, runCli } from "./service-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const declaration = {
  workflowId: "review-run",
  effectLimit: 14,
  capabilities: ["claude"],
  input: {
    maximumBytes: 65_536,
    fields: {
      prompt: { type: "string" },
      rounds: { type: "integer", minimum: 1, maximum: 10, optional: true },
      publish: { type: "boolean", optional: true },
    },
  },
};

async function start(root: string): Promise<ChildProcess> {
  for (const folder of ["tools", "workflows"])
    await mkdir(join(root, folder), { recursive: true });
  for (const file of [
    "self-host.ts",
    "self-host-workflows.ts",
    "self-host-processes.ts",
    "self-update-host.ts",
    "self-update.ts",
    "compile-workflows.ts",
    "workflow-manifest.ts",
  ])
    await copyFile(resolve("tools", file), join(root, "tools", file));
  for (const file of [
    "develop-ticket.ts",
    "develop-prd.ts",
    "issue-labels.ts",
    "ticket-prompts.ts",
  ])
    await copyFile(resolve("workflows", file), join(root, "workflows", file));
  for (const folder of ["src", "node_modules"])
    await symlink(resolve(folder), join(root, folder));
  await copyFile(resolve("package.json"), join(root, "package.json"));
  const child = spawn(
    process.execPath,
    [
      join(root, "tools/self-host.ts"),
      "--runtime",
      join(root, "host/run"),
      "--repository",
      root,
    ],
    {
      env: {
        ...process.env,
        CLOVING_WATCH_PORT: "off",
        CLOVING_WORKER: "claude",
        CLOVING_CLAUDE_COMMAND: '["true"]',
        CLOVING_QUEUE_SECONDS: undefined,
        CLOVING_PROFILES: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  return child;
}

async function checkRun(root: string): Promise<void> {
  const runtimeDirectory = join(root, "host/run");
  const environment = { directory: root, runtime: runtimeDirectory };
  const cli = (args: readonly string[]) => runCli(args, environment);
  const status = await cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /review-run/);
  await writeFile(
    join(root, "input.json"),
    JSON.stringify({ prompt: "Check the change.", rounds: 0 }),
  );
  const invalid = await cli([
    "run",
    "review-run",
    "--input",
    "input.json",
    "--json",
  ]);
  assert.notEqual(invalid.status, 0);
  assert.equal(parsed(invalid)["code"], "invalid-submission");
  assert.equal(parsed(invalid)["detail"], "Field rounds is not valid.");
  assert.deepEqual(
    (await call({ runtimeDirectory }, { operation: "status", parameters: {} }))[
      "runs"
    ],
    [],
  );
  const input = { prompt: "Check the change.", rounds: 3, publish: false };
  await writeFile(join(root, "input.json"), JSON.stringify(input));
  const valid = await cli([
    "run",
    "review-run",
    "--input",
    "input.json",
    "--command-id",
    "command-1",
    "--json",
  ]);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const run = await reached(async () => {
    const shown = await call(
      { runtimeDirectory },
      { operation: "status", parameters: { runId: parsed(valid)["runId"] } },
    );
    return field(shown["run"], "state") === "completed"
      ? shown["run"]
      : undefined;
  });
  assert.deepEqual(field(run, "budget"), { limit: 14, spent: 0 });
  assert.deepEqual(field(run, "outcome"), {
    kind: "handoff_requested",
    reason: null,
  });
}

await test("CLV-089 start registers a sidecar workflow and run delivers checked typed input to its compiled function", async () => {
  await withFiles(
    {
      "workflows/review-run.ts":
        'export async function __proto__(input: unknown) {\n  "use workflow";\n  return { kind: "blocked", reason: JSON.stringify(input) };\n}',
      "workflows/review-run.declaration.json": JSON.stringify(declaration),
    },
    async (root) => {
      const expected = {
        cycleId: "task-e12c157c0051",
        repository: root,
        input: { prompt: "Check the change.", rounds: 3, publish: false },
      };
      await writeFile(
        join(root, "workflows/review-run.ts"),
        `export async function __proto__(input: unknown) {
  "use workflow";
  return { kind: JSON.stringify(input) === ${JSON.stringify(JSON.stringify(expected))} ? "handoff_requested" : "blocked" };
}`,
      );
      const child = await start(root);
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (bytes: Buffer) => {
          output += bytes.toString();
        });
      try {
        await reached(() => {
          if (child.exitCode !== null) throw new Error(output);
          return Promise.resolve(
            output.includes("Cloving runs") ? true : undefined,
          );
        });
        await checkRun(root);
        assert.equal(await ended(child), 0);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          process.kill(-Number(child.pid), "SIGKILL");
      }
    },
  );
});
