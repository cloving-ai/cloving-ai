import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import { fields } from "./service-fixture.ts";
import { scene } from "./self-host-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";
import { testMilliseconds } from "./test-timing.ts";

const execute = promisify(execFile);
const entry = resolve("src/cli.ts");

function hostEnvironment(state: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOVING_RUNTIME_DIR: undefined,
    CLOVING_SELF_UPDATE_SECONDS: undefined,
    CLOVING_QUEUE_SECONDS: undefined,
    CLOVING_QUEUE_LANES: undefined,
    CLOVING_WORKER: "claude",
    CLOVING_NOTIFY_COMMAND: undefined,
    CLOVING_CLAUDE_COMMAND: JSON.stringify([
      process.execPath,
      "-e",
      "process.exit(1)",
    ]),
    CLOVING_WATCH_PORT: "off",
    XDG_RUNTIME_DIR: "",
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(state, "config"),
  };
}

async function started(input: {
  readonly cwd: string;
  readonly repository: string;
  readonly state: string;
  readonly argumentsList?: readonly string[];
}) {
  const environment = hostEnvironment(input.state);
  const child = spawn(
    process.execPath,
    [
      entry,
      "start",
      ...(input.argumentsList ?? ["--repository", input.repository]),
    ],
    {
      cwd: input.cwd,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const ready = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    ready.reject(new Error(output || "start timed out"));
  }, testMilliseconds(30000));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Commands for a second terminal:"))
        ready.resolve(undefined);
    });
  child.once("close", () => {
    ready.reject(new Error(output));
  });
  try {
    await ready.promise;
    return { child, output, environment };
  } catch (error) {
    await stopChildGroup(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

await test("CLV-204 start from repository A or outside git selects B and prints portable commands and the mixed legacy note", async () => {
  const work = await scene();
  const other = join(work.root, "other");
  await mkdir(other);
  execFileSync("git", ["init", "-q", other]);
  const state = join(work.root, "state");
  const runtime = runtimeDirectory({ XDG_STATE_HOME: state }, work.repository);
  assert.ok(runtime);
  for (const cwd of [other, work.root]) {
    const host = await started({
      cwd,
      repository: work.repository,
      state,
      ...(cwd === work.root
        ? { argumentsList: [`--repository=${work.repository}`] }
        : {}),
    });
    try {
      assert.ok(
        host.output.includes(`Runtime directory: ${runtime}`),
        host.output,
      );
      assert.ok(
        host.output.includes(`Repository: ${work.repository}\n`),
        host.output,
      );
      assert.ok(host.output.includes(join(state, "cloving/run")), host.output);
      const commands = host.output
        .split("\n")
        .filter((line) => line.startsWith("  cloving "));
      assert.equal(commands.length, 7);
      const prefix = `  cloving --repository ${work.repository}`;
      for (const command of commands) {
        assert.ok(command.startsWith(prefix), command);
        assert.equal(command.includes("CLOVING_RUNTIME_DIR="), false);
      }
      const client = await execute(
        process.execPath,
        [entry, "status", "--repository", work.repository, "--json"],
        {
          cwd: other,
          env: host.environment,
          timeout: 10000,
        },
      );
      assert.equal(fields(JSON.parse(client.stdout))["kind"], "run-list");
    } finally {
      await stopChildGroup(host.child);
    }
    const directory = join(state, "cloving/workflow-bundles");
    for (const repository of [work.repository, other])
      await retainWorkflowBundle({
        project: join(dirname(runtime), "project"),
        repository,
        directory,
      });
  }
});
