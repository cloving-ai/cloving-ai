import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered as cliRendered, statusJson } from "../src/cli/render.ts";
import { component } from "../src/cli/watch-element.ts";
import { Run } from "../src/cli/watch-view.ts";
import { shownCommands } from "../src/cli/command-effects.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";
import { noCopy } from "./watch-sample.ts";
import { call, field, startedRun, withHarness } from "./service-fixture.ts";

await test("CLV-178 status and watch show every command name, state, exit status and duration without stdout or stderr", () => {
  const commandEffects = [
    {
      operationId: "op-1",
      name: "review-requests",
      state: "completed",
      exitCode: 0,
      durationMilliseconds: 42,
    },
    {
      operationId: "op-2",
      name: "refresh",
      state: "failed",
      exitCode: 7,
      durationMilliseconds: 105,
    },
    {
      operationId: "op-3",
      name: "waiting",
      state: "running",
      exitCode: null,
      durationMilliseconds: null,
    },
  ];
  const status = {
    runId: "run-1",
    workflowId: "review-queue",
    state: "running",
    commandEffects,
  };
  const text = cliRendered({ kind: "run-status", run: status });
  assert.match(text, /Command review-requests · completed · exit 0 · 42 ms/);
  assert.match(text, /Command refresh · failed · exit 7 · 105 ms/);
  assert.match(
    text,
    /Command waiting · running · exit unknown · duration unknown/,
  );
  assert.deepEqual(
    Reflect.get(
      Object(statusJson({ kind: "run-status", run: status })["run"]),
      "commandEffects",
    ),
    commandEffects,
  );
  const run = boardModel([{ status }]).runs[0];
  assert.ok(run);
  const html = rendered(
    component(Run, { run, now: boardTime, copying: noCopy }),
  );
  assert.match(html, /Command review-requests · completed · exit 0 · 42 ms/);
  assert.match(html, /Command refresh · failed · exit 7 · 105 ms/);
  assert.match(
    html,
    /Command waiting · running · exit unknown · duration unknown/,
  );
});

await test("CLV-178 service status shows command identity when the optional journal reader is unavailable", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          effectLimit: 4,
          manifest: {
            ...harness.registration.manifest,
            capabilities: ["command"],
            commands: ["scan"],
          },
        },
      ],
    });
    const runId = await startedRun(harness, { service, commandId: "run" });
    const reply = await service.worker.requestEffect({
      runId,
      commandId: "scan",
      scope: { phase: "scan", operation: "reviews", round: 1 },
      capability: "command",
      method: "run:scan",
      target: "scan",
      payload: "{}",
      units: 1,
    });
    const result = await call(harness, {
      operation: "status",
      parameters: { runId },
    });
    const effects = field(field(result, "run"), "commandEffects");
    assert.ok(Array.isArray(effects));
    assert.equal(effects.length, 1);
    assert.equal(
      field(effects[0], "operationId"),
      reply.operation?.operationId,
    );
    assert.equal(field(effects[0], "name"), "scan");
    assert.equal(field(effects[0], "exitCode"), null);
    assert.equal(field(effects[0], "durationMilliseconds"), null);
  }));

await test("CLV-178 incomplete command metadata cannot create a misleading receipt display", () => {
  for (const value of [undefined, null, "command", {}])
    assert.deepEqual(shownCommands(value), []);
  assert.deepEqual(
    shownCommands([
      null,
      { operationId: "op" },
      { operationId: "op", name: "scan" },
      { operationId: "op", name: "scan", state: 7 },
    ]),
    [],
  );
});

await test("CLV-178 the browser renders command receipts through its serialized helpers", () => {
  const model = boardModel([
    {
      status: {
        runId: "run-1",
        workflowId: "review-queue",
        state: "completed",
        commandEffects: [
          {
            operationId: "op-1",
            name: "review-requests",
            state: "completed",
            exitCode: 0,
            durationMilliseconds: 42,
          },
        ],
      },
    },
  ]);
  const result = played(
    model,
    `
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner }));
`,
  );
  assert.match(
    String(result["html"]),
    /Command review-requests · completed · exit 0 · 42 ms/,
  );
});
