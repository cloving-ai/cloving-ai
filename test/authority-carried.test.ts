import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import {
  executeTyped,
  noon,
  promptText,
  question,
  started,
} from "./authority-decision-fixture.ts";
import {
  manifest,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

const admission = storedGate[0] ?? {};

await test("CLV-008 the authority rejects a command that it cannot convert to JSON as a malformed command, and the session stays open", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  assert.deepEqual(
    await executePinned(authority, { ...admission, attempt: 1n }),
    {
      kind: "rejected",
      reason: "invalid-command",
      detail: "unserializable-command",
    },
  );
  assert.deepEqual(await authority.events(), []);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  assert.equal((await authority.state()).sequence, 1);
  await authority.close();
});

await test("CLV-008 the library logger writes no text to the standard output of a process that prints machine output", async () => {
  const child = spawnSync(
    process.execPath,
    [resolve("test/authority-logger-child.ts"), await temporaryDirectory()],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(child.stdout.split("\n"), ['{"kind":"accepted"}', ""]);
  const entries = child.stderr
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(Reflect.get(Object(entry), "level"), "error");
    assert.equal(
      Reflect.get(Object(entry), "event"),
      "solid_objects.instrumentation.failed",
    );
  }
});

await test("CLV-008 the authority rejects a request above its size limit as request-too-large, and the session stays open", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  for (const body of ["x".repeat(1_100_000), '"'.repeat(520_000)]) {
    const receipt = await executeTyped(authority, {
      command: { ...admission, commandId: "c-large" },
      documents: [body],
    });
    assert.deepEqual(
      [receipt.kind, Reflect.get(receipt, "reason")],
      ["rejected", "request-too-large"],
    );
  }
  assert.deepEqual(await authority.events(), []);
  assert.equal((await executePinned(authority, admission)).kind, "accepted");
  assert.equal((await authority.state()).sequence, 1);
  await authority.close();
});

const report = {
  kind: "report-observation",
  commandId: "c-2",
  runId: "run-1",
  condition: "working",
  reason: "progress",
};

await test("CLV-008 a report with an operation text that is not printable ASCII is rejected, and a report with each printable ASCII character survives a reopening", async () => {
  const directory = await temporaryDirectory();
  const first = await openedAuthority(directory);
  await executePinned(first, admission);
  for (const operationId of [
    "op-\ud800",
    "op-\u0000",
    "op-\u00e9",
    "op-\n",
    "op-\u007f",
    "",
    "x".repeat(513),
  ]) {
    const receipt = await executeTyped(first, {
      command: { ...report, operationId },
    });
    assert.deepEqual(
      [receipt.kind, Reflect.get(receipt, "reason")],
      ["rejected", "invalid-command"],
      JSON.stringify(operationId),
    );
  }
  const printable = Array.from({ length: 95 }, (_, index) =>
    String.fromCharCode(32 + index),
  ).join("");
  const accepted = await executeTyped(first, {
    command: { ...report, operationId: printable },
  });
  assert.equal(accepted.kind, "accepted");
  const state = await first.state();
  assert.equal(state.details["run-1"]?.observation?.operationId, printable);
  await first.close();
  const second = await openedAuthority(directory);
  assert.deepEqual(await second.state(), state);
  await second.close();
});

await test("CLV-008 the authority rejects a command with a deeply nested value as an invalid command, and the session stays open", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await executePinned(authority, admission);
  let nested: unknown = "progress";
  for (let level = 0; level < 150; level += 1) nested = [nested];
  const disguised = { ...report };
  Object.setPrototypeOf(disguised, {
    toJSON: () => ({ ...report, reason: nested }),
  });
  for (const command of [
    { ...report, reason: nested },
    { ...report, extra: nested },
    { ...report, commandId: nested },
    disguised,
  ]) {
    const receipt = await executeTyped(authority, { command });
    assert.deepEqual(
      [receipt.kind, Reflect.get(receipt, "reason")],
      ["rejected", "invalid-command"],
    );
  }
  assert.equal(
    (await executeTyped(authority, { command: report })).kind,
    "accepted",
  );
  assert.equal((await authority.state()).sequence, 2);
  await authority.close();
});

function mixed(values: readonly unknown[]): string[] {
  const documents: string[] = [];
  values.forEach((value, index) => Reflect.set(documents, index, value));
  return documents;
}

const invalid = { kind: "rejected", reason: "invalid-command" };

await test("CLV-008 the authority rejects a request with a document that is not a text or a context of a wrong form as an invalid command, and the session stays open", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  await executePinned(authority, admission);
  await executeTyped(authority, { command: started });
  for (const body of [
    Buffer.from(promptText),
    new Uint8Array([1, 2, 3]),
    5,
    null,
    [promptText],
    { body: promptText },
  ])
    assert.deepEqual(
      await executeTyped(authority, {
        command: question,
        documents: mixed([body]),
      }),
      invalid,
      JSON.stringify(body),
    );
  for (const [name, value] of [
    ["documents", promptText],
    ["recordedAt", 5],
    ["epoch", "one"],
  ] as const) {
    const context = { recordedAt: noon, documents: [promptText] };
    Reflect.set(context, name, value);
    assert.deepEqual(await authority.execute(question, context), invalid, name);
  }
  assert.equal((await authority.events()).length, 2);
  const opened = await executeTyped(authority, {
    command: question,
    documents: [promptText],
  });
  assert.equal(opened.kind, "accepted");
  assert.equal((await authority.state()).sequence, 3);
  await authority.close();
});

await test("CLV-008 the authority stores the JSON form of a command, and it reads a manifest in its checked form", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  let nested: unknown = "extra";
  for (let level = 0; level < 150; level += 1) nested = [nested];
  const context = { recordedAt: noon, manifest };
  Reflect.set(context, "manifest", { ...manifest, extra: nested });
  assert.equal((await authority.execute(admission, context)).kind, "accepted");
  const renamed = { ...report };
  Object.setPrototypeOf(renamed, {
    toJSON: () => ({ ...report, reason: "from-json" }),
  });
  assert.equal(
    (await executeTyped(authority, { command: renamed })).kind,
    "accepted",
  );
  const state = await authority.state();
  assert.equal(state.details["run-1"]?.observation?.reason, "from-json");
  assert.equal(state.sequence, 2);
  await authority.close();
});
