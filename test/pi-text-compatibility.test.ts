import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { turnHarness } from "../src/harness-defaults.ts";
import {
  field,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

await test("CLV-373 the v1.9 generic pi turn takes precedence over native defaults and overrides", () => {
  const harness = {
    name: "pi",
    turn: ["custom", "{prompt}"],
    command: ["winner", "{prompt}"],
    path: "unused",
  };
  for (const profile of [{}, { harness: "pi" }]) {
    const selected = turnHarness(
      { harness, workerCommands: { pi: ["foreign", "--mode", "json"] } },
      profile,
    );
    assert.equal(selected.output, "text");
    assert.deepEqual(selected.command, ["winner", "{prompt}"]);
  }
  assert.deepEqual(
    turnHarness({ harness: { name: "pi", turn: ["custom"], path: "file" } })
      .command,
    ["file"],
  );
  assert.throws(() => turnHarness({ harness: { name: "pi", turn: [] } }), {
    message: "invalid-setting: harness.turn",
  });
});

function legacyWorker(scene: Scene, selection: string) {
  const script = join(scene.directory, "custom.mjs");
  writeFileSync(
    script,
    `#!${process.execPath}
let input = "";
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({input, args: process.argv.slice(2), value: process.env.TURN_VALUE}));`,
    { mode: 0o700 },
  );
  const args = ["--session", "custom-session", "{prompt}"];
  const program = selection === "shell" ? "custom_pi" : script;
  writeFileSync(
    join(scene.directory, ".zshrc"),
    `custom_pi() { ${JSON.stringify(script)} "$@"; }`,
  );
  const harness = {
    name: "pi",
    turn: [selection === "file" ? "unused" : program, ...args],
    ...(selection === "file" ? { kind: "file" as const, path: script } : {}),
    ...(selection === "command"
      ? { command: [script, ...args], path: "unused" }
      : {}),
    ...(selection === "shell" ? { kind: "shell" as const } : {}),
  };
  return scene.worker("unused", {
    harness,
    ...(selection === "profile" ? { worker: "claude" } : {}),
    shell: "/bin/zsh",
    profiles: {
      legacy: {
        harness: "pi",
        env: { TURN_VALUE: "kept", ZDOTDIR: scene.directory },
      },
    },
    document: () => Promise.resolve("literal $(touch nope) {prompt}"),
  });
}

for (const selection of ["turn", "file", "command", "shell", "profile"]) {
  await test(`CLV-373 v1.9 custom pi ${selection} keeps literal text execution without native session arguments`, () =>
    withScene(async (scene) => {
      const worker = legacyWorker(scene, selection);
      await worker.deliver(
        intent({ method: "run-turn:legacy" }),
        new AbortController().signal,
      );
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      const result = resultOf(scene.reports[0].result);
      assert.equal(result["harness"], "pi");
      assert.deepEqual(resultOf(result["summary"]), {
        input: "",
        args: ["--session", "custom-session", "literal $(touch nope) {prompt}"],
        value: "kept",
      });
      assert.equal(result["costUsd"], null);
      assert.equal(result["estimatedCostUsd"], null);
      assert.equal(
        field(record(scene, "operation-1/started.json"), "piSession"),
        undefined,
      );
      assert.equal(
        existsSync(
          join(scene.journal, journalKey("operation-1"), "pi-session"),
        ),
        false,
      );
      assert.equal(existsSync(join(String(result["worktree"]), "nope")), false);
    }));
}

await test("CLV-373 a legacy pi profile still refuses model arguments before execution", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: { name: "pi", turn: ["must-not-run"] },
      profiles: { legacy: { harness: "pi", model: "unavailable" } },
    });
    assert.deepEqual(
      await worker.deliver(
        intent({ method: "run-turn:legacy" }),
        new AbortController().signal,
      ),
      { kind: "failed", reason: "profile-model-not-supported" },
    );
    assert.equal(scene.reports.length, 0);
  }));
