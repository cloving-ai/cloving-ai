import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import { fakeEngine, fakeSandbox } from "./claude-runner-fixture.ts";
import {
  gatedHarness,
  harnessOutputs,
  harnessProcesses,
  openGate,
  processGroup,
  stopHarnessGroups,
} from "./harness-detached-fixture.ts";
import type { TurnRunner } from "../src/turn-runner.ts";
import { volumeName } from "../src/daemon/turn-runner-spawn.ts";
import { recordedLaunch } from "../src/turn-launch.ts";

const signal = new AbortController().signal;
const boxed = intent({ method: "run-turn:boxed" });

function keptLaunch(scene: Scene): unknown {
  return field(record(scene, "operation-1/started.json"), "launch");
}

function texts(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function restartedTurn(
  scene: Scene,
  options: {
    readonly runner: TurnRunner;
    readonly connected: () => void;
  },
) {
  const harness = gatedHarness(scene, {
    worker: "codex",
    name: "codex",
    output: harnessOutputs["codex"] ?? { head: [], tail: [] },
  });
  const settings = {
    ...harness.settings,
    profiles: { boxed: { runner: options.runner } },
  };
  try {
    const first = scene.worker("unused", settings);
    await first.deliver(boxed, signal);
    await until(
      () =>
        harnessProcesses(harness).length === 1 &&
        keptLaunch(scene) !== undefined,
    );
    const launch = keptLaunch(scene);
    const [turn] = harnessProcesses(harness);
    assert.ok(turn);
    assert.equal(processGroup(turn.processId), field(launch, "processId"));
    const folder = String(field(field(launch, "runner"), "folder"));
    assert.equal(existsSync(folder), true);
    await first.close({ turns: "keep" });
    assert.equal(alive(turn.processId), true);
    const noted: unknown[] = [];
    const next = scene.worker("unused", {
      ...settings,
      recovered: (recovery) => noted.push(recovery),
    });
    assert.equal((await next.reconcile(boxed, signal)).kind, "accepted");
    assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
    assert.deepEqual(
      field(record(scene, "operation-1/started.json"), "processId"),
      field(launch, "processId"),
    );
    options.connected();
    openGate(harness);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(
      resultOf(scene.reports[0].result)["summary"],
      "Ticket status: complete",
    );
    await until(() => !existsSync(folder));
    return { launch };
  } finally {
    stopHarnessGroups(harness);
  }
}

await test("CLV-349 a seatbelt turn keeps its process through a restart, with the runner program in its process group, and ends with its result", () =>
  withScene(async (scene) => {
    const sandbox = fakeSandbox(scene.directory);
    await restartedTurn(scene, {
      runner: { kind: "seatbelt", command: sandbox.path },
      connected: () => {
        assert.equal(sandbox.calls().length, 1);
      },
    });
    assert.equal(sandbox.calls().length, 1);
  }));

await test("CLV-349 a container turn keeps running through a restart, and the new worker removes its container at the end", () =>
  withScene(async (scene) => {
    const engine = fakeEngine(scene.directory, { access: "write" });
    const callsAtConnect: number[] = [];
    const { launch } = await restartedTurn(scene, {
      runner: { kind: "container", engine: engine.path, image: "fixture" },
      connected: () => {
        callsAtConnect.push(engine.calls().length);
      },
    });
    await until(() => engine.calls().length === 2);
    const [started = [], removed = []] = engine.calls().map(texts);
    const name = started[started.indexOf("--name") + 1] ?? "";
    assert.deepEqual(callsAtConnect, [1]);
    assert.deepEqual(removed, ["rm", "-f", name]);
    assert.equal(
      field(field(field(launch, "runner"), "container"), "name"),
      name,
    );
  }));

await test("CLV-349 a kept container turn that the new worker refuses stops, and the new worker removes its runner folder, its container and its gh configuration", () =>
  withScene(async (scene) => {
    const engine = fakeEngine(scene.directory, { access: "write" });
    const harness = gatedHarness(scene, {
      worker: "codex",
      name: "codex",
      output: harnessOutputs["codex"] ?? { head: [], tail: [] },
    });
    const runner: TurnRunner = {
      kind: "container",
      engine: engine.path,
      image: "fixture",
    };
    try {
      const first = scene.worker("unused", {
        ...harness.settings,
        profiles: { boxed: { runner } },
      });
      await first.deliver(boxed, signal);
      await until(
        () =>
          harnessProcesses(harness).length === 1 &&
          keptLaunch(scene) !== undefined,
      );
      const launch = keptLaunch(scene);
      const folder = String(field(field(launch, "runner"), "folder"));
      const configuration = String(field(launch, "configuration"));
      const [started = []] = engine.calls().map(texts);
      const name = started[started.indexOf("--name") + 1] ?? "";
      await first.close({ turns: "keep" });
      assert.deepEqual(
        [existsSync(folder), existsSync(configuration)],
        [true, true],
      );
      const next = scene.worker("unused", harness.settings);
      const outcome = await next.reconcile(boxed, signal);
      assert.equal(outcome.kind, "failed");
      assert.equal(alive(Number(field(launch, "processId"))), false);
      assert.deepEqual(
        [existsSync(folder), existsSync(configuration)],
        [false, false],
      );
      assert.deepEqual(engine.calls().map(texts).at(-1), ["rm", "-f", name]);
    } finally {
      stopHarnessGroups(harness);
    }
  }));

const dockerImage = "alpine:3.21";

function docker(program: string, parts: readonly string[]) {
  const done = spawnSync(program, parts, {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { ok: done.status === 0, output: done.stdout.trim() };
}

function dockerProgram(): string {
  return spawnSync("sh", ["-c", "command -v docker"], {
    encoding: "utf8",
  }).stdout.trim();
}

function dockerMissing(program: string): string | undefined {
  if (program === "") return "no docker program is on the PATH";
  if (!docker(program, ["info", "--format", "{{.ServerVersion}}"]).ok)
    return "docker info cannot reach a Docker engine";
  if (docker(program, ["image", "inspect", dockerImage]).ok) return undefined;
  if (docker(program, ["pull", dockerImage]).ok) return undefined;
  return `the image ${dockerImage} is not available`;
}

const dockerTurn = [
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"docker-1"}'`,
  "while [ ! -f docker.gate ]; do sleep 0.1; done",
  `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Ticket status: complete","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":5},"session_id":"docker-1","num_turns":1}'`,
].join("\n");

function containerState(program: string, name: string): string {
  return docker(program, ["inspect", "--format", "{{.State.Running}}", name])
    .output;
}

function startedField(scene: Scene, name: string): string {
  const value = field(record(scene, "operation-1/started.json"), name);
  return typeof value === "string" ? value : "";
}

function removedDocker(scene: Scene, program: string): void {
  const launch = keptLaunch(scene);
  const name = field(field(field(launch, "runner"), "container"), "name");
  if (typeof name === "string") docker(program, ["rm", "-f", name]);
  const tree = startedField(scene, "worktree");
  if (tree !== "") docker(program, ["volume", "rm", volumeName(tree)]);
}

async function dockerRestart(scene: Scene, program: string): Promise<void> {
  const settings = {
    command: ["sh", "-c", dockerTurn],
    profiles: {
      boxed: {
        runner: {
          kind: "container",
          engine: program,
          image: dockerImage,
        } as const,
      },
    },
  };
  try {
    const first = scene.worker("unused", settings);
    await first.deliver(boxed, signal);
    await until(() => keptLaunch(scene) !== undefined);
    const launch = keptLaunch(scene);
    const container = field(field(launch, "runner"), "container");
    const name = String(field(container, "name"));
    await until(() => containerState(program, name) === "true");
    await first.close({ turns: "keep" });
    assert.equal(containerState(program, name), "true");
    assert.equal(alive(Number(field(launch, "processId"))), true);
    const noted: unknown[] = [];
    const next = scene.worker("unused", {
      ...settings,
      recovered: (recovery) => noted.push(recovery),
    });
    assert.equal((await next.reconcile(boxed, signal)).kind, "accepted");
    assert.deepEqual(noted, [{ runId: "run-1", way: "connected" }]);
    writeFileSync(join(startedField(scene, "worktree"), "docker.gate"), "");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.deepEqual(
      [result["summary"], result["costUsd"]],
      ["Ticket status: complete", 0.5],
    );
    await until(() => containerState(program, name) === "");
  } finally {
    removedDocker(scene, program);
  }
}

await test("CLV-349 a container turn under Docker keeps running through a restart and ends with its result, or states why Docker is not available", async () => {
  const program = dockerProgram();
  const missing = dockerMissing(program);
  process.stderr.write(
    missing === undefined
      ? `CLV-349 Docker runs the image ${dockerImage}.\n`
      : `CLV-349 the Docker scene is skipped: ${missing}.\n`,
  );
  await (missing === undefined
    ? withScene((scene) => dockerRestart(scene, program))
    : Promise.resolve());
});

const recorded = {
  processId: 4242,
  processStart: "Tue Nov 10 22:00:00 2026",
  marker: "cloving-turn-marker",
  output: "/journal/turn.harness.jsonl",
  offset: 0,
  exit: "/journal/turn.exit.json",
  configuration: "/journal/gh-config",
};

await test("CLV-349 a launch record keeps a valid transcript place and runner place, and a damaged one is no launch", () => {
  const transcript = { path: "/journal/turn.jsonl", offset: 12 };
  const runner = {
    folder: "/journal/runner-1",
    container: { engine: "docker", name: "cloving-run-1" },
  };
  assert.deepEqual(recordedLaunch({ ...recorded, transcript, runner }), {
    ...recorded,
    transcript,
    runner,
  });
  assert.deepEqual(recordedLaunch(recorded), recorded);
  for (const damaged of [
    { transcript: { path: "/journal/turn.jsonl" } },
    { transcript: { path: "/journal/turn.jsonl", offset: -1 } },
    { transcript: { path: "/journal/turn.jsonl", offset: 1.5 } },
    { runner: { container: runner.container } },
    { runner: { folder: runner.folder, container: { engine: "docker" } } },
  ])
    assert.equal(recordedLaunch({ ...recorded, ...damaged }), undefined);
});
