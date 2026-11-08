import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runtimeDirectory } from "../src/cli/runtime-directory.ts";
import { fields } from "./service-fixture.ts";
import { scene } from "./self-host-fixture.ts";
import { stopChildGroup } from "./stop-child.ts";
import { testMilliseconds } from "./test-timing.ts";

const execute = promisify(execFile);
const entry = resolve("src/cli.ts");
const guideEnd = "Commands for a second terminal:";

function hostEnvironment(state: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOVING_RUNTIME_DIR: undefined,
    CLOVING_SELF_UPDATE_SECONDS: undefined,
    CLOVING_QUEUE_SECONDS: undefined,
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

async function writtenWorkspace(
  state: string,
  repositories: readonly { readonly path: string; readonly name: string }[],
): Promise<void> {
  await mkdir(join(state, "config/cloving"), { recursive: true });
  await writeFile(
    join(state, "config/cloving/workspace.json"),
    JSON.stringify({ version: 1, repositories }),
  );
}

function closed(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode);
  return new Promise((settle) => {
    child.once("close", settle);
  });
}

async function workspaceStarted(input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly guides: number;
}) {
  const child = spawn(process.execPath, [entry, "start", "--workspace"], {
    cwd: input.cwd,
    env: input.environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  const ready = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    ready.reject(new Error(output.text || "start timed out"));
  }, testMilliseconds(60000));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      output.text += chunk.toString();
      if (output.text.split(guideEnd).length > input.guides)
        ready.resolve(undefined);
    });
  child.once("close", () => {
    ready.reject(new Error(output.text));
  });
  try {
    await ready.promise;
    return { child, output };
  } catch (error) {
    await stopChildGroup(child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

await test("CLV-312 one start serves a workspace of two repositories, each with its own daemon, runtime directory and control socket, and a stop of the supervisor stops both", async () => {
  const [alpha, beta] = [await scene(), await scene()];
  const state = join(alpha.root, "state");
  await writtenWorkspace(state, [
    { path: alpha.repository, name: "alpha" },
    { path: beta.repository, name: "beta" },
  ]);
  const environment = hostEnvironment(state);
  const runtimes = [alpha.repository, beta.repository].map((repository) => {
    const runtime = runtimeDirectory({ XDG_STATE_HOME: state }, repository);
    assert.ok(runtime);
    return runtime;
  });
  assert.notEqual(runtimes[0], runtimes[1]);
  const host = await workspaceStarted({
    cwd: alpha.root,
    environment,
    guides: 2,
  });
  try {
    assert.match(host.output.text, /^ {2}alpha: .*\/repository$/m);
    assert.match(host.output.text, /^ {2}beta: .*\/repository$/m);
    for (const [index, repository] of [
      alpha.repository,
      beta.repository,
    ].entries()) {
      const runtime = String(runtimes[index]);
      assert.ok(
        host.output.text.includes(`Runtime directory: ${runtime}\n`),
        host.output.text,
      );
      assert.ok(existsSync(join(runtime, "control.sock")));
      const client = await execute(
        process.execPath,
        [entry, "status", "--repository", repository, "--json"],
        { cwd: alpha.root, env: environment, timeout: 10000 },
      );
      assert.equal(fields(JSON.parse(client.stdout))["kind"], "run-list");
    }
    host.child.kill("SIGTERM");
    assert.equal(await closed(host.child), 0, host.output.text);
    for (const runtime of runtimes)
      assert.equal(existsSync(join(runtime, "control.sock")), false);
  } finally {
    await stopChildGroup(host.child);
  }
});
