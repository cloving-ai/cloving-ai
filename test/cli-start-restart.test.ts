import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { spawnStall } from "./spawn-stall-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const adoptionScript = `if (process.env.CLOVING_TEST_ADOPT && launches.length === 1) {
  const value = (name) => process.argv[process.argv.indexOf(name) + 1];
  const legacy = value("--legacy-runtime");
  mkdirSync(dirname(value("--adoption-record")), { recursive: true });
  writeFileSync(value("--adoption-record"), JSON.stringify({ schemaVersion: 1, repository: value("--repository"), runtimeDirectory: legacy }));
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(join(dirname(legacy), "restart-settings"), "files");
}`;

async function startTree(
  root: string,
  launch: {
    readonly statuses: readonly number[];
    readonly stallMilliseconds: number;
  },
): Promise<string> {
  await mkdir(join(root, "tools"));
  await writeFile(
    join(root, "hook.mjs"),
    `
import { registerHooks } from "node:module";
import { ChildProcess } from "node:child_process";
const emit = ChildProcess.prototype.emit;
ChildProcess.prototype.emit = function(event, ...argumentsList) {
  if (event === "close" && process.argv[2] === "start" && process.env.CLOVING_TEST_SIGNAL_ON_CLOSE) {
    process.kill(process.pid, process.env.CLOVING_TEST_SIGNAL_ON_CLOSE);
    delete process.env.CLOVING_TEST_SIGNAL_ON_CLOSE;
  }
  return emit.call(this, event, ...argumentsList);
};
const program = ${JSON.stringify(pathToFileURL(resolve("tools/self-host.ts")).href)};
const fake = ${JSON.stringify(pathToFileURL(join(root, "tools/self-host.ts")).href)};
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  return resolved.url === program ? nextResolve(fake, context) : resolved;
} });
`,
  );
  await writeFile(
    join(root, "tools/self-host.ts"),
    `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
