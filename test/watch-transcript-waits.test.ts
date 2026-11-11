import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactWait,
  entriesWait,
  expandWait,
  jumpWait,
  panelWait,
  replyOf,
} from "./watch-transcript-browser-fixture.ts";

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
