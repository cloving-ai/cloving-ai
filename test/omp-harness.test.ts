import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  harnessDefinition,
  harnessVersion,
} from "../src/agent-harness-versions.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { startTurn, succeeded } from "../src/daemon/claude-turn.ts";
import { piSessionCommandFailure } from "../src/daemon/pi-session.ts";
import { piStream } from "../src/daemon/pi-stream.ts";
import { defaultOmpCommand, turnHarness } from "../src/harness-defaults.ts";
import { resolveSettings } from "../src/project-settings.ts";
import {
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { check, withDoctor } from "./doctor-fixture.ts";
import { initCli } from "./init-fixture.ts";
import { fakePi, piMessage, piReport } from "./pi-fixture.ts";

function ompEvents(message = piMessage()): readonly unknown[] {
  return [
    { type: "session", version: 3, id: "omp-session" },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message },
    { type: "message_end", message },
    { type: "turn_end", message, toolResults: [] },
    { type: "agent_end", messages: [message], isTerminal: true },
  ];
}

function parsed(
  events: readonly unknown[],
  options: {
    readonly protocol?: "pi" | "omp";
    readonly exitCode?: number;
  } = {},
) {
  const stream = piStream(undefined, options.protocol ?? "omp");
  for (const event of events) stream.line(JSON.stringify(event));
  return resultOf(stream.result(options.exitCode ?? 0));
}

await test("omp settles only on a terminal agent_end", () => {
  const completed = parsed(ompEvents());
  assert.equal(completed["is_error"], false);
  assert.equal(completed["result"], piReport);
  const continuation = [
    ...ompEvents().slice(0, -1),
    { type: "agent_end", messages: [], isTerminal: false },
  ];
  assert.match(String(parsed(continuation)["result"]), /terminal agent_end/);
  assert.equal(
    parsed([
      ...continuation,
      ...ompEvents(piMessage({ responseId: "response-2" })).slice(1),
    ])["is_error"],
    false,
  );
  assert.equal(
    parsed([...ompEvents(), { type: "turn_start" }])["is_error"],
    true,
  );
});

await test("omp refuses a malformed agent_end and keeps Pi on agent_settled", () => {
  const unmarked = [
    ...ompEvents().slice(0, -1),
    { type: "agent_end", messages: [] },
  ];
  assert.equal(parsed(unmarked)["result"], "omp malformed agent_end record");
  assert.equal(
    parsed(ompEvents(), { protocol: "pi" })["result"],
    "Pi ended without agent_settled",
  );
  const settledOnly = [
    ...ompEvents().slice(0, -1),
    { type: "agent_settled", aborted: false },
  ];
  assert.match(String(parsed(settledOnly)["result"]), /terminal agent_end/);
  assert.equal(parsed(settledOnly, { protocol: "pi" })["is_error"], false);
  assert.equal(
    parsed(ompEvents(), { exitCode: 3 })["result"],
    "omp exited with code 3",
  );
});

await test("native omp runs its JSON command with an owned session and stdin prompt", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: {
        name: "omp",
        path: fakePi(scene, { events: ompEvents() }),
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const report = resultOf(scene.reports[0].result);
    assert.equal(report["harness"], "omp");
    assert.equal(report["summary"], piReport);
    assert.notEqual(report["piAccounting"], undefined);
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.deepEqual(observed["arguments"], [
      ...defaultOmpCommand.slice(1),
      "--session",
      String(
        field(
          field(record(scene, "operation-1/started.json"), "piSession"),
          "path",
        ),
      ),
    ]);
    assert.equal(observed["stdin"], "prompt of sha256:prompt");
    assert.equal(observed["directory"], report["worktree"]);
  }));

await test("omp receives boundary whitespace in the prompt unchanged", () =>
  withScene(async (scene) => {
    const prompt = "  @literal prompt\n";
    const running = startTurn({
      worker: "omp",
      command: [fakePi(scene, { events: ompEvents() })],
      directory: scene.repository,
      folder: scene.directory,
      prompt,
    });
    const end = await running.ended;
    assert.equal(succeeded(end), true);
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.deepEqual(observed["arguments"], []);
    assert.equal(observed["stdin"], prompt);
  }));

await test("omp settings select the native command, its override and a custom text turn", () => {
  assert.deepEqual(turnHarness({ worker: "omp" }).command, defaultOmpCommand);
  assert.equal(turnHarness({ worker: "omp" }).output, undefined);
  const resolved = resolveSettings(
    {},
    {
      project: undefined,
      private: JSON.stringify({
        version: 1,
        harness: { name: "omp", command: ["saved-omp", "--mode", "json"] },
      }),
    },
  );
  assert.equal(
    resolved.environment["CLOVING_OMP_COMMAND"],
    '["saved-omp","--mode","json"]',
  );
  const text = turnHarness({
    harness: { name: "omp", turn: ["omp", "-p", "{prompt}"] },
  });
  assert.equal(text.output, "text");
  assert.deepEqual(text.command, ["omp", "-p", "{prompt}"]);
  assert.equal(
    piSessionCommandFailure(["omp", "--restore", "id"]),
    "pi-session-command-unsupported",
  );
});

await test("omp discovery accepts omp 18 releases only", () => {
  const pattern = harnessDefinition("omp").versionPattern;
  assert.equal(harnessVersion("omp/18.13.3\n", pattern), "omp/18.13.3");
  assert.equal(harnessVersion("omp/19.0.0", pattern), null);
  assert.equal(harnessVersion("18.13.3", pattern), null);
});

await test("init and doctor select a working omp", () =>
  withDoctor(async (scene) => {
    const program = await scene.program("omp", 'console.log("omp/18.13.3")');
    const initialized = initCli(scene, { arguments: ["--harness", program] });
    assert.equal(initialized.status, 0, initialized.stderr);
    const file = privateSettingsPath(scene.environment, scene.repository);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      version: 1,
      harness: { name: "omp", kind: "file", path: program },
    });
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "ok",
    );
    await scene.program("omp", 'console.log("omp/19.0.0")');
    assert.equal(
      check(await scene.report(), "default-harness")["result"],
      "fail",
    );
  }));