let launches = [];
try { launches = JSON.parse(readFileSync("launches.json", "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
launches.push({ arguments: process.argv.slice(2), marker: process.env.CLOVING_TEST_MARKER, mergeMode: process.env.CLOVING_MERGE_MODE, watchPort: process.env.CLOVING_WATCH_PORT, lanes: process.env.CLOVING_QUEUE_LANES });
if (process.env.CLOVING_TEST_FILES && launches.length === 1) writeFileSync("restart-settings", "files");
if (process.env.CLOVING_TEST_SET && launches.length === 1) writeFileSync("restart-variables", JSON.stringify({ CLOVING_QUEUE_LANES: "8" }));
${adoptionScript}
writeFileSync("launches.json", JSON.stringify(launches));
const status = ${JSON.stringify(launch.statuses)}[launches.length - 1] ?? 2;
if (process.env.CLOVING_TEST_SIGNAL && launches.length === 1) {
  process.on(process.env.CLOVING_TEST_SIGNAL, () => {});
  process.kill(process.ppid, process.env.CLOVING_TEST_SIGNAL);
  setTimeout(() => process.exit(status), 30);
} else process.exit(status);
`,
  );
  const stalled = await spawnStall(root, {
    command: "start",
    milliseconds: launch.stallMilliseconds,
  });
  return `--import=${pathToFileURL(join(root, "hook.mjs")).href} ${stalled}`;
}

interface StartOptions {
  readonly signal?: string;
  readonly signalOnClose?: string;
  readonly arguments?: readonly string[];
  readonly stallMilliseconds?: number;
  readonly mergeMode?: string;
  readonly files?: "first" | "stale";
  readonly set?: true;
  readonly adopt?: true;
  readonly workspace?: true;
}

interface StartObservation {
  readonly status: number | null;
  readonly launches: readonly unknown[];
  readonly expected: {
    readonly arguments: readonly string[];
    readonly marker: string;
  };
}

function startEnvironment(input: {
  readonly root: string;
  readonly nodeOptions: string;
  readonly options: StartOptions;
}): NodeJS.ProcessEnv {
  const { root, nodeOptions, options } = input;
  return {
    ...process.env,
    CLOVING_RUNTIME_DIR: join(root, "run"),
    CLOVING_TEST_MARKER: "preserved",
    CLOVING_TEST_SIGNAL: options.signal,
    CLOVING_TEST_SIGNAL_ON_CLOSE: options.signalOnClose,
    CLOVING_MERGE_MODE: options.mergeMode,
    CLOVING_WATCH_PORT: undefined,
    CLOVING_TEST_FILES: options.files === "first" ? "1" : undefined,
    CLOVING_TEST_SET: options.set === true ? "1" : undefined,
    CLOVING_QUEUE_LANES: options.set === true ? "4" : undefined,
    NODE_OPTIONS: nodeOptions,
    ...(options.adopt === true
      ? {
          CLOVING_RUNTIME_DIR: undefined,
          CLOVING_TEST_ADOPT: "1",
          XDG_RUNTIME_DIR: "",
          XDG_STATE_HOME: join(root, "state"),
        }
      : {}),
    ...(options.workspace === true
      ? {
          CLOVING_WATCH_PORT: "off",
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_RUNTIME_DIR: "",
          XDG_STATE_HOME: join(root, "state"),
        }
      : {}),
  };
}

async function workspaceArguments(root: string): Promise<readonly string[]> {
  spawnSync("git", ["init", "-q", join(root, "chosen")]);
  await mkdir(join(root, "config/cloving"), { recursive: true });
  await writeFile(
    join(root, "config/cloving/workspace.json"),
    JSON.stringify({
      version: 1,
      repositories: [{ path: join(root, "chosen"), name: "chosen" }],
    }),
  );
  return ["start", "--workspace"];
}

async function started(
  statuses: readonly number[],
  options: StartOptions = {},
): Promise<StartObservation> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-start-")));
  try {
    const nodeOptions = await startTree(root, {
      statuses,
      stallMilliseconds: options.stallMilliseconds ?? 0,
    });
    if (options.files === "stale")
      await writeFile(join(root, "restart-settings"), "files");
    if (options.files === "stale")
      await writeFile(
        join(root, "restart-variables"),
        JSON.stringify({ CLOVING_QUEUE_LANES: "8" }),
      );
    if (options.adopt === true)
      spawnSync("git", ["init", "-q", join(root, "chosen")]);
    const command =
      options.workspace === true
        ? await workspaceArguments(root)
        : ["start", "--repository", "chosen", ...(options.arguments ?? [])];
    const result = spawnSync(
      process.execPath,
      [resolve("src/cli.ts"), ...command],
      {
        cwd: root,
        env: startEnvironment({ root, nodeOptions, options }),
        encoding: "utf8",
        timeout: testMilliseconds(10000),
      },
    );
    assert.equal(result.error, undefined, result.stderr);
    const launches: unknown = JSON.parse(
      await readFile(join(root, "launches.json"), "utf8"),
    );
    assert.ok(Array.isArray(launches));
    return {
      status: result.status,
      launches: launches.map((value: unknown) => value),
      expected: {
        arguments: [
          "--runtime",
          join(root, "run"),
          "--repository",
          root,
          "--client",
          `CLOVING_RUNTIME_DIR=${join(root, "run")} cloving`,
          "--client-program",
          "cloving",
          "--repository",
          "chosen",
          ...(options.arguments ?? []),
        ],
        marker: "preserved",
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test("CLV-085 start restarts exit 75 with the same arguments and environment", async () => {
  const result = await started([75, 0]);
  assert.equal(result.status, 0);
  assert.equal(result.launches.length, 2);
  assert.deepEqual(result.launches[0], result.launches[1]);
  assert.deepEqual(result.launches[0], result.expected);
});

await test("CLV-131 start forwards an explicit queue reset only to the first launch", async () => {
  const result = await started([75, 0], { arguments: ["--reset-queue"] });
  assert.equal(result.status, 0);
  assert.equal(result.launches.length, 2);
  assert.deepEqual(result.launches[0], result.expected);
  assert.deepEqual(result.launches[1], {
    ...result.expected,
    arguments: result.expected.arguments.filter(
      (argument) => argument !== "--reset-queue",
    ),
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  await test(`CLV-085 ${signal} during an update prevents restart on exit 75`, async () => {
    const result = await started([75, 0], {
      signal,
      stallMilliseconds: testMilliseconds(1500),
    });
    assert.equal(result.status, 0);
    assert.equal(result.launches.length, 1);
  });
  await test(`CLV-085 ${signal} pending at child close prevents restart on exit 75`, async () => {
    const result = await started([75, 0], { signalOnClose: signal });
    assert.equal(result.status, 0);
    assert.equal(result.launches.length, 1);
  });
}

await test("CLV-085 start does not restart exit 1", async () => {
  const result = await started([1]);
  assert.equal(result.status, 1);
  assert.equal(result.launches.length, 1);
});

await test("CLV-306 a restart from the files starts without the variables that the files can set, also at later restarts", async () => {
  const result = await started([75, 75, 0], {
    mergeMode: "queue",
    files: "first",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.launches, [
    { ...result.expected, mergeMode: "queue" },
    result.expected,
    result.expected,
  ]);
});

await test("CLV-352 a restart with a set value starts with that value and keeps it at later restarts", async () => {
  const result = await started([75, 75, 0], { mergeMode: "queue", set: true });
  assert.equal(result.status, 0);
  assert.deepEqual(result.launches, [
    { ...result.expected, mergeMode: "queue", lanes: "4" },
    { ...result.expected, mergeMode: "queue", lanes: "8" },
    { ...result.expected, mergeMode: "queue", lanes: "8" },
  ]);
});

await test("CLV-352 a restart from the files with a set value starts with the set value and without the other file variables", async () => {
  const result = await started([75, 75, 0], {
    mergeMode: "queue",
    files: "first",
    set: true,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.launches, [
    { ...result.expected, mergeMode: "queue", lanes: "4" },
    { ...result.expected, lanes: "8" },
    { ...result.expected, lanes: "8" },
  ]);
});

await test("CLV-306 CLV-352 start removes the settings notes that no restart of this start wrote", async () => {
  const result = await started([75, 0], { mergeMode: "queue", files: "stale" });
  assert.equal(result.status, 0);
  assert.deepEqual(result.launches, [
    { ...result.expected, mergeMode: "queue" },
    { ...result.expected, mergeMode: "queue" },
  ]);
});

await test("CLV-306 a restart from the files reads the settings note of an adopted legacy runtime", async () => {
  const result = await started([75, 0], { mergeMode: "queue", adopt: true });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.launches.map((launch) =>
      typeof launch === "object" && launch !== null && "mergeMode" in launch
        ? launch.mergeMode
        : undefined,
    ),
    ["queue", undefined],
  );
});

await test("CLV-312 a workspace repository that restarts from the files keeps its watch port off", async () => {
  const result = await started([75, 0], { files: "first", workspace: true });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.launches.map((launch) =>
      typeof launch === "object" && launch !== null && "watchPort" in launch
        ? launch.watchPort
        : undefined,
    ),
    ["off", "off"],
  );
});
