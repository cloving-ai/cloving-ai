import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startTurn } from "../src/daemon/claude-turn.ts";
import { shellTurnScript } from "../src/agent-harness-shell.ts";
import { command, signal, turn } from "./claude-profiles-fixture.ts";
import {
  intent,
  alive,
  journalKey,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";

function codex(scene: Scene): readonly string[] {
  const script = join(scene.directory, "codex.mjs");
  writeFileSync(
    script,
    `
for await (const chunk of process.stdin) String(chunk);
const print = (value) => console.log(JSON.stringify(value));
print({type:"thread.started",thread_id:"codex-session"});
print({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({arguments:process.argv.slice(2),env:process.env.REVIEW_ONLY})}});
print({type:"turn.completed"});
`,
  );
  return [process.execPath, script];
}

await test("CLV-210 unavailable or malformed harness journal metadata stays unknown", () =>
  withScene(async (scene) => {
    const worker = scene.worker("bare");
    assert.equal(await worker.harness("missing"), undefined);
    const folder = join(scene.journal, journalKey("metadata"));
    mkdirSync(folder, { recursive: true });
    for (const contents of ["not JSON", "{}", '{"harness":1}']) {
      writeFileSync(join(folder, "started.json"), contents);
      assert.equal(await worker.harness("metadata"), undefined);
    }
  }));

await test("CLV-210 a private Codex default runs the Codex stream worker", () =>
  withScene(async (scene) => {
    const worker = scene.worker("bare", {
      harness: { name: "codex", command: codex(scene) },
    });
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(
      resultOf(scene.reports[0].result)["sessionId"],
      "codex-session",
    );
    assert.equal(resultOf(scene.reports[0].result)["harness"], "codex");
    assert.equal(
      resultOf(
        readFileSync(
          join(scene.journal, journalKey("operation-1"), "started.json"),
          "utf8",
        ),
      )["harness"],
      "codex",
    );
  }));

await test("CLV-210 stopping a shell turn stops its native process and escalates ignored signals", () =>
  withScene(async (scene) => {
    for (const mode of ["normal", "ignore-term"]) {
      const ready = join(scene.directory, `shell-${mode}.pid`);
      const script = `require("node:fs").writeFileSync(process.argv[1], String(process.pid));process.stdin.resume();setInterval(() => {}, 1000);`;
      const handler =
        mode === "ignore-term" ? 'process.on("SIGTERM", () => {});' : "";
      const running = startTurn({
        shell: "/bin/bash",
        command: [process.execPath, "-e", handler + script, ready],
        directory: scene.directory,
        folder: scene.directory,
        prompt: "hold",
        environment: { HOME: scene.directory },
      });
      try {
        await until(
          () => existsSync(ready) && Number(readFileSync(ready, "utf8")) > 0,
        );
        running.stop(25);
        const ended = await Promise.race([
          running.ended.then(() => true),
          delay(2000, false, { ref: false }),
        ]);
        assert.equal(ended, true, "shell turn did not stop its native process");
        await until(() => !alive(Number(readFileSync(ready, "utf8"))));
        assert.equal(alive(Number(readFileSync(ready, "utf8"))), false);
      } finally {
        const pid = existsSync(ready) ? Number(readFileSync(ready, "utf8")) : 0;
        if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
        running.stop(0);
        await running.ended;
      }
    }
  }));

await test("CLV-210 a profile harness beats the worker override and never inherits private command or kind", () =>
  withScene(async (scene) => {
    const observed = await turn(scene, {
      settings: {
        worker: "codex",
        harness: {
          name: "codex",
          kind: "shell",
          path: "unused",
          command: ["must-not-run"],
        },
        workerCommands: { claude: command(scene) },
        profiles: {
          checker: { harness: "claude", env: { REVIEW_ONLY: "yes" } },
        },
      },
    });
    const environment = observed["env"];
    assert.ok(typeof environment === "object" && environment !== null);
    assert.equal(Reflect.get(environment, "REVIEW_ONLY"), "yes");
  }));

await test("CLV-210 Codex accepts shared profile fields and replaces its model", () =>
  withScene(async (scene) => {
    const observed = await turn(scene, {
      settings: {
        worker: "codex",
        command: [...codex(scene), "-m", "old"],
        profiles: {
          checker: {
            env: { REVIEW_ONLY: "yes" },
            model: "new",
            workflows: ["review-loop"],
          },
        },
        workflowId: () => Promise.resolve("review-loop"),
      },
    });
    assert.equal(observed["env"], "yes");
    assert.deepEqual(observed["arguments"], ["--model", "new"]);
  }));

await test("CLV-210 each Claude-only profile field refuses a Codex turn", () =>
  withScene(async (scene) => {
    for (const profile of [
      { allowedTools: [] },
      { permissionMode: "plan" },
      { maxBudgetUsd: 1 },
    ]) {
      const worker = scene.worker("bare", {
        profiles: { checker: { ...profile, harness: "codex" } },
      });
      assert.deepEqual(
        await worker.deliver(intent({ method: "run-turn:checker" }), signal),
        {
          kind: "failed",
          reason: "profile-needs-claude",
        },
      );
    }
    assert.equal(scene.reports.length, 0);
    assert.deepEqual(scene.turns(), []);
  }));

await test("CLV-210 a shell harness passes every command part as a shell argument", () =>
  withScene(async (scene) => {
    const shell = join(scene.directory, "shell");
    writeFileSync(
      shell,
      `#!${process.execPath}
for await (const chunk of process.stdin) String(chunk);
console.log(JSON.stringify({type:"result",is_error:false,result:JSON.stringify({arguments:process.argv.slice(2)})}));
`,
      { mode: 0o700 },
    );
    const parts = [
      "program with spaces",
      "two words",
      "'quote'",
      "$(touch should-not-exist)",
      "",
    ];
    const observed = await turn(scene, {
      method: "run-turn",
      settings: {
        command: parts,
        shell,
        harness: { name: "claude", kind: "shell" },
      },
    });
    const argumentsList = observed["arguments"];
    assert.ok(Array.isArray(argumentsList));
    const configuration: unknown = argumentsList[5];
    assert.ok(typeof configuration === "string");
    assert.ok(configuration.includes("/gh-config-"));
    assert.equal(existsSync(configuration), false);
    assert.deepEqual(argumentsList, [
      "-l",
      "-i",
      "-c",
      shellTurnScript,
      "cloving-harness",
      configuration,
      ...parts,
    ]);
  }));

await test("CLV-210 shell harnesses run login-shell functions and aliases with literal arguments", () =>
  withScene(async (scene) => {
    const [program = "", script = ""] = command(scene);
    writeFileSync(
      join(scene.directory, ".zshrc"),
      `
turn_function() { ${JSON.stringify(program)} ${JSON.stringify(script)} "$@"; }
alias turn_alias='${program} ${JSON.stringify(script)}'
`,
    );
    const argumentsList = [
      "two words",
      "'quoted'",
      "$(touch should-not-exist)",
      "",
    ];
    for (const name of ["turn_function", "turn_alias"]) {
      const observed = await turn(scene, {
        settings: {
          command: [name, ...argumentsList],
          shell: "/bin/zsh",
          harness: { name: "claude", kind: "shell" },
          profiles: { checker: { env: { ZDOTDIR: scene.directory } } },
        },
      });
      assert.deepEqual(observed["arguments"], argumentsList);
    }
  }));
