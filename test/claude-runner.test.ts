import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  field,
  git,
  intent,
  journalKey,
  record,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import { fakeEngine, fakeSandbox } from "./claude-runner-fixture.ts";
import { turnActivity, turnOf } from "../src/cli/watch-model.ts";
import type { TurnRunner } from "../src/turn-runner.ts";
import {
  gitCommonFolder,
  runnerLaunch,
} from "../src/daemon/turn-runner-spawn.ts";

const signal = new AbortController().signal;

async function deliveredTurn(
  scene: Scene,
  options: { readonly mode: string; readonly runner: TurnRunner },
) {
  const worker = scene.worker(options.mode, {
    profiles: { boxed: { runner: options.runner } },
  });
  await worker.deliver(intent({ method: "run-turn:boxed" }), signal);
  await until(() => scene.reports.length === 1);
  return scene.reports[0];
}

function texts(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

await test("CLV-311 a container turn commits in the work tree, and the commit is on the run's branch", () =>
  withScene(async (scene) => {
    const engine = fakeEngine(scene.directory, { access: "write" });
    const report = await deliveredTurn(scene, {
      mode: "committed",
      runner: {
        kind: "container",
        engine: engine.path,
        image: "cloving-fixture",
      },
    });
    assert.equal(report?.outcome, "completed");
    const tree = scene.turns()[0]?.directory ?? "";
    const branch = String(
      field(record(scene, "operation-1/started.json"), "branch"),
    );
    assert.equal(
      git(scene.repository, ["log", "-1", "--format=%s", branch]),
      "Add the change 1",
    );
    const [started = [], removed] = engine.calls().map(texts);
    const common = join(scene.repository, ".git");
    const name = started[started.indexOf("--name") + 1] ?? "";
    assert.ok(started.includes(`${tree}:${tree}`), started.join(" "));
    assert.ok(started.includes(`${common}:${common}`), started.join(" "));
    assert.equal(started[started.indexOf("-w") + 1], tree);
    assert.ok(started.includes("cloving-fixture"));
    assert.match(name, /^cloving-run-1-[0-9a-f]{32}-[a-z0-9]+$/);
    assert.deepEqual(removed, ["rm", "-f", name]);
    const folder = join(scene.journal, journalKey("operation-1"));
    for (const file of [
      "started.json",
      "turn.jsonl",
      "turn.stderr.log",
      "result.json",
    ])
      assert.ok(existsSync(join(folder, file)), file);
    const shown = turnOf({
      key: journalKey("operation-1"),
      started: record(scene, "operation-1/started.json"),
      result: record(scene, "operation-1/result.json"),
      activity: turnActivity(
        readFileSync(join(folder, "turn.jsonl"), "utf8").split("\n"),
      ),
    });
    assert.deepEqual(shown.activity.at(-1), {
      kind: "result",
      text: "Done: prompt of sha256:prompt",
      costUsd: 0.25,
    });
  }));

await test("CLV-311 a container turn that cannot write to the git common folder ends with runner-git-readonly", () =>
  withScene(async (scene) => {
    const engine = fakeEngine(scene.directory, { access: "read-only" });
    const report = await deliveredTurn(scene, {
      mode: "committed",
      runner: {
        kind: "container",
        engine: engine.path,
        image: "cloving-fixture",
      },
    });
    assert.equal(report?.outcome, "failed");
    assert.equal(field(report, "reason"), "runner-git-readonly");
    assert.equal(scene.turns().length, 0);
  }));

await test("CLV-311 a seatbelt turn gets a settings file with its write folders and network hosts", () =>
  withScene(async (scene) => {
    const sandbox = fakeSandbox(scene.directory);
    const report = await deliveredTurn(scene, {
      mode: "committed",
      runner: {
        kind: "seatbelt",
        command: sandbox.path,
        network: ["api.anthropic.com"],
      },
    });
    assert.equal(report?.outcome, "completed");
    const tree = scene.turns()[0]?.directory ?? "";
    const [call] = sandbox.calls();
    const temporary = String(field(call, "temporary"));
    assert.equal(field(call, "made"), true);
    assert.equal(existsSync(temporary), false);
    assert.deepEqual(field(call, "settings"), {
      network: { allowedDomains: ["api.anthropic.com"], deniedDomains: [] },
      filesystem: {
        denyRead: [],
        allowWrite: [
          tree,
          join(scene.repository, ".git"),
          join(scene.directory, "attachments", "ticket-one"),
          temporary,
        ],
        denyWrite: [
          join(scene.repository, ".git", "hooks"),
          join(scene.repository, ".git", "config"),
        ],
      },
    });
  }));

await test("CLV-311 the git common folder comes from a linked work tree, a plain repository or a git folder with no common folder file", () =>
  withScene((scene) => {
    const common = join(scene.repository, ".git");
    assert.equal(gitCommonFolder(scene.repository), common);
    const linked = join(scene.directory, "linked");
    git(scene.repository, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked",
      linked,
    ]);
    assert.equal(gitCommonFolder(linked), common);
    const lone = join(scene.directory, "lone");
    mkdirSync(join(lone, "gitdir"), { recursive: true });
    writeFileSync(join(lone, ".git"), `gitdir: ${join(lone, "gitdir")}\n`);
    assert.equal(gitCommonFolder(lone), join(lone, "gitdir"));
    writeFileSync(join(lone, ".git"), "no link\n");
    assert.equal(gitCommonFolder(lone), join(lone, ".git"));
    return Promise.resolve();
  }));

await test("CLV-311 a container launch with no turn ID and no attachments has a turn name and no attachment mount", () =>
  withScene(async (scene) => {
    const engine = fakeEngine(scene.directory, { access: "write" });
    const folder = join(scene.directory, "launch");
    mkdirSync(folder);
    const launch = runnerLaunch(
      {
        runner: { kind: "container", engine: engine.path, image: "fixture" },
        directory: scene.repository,
        folder,
      },
      { command: ["true"], environment: { PATH: "/usr/bin:/bin" } },
    );
    const name = launch.command[launch.command.indexOf("--name") + 1] ?? "";
    assert.match(name, /^cloving-turn-[a-z0-9]+$/);
    assert.equal(launch.command.filter((part) => part === "-v").length, 5);
    await launch.release();
    assert.deepEqual(engine.calls(), [["rm", "-f", name]]);
    assert.deepEqual(readdirSync(folder), []);
  }));
