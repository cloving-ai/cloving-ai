import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { waitingGate, withHarness } from "./service-fixture.ts";
import { refusedWatch, watchedModel, watching } from "./watch-fixture.ts";

function field(value: unknown, name: string | number): unknown {
  return Reflect.get(Object(value), name);
}

function journal(runtimeDirectory: string, runId: string): void {
  const turn = join(dirname(runtimeDirectory), "journal", "a1b2");
  mkdirSync(turn, { recursive: true });
  const records = join(dirname(runtimeDirectory), "journal");
  for (const [key, started] of [
    ["empty", undefined],
    ["broken", "not json"],
    ["later", JSON.stringify({ startedAt: "2026-10-13T22:00:00.000Z" })],
  ] as const) {
    mkdirSync(join(records, key));
    writeFileSync(join(records, key, "other.txt"), started ?? "");
    writeFileSync(
      join(records, key, started === undefined ? "note.txt" : "started.json"),
      started ?? "",
    );
  }
  writeFileSync(
    join(turn, "started.json"),
    JSON.stringify({
      operationId: JSON.stringify(["cloving-operation", 1, runId, "implement"]),
      target: "clv-016-a6f7ef47",
      startedAt: "2026-10-13T21:26:01.000Z",
    }),
  );
  writeFileSync(
    join(turn, "turn.jsonl"),
    '{"type":"result","result":"Done.","total_cost_usd":0.5}\n',
  );
}

await test("CLV-016 the parser reads the watch command with an optional port, and it refuses an argument, a port that is no port and each other option", () => {
  const words = (line: string): readonly string[] => line.split(" ");
  assert.deepEqual(parseInvocation(words("watch")), {
    kind: "watch",
    port: null,
    json: false,
  });
  assert.deepEqual(parseInvocation(words("watch --port 3663")), {
    kind: "watch",
    port: 3663,
    json: false,
  });
  for (const [code, line] of [
    ["unexpected-argument", "watch run-1"],
    ["invalid-option-value", "watch --port 65536"],
    ["invalid-option-value", "watch --port x"],
    ["unexpected-option", "watch --json"],
  ] as const)
    assert.deepEqual(parseInvocation(words(line)), {
      kind: "usage-error",
      code,
      json: line.includes("--json"),
    });
});

await test("CLV-016 cloving watch serves the page and the run data of its service on the loopback address, with the decision commands and the Claude turn of a run, and gives 404 for each other request", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    journal(harness.runtimeDirectory, waiting.runId);
    const watch = await watching(harness.runtimeDirectory);
    try {
      const page = await fetch(watch.address);
      assert.match(String(page.headers.get("content-type")), /^text\/html/);
      assert.match(await page.text(), /function renderPage\(/);
      const first: unknown = await (
        await fetch(`${watch.address}data.json`)
      ).json();
      const second: unknown = await (
        await fetch(`${watch.address}data.json?again`)
      ).json();
      const run = field(field(first, "runs"), 0);
      assert.deepEqual(field(second, "runs"), field(first, "runs"));
      assert.deepEqual(
        [field(first, "service"), field(run, "runId"), field(run, "state")],
        ["up", waiting.runId, "waiting_gate"],
      );
      assert.match(
        String(field(field(field(run, "decisions"), 0), "approve")),
        new RegExp(
          `^CLOVING_RUNTIME_DIR=\\S+ cloving approve ${waiting.runId}/design-1 --expected-revision 1 `,
        ),
      );
      assert.deepEqual(
        [
          field(field(run, "turns"), "length"),
          field(field(field(run, "turns"), 0), "costUsd"),
        ],
        [1, 0.5],
      );
      assert.equal(field(field(run, "events"), "length"), 5);
      assert.equal((await fetch(`${watch.address}journal`)).status, 404);
      const posted = await fetch(`${watch.address}data.json`, {
        method: "POST",
      });
      assert.equal(posted.status, 404);
      const busy = await refusedWatch(
        harness.runtimeDirectory,
        new URL(watch.address).port,
      );
      assert.equal(busy.status, 1);
      assert.match(busy.output, /^watch-not-started: /);
    } finally {
      assert.equal(await watch.stop(), 0);
    }
    await service.close();
  }));

await test("CLV-016 cloving watch shows a service that does not answer with no run, and it reads a runtime directory with no journal", () =>
  withHarness(async (harness) => {
    const model = await watchedModel(harness.runtimeDirectory);
    assert.deepEqual(
      [field(model, "service"), field(model, "runs"), field(model, "host")],
      ["down", [], dirname(harness.runtimeDirectory)],
    );
  }));

await test("CLV-016 cloving start with no known runtime directory starts nothing and names the setting", () => {
  const hidden = [
    "HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "CLOVING_RUNTIME_DIR",
  ];
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !hidden.includes(name)),
  );
  const started = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "../src/cli.ts"), "start"],
    { env: environment, encoding: "utf8" },
  );
  assert.deepEqual([started.status, started.stdout], [1, ""]);
  assert.match(
    started.stderr,
    /^runtime-directory-unknown: Set CLOVING_RUNTIME_DIR /,
  );
});
