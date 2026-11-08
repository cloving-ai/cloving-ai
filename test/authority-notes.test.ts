import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isNoteId,
  isNoteText,
  noteLimit,
  noteText,
} from "../src/authority/notes.ts";
import { parseCommand } from "../src/authority/commands.ts";

await test("CLV-326 a note has 1 to 4000 characters after trimming, counted as code points", () => {
  assert.equal(noteLimit, 4000);
  assert.equal(noteText("  Merge first.\n"), "Merge first.");
  assert.equal(noteText(" \t\n "), undefined);
  assert.equal(noteText(7), undefined);
  assert.equal(noteText("\u{1F600}".repeat(4000)), "\u{1F600}".repeat(4000));
  assert.equal(noteText("x".repeat(4001)), undefined);
  assert.equal(isNoteText("Merge first."), true);
  assert.equal(isNoteText(" Merge first."), false);
  assert.equal(isNoteId(`note-${"0".repeat(32)}`), true);
  assert.equal(isNoteId("note-1"), false);
  assert.equal(isNoteId(1), false);
});

await test("CLV-326 an admission carries a note only as a continuation, and note-run takes only the source continue", () => {
  const admission = {
    kind: "admit-run",
    commandId: "c-1",
    runId: "run-2",
    workflow: "sha256:pin",
    note: "Merge first.",
  };
  const continued = {
    ...admission,
    continuedFrom: "run-1",
    reuseBefore: 3,
    continueRequest: `sha256:${"a".repeat(64)}`,
  };
  assert.equal(parseCommand(admission), null);
  assert.equal(parseCommand(continued)?.note, "Merge first.");
  assert.equal(parseCommand({ ...continued, note: " Merge first." }), null);
  const noted = {
    kind: "note-run",
    commandId: `note-${"0".repeat(32)}`,
    runId: "run-2",
    noteId: `note-${"0".repeat(32)}`,
    note: "Merge first.",
    source: "continue",
  };
  assert.equal(parseCommand(noted)?.kind, "note-run");
  assert.equal(parseCommand({ ...noted, source: "steer" }), null);
});
