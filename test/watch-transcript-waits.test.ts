import assert from "node:assert/strict";
import { test } from "node:test";
import { replyReader } from "./checked-reply-fixture.ts";
import {
  compactWait,
  entriesWait,
  expandWait,
  jumpWait,
  panelWait,
  replyOf,
} from "./watch-transcript-browser-fixture.ts";
import {
  hiddenShown,
  transcriptPlayed,
} from "./watch-transcript-client-fixture.ts";

const expandReply = {
  expanded: "true",
  calls: 60,
  height: 1314,
  scroll: 1314,
  top: 472,
  right: 1158,
  bottom: 460,
  edge: 1180,
};

await test("CLV-355 each transcript page wait narrows the browser reply to the typed values that its test reads", () => {
  assert.deepEqual(
    replyOf(entriesWait(120), { entries: 120, calls: 60, wanted: 120 }),
    { entries: 120, calls: 60 },
  );
  assert.deepEqual(
    replyOf(panelWait, {
      headers: 0,
      sections: 1,
      width: 1200,
      height: 900,
      windowWidth: 1200,
      windowHeight: 900,
    }),
    { headers: 0, sections: 1, width: 1200, height: 900, window: [1200, 900] },
  );
  assert.deepEqual(
    replyOf(compactWait, {
      calls: 40,
      tallest: 22,
      sameRow: true,
      box: 500,
      scroll: 900,
      strong: "Checked.",
    }),
    {
      calls: 40,
      tallest: 22,
      sameRow: true,
      box: 500,
      scroll: 900,
      strong: "Checked.",
    },
  );
  assert.deepEqual(replyOf(expandWait("true"), expandReply), expandReply);
  assert.deepEqual(
    replyOf(jumpWait(2), {
      text: "Jump to the end · 2 new entries",
      top: 869,
      bottom: 892,
      window: 900,
      entries: 122,
      expanded: "true",
    }),
    {
      text: "Jump to the end · 2 new entries",
      top: 869,
      bottom: 892,
      window: 900,
      entries: 122,
      expanded: "true",
    },
  );
});

await test("CLV-355 a browser reply with a missing or wrong value fails with the wait name, the field and the reply on the first line", () => {
  const missing = { ...expandReply, height: null };
  assert.throws(() => replyOf(expandWait("true"), missing), {
    message: `transcript-not-expanded: height is not a number: ${JSON.stringify(missing)}`,
  });
  assert.throws(
    () => replyOf(jumpWait(2), { text: 3, top: 1, bottom: 2, window: 900 }),
    { message: /^jump-count-missing: text is not a text: \{"text":3,/ },
  );
  assert.throws(
    () =>
      replyOf(compactWait, {
        calls: 40,
        tallest: 22,
        sameRow: "yes",
        box: 500,
        scroll: 900,
        strong: "Checked.",
      }),
    { message: /^compact-lines-missing: sameRow is not a flag: / },
  );
});

await test("CLV-355 the shared reply readers check a text list, a text or null and a nested record, and name the field of a wrong value", () => {
  const read = replyReader("sample", {
    kept: ["a", "b"],
    jump: null,
    before: { label: "Expand transcript" },
    mixed: ["a", 1],
  });
  assert.deepEqual(read.texts("kept"), ["a", "b"]);
  assert.equal(read.textOrNull("jump"), null);
  assert.equal(read.part("before").text("label"), "Expand transcript");
  assert.throws(() => read.texts("mixed"), {
    message: /^sample: mixed is not a text list: /,
  });
  assert.throws(() => read.part("before").number("label"), {
    message: /^sample.before: label is not a number: /,
  });
  assert.throws(() => read.part("kept"), {
    message: /^sample: kept is not a record: /,
  });
});

await test("CLV-355 a transcript page scenario returns its checked reply, and a reply of the wrong type fails with the field on the first line", () => {
  assert.deepEqual(
    transcriptPlayed({
      outcome: "in work",
      reply: hiddenShown,
      scenario: `console.log(JSON.stringify({ hidden: true, shown: false }));`,
    }),
    { hidden: true, shown: false },
  );
  assert.throws(
    () =>
      transcriptPlayed({
        outcome: "in work",
        reply: hiddenShown,
        scenario: `console.log(JSON.stringify({ hidden: "yes", shown: false }));`,
      }),
    { message: /^transcript-scenario: hidden is not a flag: / },
  );
});
