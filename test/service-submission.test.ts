import assert from "node:assert/strict";
import { test } from "node:test";
import { manifest, pin, queryDatabase } from "./authority-store-fixture.ts";
import {
  call,
  digestOf,
  field,
  withHarness,
  text,
  type Harness,
  fields,
  items,
} from "./service-fixture.ts";

const prompt =
  "work on CLV-037: “quotes”, 'single', \"double\"\n  second line  ";

function run(
  harness: Harness,
  parameters: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  return call(harness, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "prompt",
      submission: { prompt },
      commandId: "c-run",
      ...parameters,
    },
  });
}

const normalized = JSON.stringify({
  submission: { prompt },
  workflowId: "develop",
});

await test("CLV-008 a run with a prompt through an injected admitted resolver commits one run and returns the run and receipt identity", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const result = await run(harness, {});
    const runId = text(result, "runId");
    assert.match(runId, /^run-[0-9a-f]{32}$/);
    assert.deepEqual(
      {
        ...result,
        receipt: { ...fields(field(result, "receipt")), recordedAt: "" },
      },
      {
        schemaVersion: 1,
        kind: "run-admitted",
        runId,
        workflowId: "develop",
        commandId: "c-run",
        replayed: false,
        receipt: {
          commandId: "c-run",
          sequence: 1,
          runId,
          recordedAt: "",
          commandDigest: text(field(result, "receipt"), "commandDigest"),
        },
        binding: {
          workflowPin: pin,
          resolver: { id: "fake-resolver", version: "1" },
          requestDigest: digestOf(normalized),
          executionInputDigest: digestOf('{"cycleId":"cycle-1"}'),
        },
      },
    );
    assert.deepEqual(harness.resolved, [
      { workflowId: "develop", submission: { prompt }, commandId: "c-run" },
    ]);
    await service.close();
  }));

await test("CLV-008 a prompt and the equivalent input give the same normalized request digest and the same receipt under one command ID", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const first = await run(harness, {});
    const second = await run(harness, { source: "input" });
    assert.equal(field(second, "replayed"), true);
    assert.deepEqual(field(second, "receipt"), field(first, "receipt"));
    assert.deepEqual(field(second, "binding"), field(first, "binding"));
    assert.equal(field(second, "runId"), field(first, "runId"));
    assert.equal(harness.resolved.length, 1);
    await service.close();
  }));

await test("CLV-008 the service stores a prompt with Unicode, quotes and newlines exactly, and the event stream and the events table do not hold it", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const result = await run(harness, {});
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 10 },
    });
    await service.close();
    const stored = queryDatabase(
      harness.stateDirectory,
      "SELECT digest, body FROM documents ORDER BY digest",
    );
    const request = stored.find(
      (row) =>
        field(row, "digest") ===
        text(field(result, "binding"), "requestDigest"),
    );
    assert.equal(text(request, "body"), normalized);
    assert.equal(
      text(field(JSON.parse(text(request, "body")), "submission"), "prompt"),
      prompt,
    );
    assert.equal(JSON.stringify(events).includes("CLV-037"), false);
    assert.equal(
      JSON.stringify(
        queryDatabase(harness.stateDirectory, "SELECT * FROM events"),
      ).includes("CLV-037"),
      false,
    );
  }));

await test("CLV-008 the service stores the original input, the digests, the workflow and resolver identity and the execution binding before the success response", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const result = await run(harness, {});
    await service.close();
    assert.deepEqual(
      queryDatabase(
        harness.stateDirectory,
        "SELECT r.workflow, d.submission, d.input, d.resolver FROM runs r JOIN run_details d ON d.run_id = r.run_id",
      ),
      [
        {
          workflow: pin,
          submission: digestOf(normalized),
          input: digestOf('{"cycleId":"cycle-1"}'),
          resolver: "fake-resolver:1",
        },
      ],
    );
    assert.deepEqual(
      queryDatabase(
        harness.stateDirectory,
        "SELECT body FROM documents WHERE digest = '" +
          text(field(result, "binding"), "executionInputDigest") +
          "'",
      ),
      [{ body: '{"cycleId":"cycle-1"}' }],
    );
  }));

await test("CLV-008 invalid submissions and unusable workflows are rejected before admission", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        harness.registration,
        {
          ...harness.registration,
          workflowId: "batch",
          submission: { maximumBytes: 4096, fields: { cycleId: "string" } },
        },
        {
          ...harness.registration,
          workflowId: "develop-ticket",
          availability: "unavailable",
        },
      ],
    });
    const cases: readonly (readonly [
      Readonly<Record<string, unknown>>,
      string,
    ])[] = [
      [{ submission: { prompt: "x".repeat(5000) } }, "input-too-large"],
      [{ submission: { prompt: 5 }, source: "input" }, "invalid-submission"],
      [
        { submission: { prompt, extra: "y" }, source: "input" },
        "invalid-submission",
      ],
      [{ submission: { prompt: "  " }, source: "input" }, "invalid-submission"],
      [{ submission: [prompt], source: "input" }, "invalid-submission"],
      [{ workflowId: "batch" }, "unsupported-prompt"],
      [
        { workflowId: "batch", source: "input", submission: { prompt } },
        "invalid-submission",
      ],
      [{ workflowId: "absent" }, "unknown-workflow"],
      [{ workflowId: "develop-ticket" }, "workflow-unavailable"],
      [{ commandId: "not valid" }, "invalid-request"],
    ];
    for (const [parameters, code] of cases)
      assert.deepEqual(
        [
          field(await run(harness, parameters), "kind"),
          field(await run(harness, parameters), "code"),
        ],
        ["error", code],
        JSON.stringify(parameters),
      );
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 10 },
    });
    assert.deepEqual(field(events, "events"), []);
    assert.deepEqual(harness.resolved, []);
    await service.close();
  }));

await test("CLV-008 the service rejects a changed prompt or a changed workflow under the same command ID", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const first = await run(harness, {});
    for (const changed of [
      { submission: { prompt: `${prompt}!` } },
      { submission: { prompt: `${prompt}!` }, source: "input" },
    ]) {
      const conflict = await run(harness, changed);
      assert.deepEqual(
        [
          field(conflict, "kind"),
          field(conflict, "code"),
          field(conflict, "commandId"),
        ],
        ["error", "conflicting-command", "c-run"],
      );
    }
    const repeated = await run(harness, {});
    assert.deepEqual(field(repeated, "receipt"), field(first, "receipt"));
    assert.equal(harness.resolved.length, 1);
    await service.close();
  }));

await test("CLV-008 a lost response, a restart and a retry give one run, one receipt and one execution binding, with no second resolver call", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const admitted = await run(harness, {});
    await first.close();
    const second = await harness.start();
    const retried = await run(harness, {});
    assert.equal(field(retried, "replayed"), true);
    assert.deepEqual(field(retried, "receipt"), field(admitted, "receipt"));
    assert.deepEqual(field(retried, "binding"), field(admitted, "binding"));
    assert.equal(harness.resolved.length, 1);
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(items(field(status, "runs")).length, 1);
    await second.close();
    assert.equal(manifest.name, "develop");
  }));

await test("CLV-008 two submissions with one command ID at the same time commit one run and call the resolver one time", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const [left, right] = await Promise.all([
      run(harness, {}),
      run(harness, {}),
    ]);
    assert.deepEqual(field(left, "receipt"), field(right, "receipt"));
    assert.deepEqual(
      [field(left, "replayed"), field(right, "replayed")].sort(),
      [false, true],
    );
    assert.equal(harness.resolved.length, 1);
    await service.close();
  }));
