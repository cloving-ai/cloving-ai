import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, withScene, type Scene } from "./claude-worker-fixture.ts";
import { origin } from "./retry-git-fixture.ts";
import { record } from "../src/protocol.ts";
import { testMilliseconds } from "./test-timing.ts";

export const redGreenEntry = join(import.meta.dirname, "../src/cli.ts");
export const testFile = "test/sum.test.ts";

export interface RunOutput {
  readonly status: number;
  readonly output: string;
  readonly stderr?: string;
}

export interface RedGreenScene extends Scene {
  readonly base: string;
  readonly head: string;
  readonly log: string;
  readonly settings: Readonly<Record<string, unknown>>;
}

interface Invocation {
  readonly entry?: string;
  readonly input?: string;
  readonly settings?: unknown;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export function commitFiles(
  scene: Scene,
  files: Readonly<Record<string, string>>,
): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(scene.repository, name, ".."), { recursive: true });
    writeFileSync(join(scene.repository, name), content);
  }
  git(scene.repository, ["add", "."]);
  git(scene.repository, ["commit", "--quiet", "-m", "Add the fixture change"]);
  return git(scene.repository, ["rev-parse", "HEAD"]);
}

export function withRedGreen(
  outputs: { readonly red: RunOutput; readonly green: RunOutput },
  use: (scene: RedGreenScene) => Promise<void> | void,
): Promise<void> {
  return withScene(async (scene) => {
    const base = commitFiles(scene, { "src/sum.ts": "base" });
    origin(scene);
    git(scene.repository, ["push", "--quiet", "origin", "main"]);
    git(scene.repository, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(scene.repository, ["checkout", "--quiet", "-b", "feature"]);
    const head = commitFiles(scene, {
      "src/sum.ts": "head",
      [testFile]: JSON.stringify(outputs),
    });
    const log = join(scene.directory, "runs.jsonl");
    writeFileSync(log, "");
    const runner = join(scene.directory, "test.mjs");
    writeFileSync(
      runner,
      `import { appendFileSync, readFileSync } from "node:fs";
const files = process.argv.slice(2);
const phase = readFileSync("src/sum.ts", "utf8") === "base" ? "red" : "green";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase, files }) + "\\n");
const result = JSON.parse(readFileSync(files[0], "utf8"))[phase];
process.stdout.write(result.output);
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status;
`,
    );
    await use({
      ...scene,
      base,
      head,
      log,
      settings: { test: [process.execPath, runner], testFiles: ["test/"] },
    });
  });
}

export function redGreen(scene: RedGreenScene, overrides: Invocation = {}) {
  return spawnSync(
    process.execPath,
    [overrides.entry ?? redGreenEntry, "red-green"],
    {
      cwd: scene.repository,
      encoding: "utf8",
      timeout: testMilliseconds(10_000),
      input: overrides.input ?? JSON.stringify({ head: scene.head }),
      env: commandEnvironment(scene, overrides),
    },
  );
}

function commandEnvironment(scene: RedGreenScene, overrides: Invocation) {
  return {
    ...process.env,
    CLOVING_RED_GREEN: JSON.stringify(overrides.settings ?? scene.settings),
    ...overrides.environment,
  };
}

export function spawnRedGreen(scene: RedGreenScene, overrides: Invocation) {
  const child = spawn(process.execPath, [redGreenEntry, "red-green"], {
    cwd: scene.repository,
    stdio: ["pipe", "pipe", "pipe"],
    env: commandEnvironment(scene, overrides),
  });
  const result: {
    status: number | null;
    closed: boolean;
    stdout: string;
    stderr: string;
  } = { status: null, closed: false, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    result.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    result.stderr += chunk;
  });
  child.once("close", (status) => {
    result.status = status;
    result.closed = true;
  });
  child.stdin.end(overrides.input ?? JSON.stringify({ head: scene.head }));
  return { child, result };
}

export function verdict(scene: RedGreenScene, expected: string) {
  const result = redGreen(scene);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = record(JSON.parse(result.stdout));
  assert.ok(value);
  assert.equal(value["verdict"], expected);
  assert.equal(value["base"], scene.base);
  assert.equal(value["head"], scene.head);
  assert.deepEqual(value["files"], [testFile]);
  assert.equal(
    git(scene.repository, ["worktree", "list", "--porcelain"]).split(
      "worktree ",
    ).length,
    2,
  );
  return value;
}

export function runs(scene: RedGreenScene): unknown[] {
  return readFileSync(scene.log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
}

export function stopHeld(marker: string): void {
  if (!existsSync(marker)) return;
  const held = record(JSON.parse(readFileSync(marker, "utf8")));
  if (held === undefined || typeof held["pid"] !== "number")
    throw new Error("Invalid held process marker");
  const pid = held["pid"];
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (record(error)?.["code"] !== "ESRCH") throw error;
  }
}
