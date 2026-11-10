import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/authority/commands.ts";
import {
  admission,
  applied,
  rejection,
  started,
} from "./effect-pure-fixture.ts";

const rename = {
  kind: "rename-run",
  commandId: "rename-1",
  runId: "run-1",
  title: "Fix the flaky retention test",
  label: "SID-4820",
};

await test("CLV-334 rename-run takes a valid title with an optional label, or neither to remove the manual name", () => {
  assert.equal(parseCommand(rename)?.title, "Fix the flaky retention test");
  assert.equal(parseCommand(rename)?.label, "SID-4820");
  assert.equal(
    parseCommand({ ...rename, label: undefined })?.kind,
    "rename-run",
  );
  assert.equal(
    parseCommand({ kind: "rename-run", commandId: "c", runId: "run-1" })?.kind,
    "rename-run",
  );
  assert.equal(parseCommand({ ...rename, title: " padded" }), null);
  assert.equal(parseCommand({ ...rename, title: "" }), null);
  assert.equal(parseCommand({ ...rename, title: "Two\nlines" }), null);
  assert.equal(parseCommand({ ...rename, label: "two words" }), null);
  assert.equal(parseCommand({ ...rename, title: undefined }), null);
});

await test("CLV-334 the authority records run.renamed for an active run and for a run that ended", () => {
  const active = applied([admission, started, rename]);
  assert.equal(active.state.commands["rename-1"]?.sequence, 3);
  assert.deepEqual(active.last.events.at(-1)?.payload, {
    title: "Fix the flaky retention test",
    label: "SID-4820",
  });
  assert.equal(active.last.events.at(-1)?.type, "run.renamed");
  assert.equal(active.state.runs["run-1"]?.revision, 2);
  for (const kind of ["complete-run", "fail-run", "cancel-run"]) {
    const ended = applied([
      admission,
      started,
      { kind, commandId: `c-${kind}`, runId: "run-1", expectedRevision: 2 },
      rename,
    ]);
    assert.equal(ended.last.events.at(-1)?.type, "run.renamed", kind);
  }
  assert.equal(
    rejection(applied([admission]).state, { ...rename, runId: "run-9" }),
    "unknown-run",
  );
});
