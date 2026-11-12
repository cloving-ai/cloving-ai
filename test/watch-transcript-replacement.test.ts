import assert from "node:assert/strict";
import { test } from "node:test";
import { transcriptPlayed } from "./watch-transcript-client-fixture.ts";

await test("CLV-364 the watch transcript replaces partial blocks and removes discarded blocks", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: (read) => ({
      partial: read.flag("partial"),
      entries: read.texts("entries"),
    }),
    scenario: `
send(streams[0], "entry", { ...entryAt(1), replaceId: "pi:message:1:0" });
await later();
const partial = app.inner.includes("Entry 1");
send(streams[0], "entry", { ...entryAt(2), replaceId: "pi:message:1:1" });
send(streams[0], "entry", { ...entryAt(3), replaceId: "pi:message:1:0" });
send(streams[0], "entry", { ...entryAt(4), replaceId: "pi:message:1:1", removed: true, text: "" });
send(streams[0], "entry", { ...entryAt(5), attempt: 2, replaceId: "pi:message:1:0" });
send(streams[0], "entry", { ...entryAt(3), replaceId: "pi:message:1:0" });
await later();
console.log(JSON.stringify({ partial, entries: transcripts[operationId].entries.map((entry) => entry.text) }));
`,
  });
  assert.deepEqual(result, { partial: true, entries: ["Entry 3", "Entry 5"] });
});

await test("CLV-364 earlier history and jump handle sparse replacement positions and removed entries", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: (read) => ({
      earlier: read.texts("earlier"),
      removed: read.flag("removed"),
      address: read.text("address"),
    }),
    scenario: `
for (let position = 1000; position <= 2001000; position += 1000) send(streams[0], "entry", entryAt(position));
await later();
const answered = globalThis.fetch;
globalThis.fetch = (address) => address.includes("/transcript?")
  ? Promise.resolve(new Response(JSON.stringify({ entries: [{ ...entryAt(900), removed: true, replaceId: "discarded" }, entryAt(1000), entryAt(2000)], nextAfter: 2000, hasEarlier: false, open: true })))
  : answered(address);
button("Load earlier entries")?.dispatch("click");
await later();
const item = transcripts[operationId];
const earlier = item.entries.slice(0, 2).map((entry) => entry.text);
const removed = item.entries.some((entry) => entry.removed);
button("Jump to the end")?.dispatch("click");
await settled();
console.log(JSON.stringify({ earlier, removed, address: streams.at(-1).address }));
`,
  });
  assert.deepEqual(result, {
    earlier: ["Entry 1000", "Entry 2000"],
    removed: false,
    address:
      "api/v1/runs/run-1/turns/" +
      encodeURIComponent(
        '["cloving-operation",1,"run-1","work","effect",1,null]',
      ) +
      "/transcript-stream?after=0",
  });
});

await test("CLV-364 repeated earlier loads fetch one bounded page before the visible cursor", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: (read) => ({
      addresses: read.texts("addresses"),
      texts: read.texts("texts"),
    }),
    scenario: `
for (let position = 1000; position <= 2001000; position += 1000) send(streams[0], "entry", entryAt(position));
await later();
const answered = globalThis.fetch;
const addresses = [];
globalThis.fetch = (address) => {
  if (!address.includes("/transcript?")) return answered(address);
  addresses.push(address.split("?")[1]);
  const position = addresses.length === 1 ? 1000 : 500;
  return Promise.resolve(new Response(JSON.stringify({ entries: addresses.length > 2 ? [] : [entryAt(position)], nextAfter: position, hasEarlier: true, open: true })));
};
button("Load earlier entries")?.dispatch("click");
await later();
button("Load earlier entries")?.dispatch("click");
await later();
console.log(JSON.stringify({ addresses, texts: transcripts[operationId].entries.slice(0, 2).map((entry) => entry.text) }));
`,
  });
  assert.deepEqual(result, {
    addresses: ["before=2000", "before=1000"],
    texts: ["Entry 500", "Entry 1000"],
  });
});

await test("CLV-364 concurrent earlier clicks cannot duplicate a pending page", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: (read) => ({
      requests: read.number("requests"),
      duplicates: read.flag("duplicates"),
    }),
    scenario: `
for (let position = 1; position <= 2001; position++) send(streams[0], "entry", entryAt(position));
await later();
const answered = globalThis.fetch;
const releases = [];
globalThis.fetch = (address) => address.includes("/transcript?")
  ? new Promise((resolve) => releases.push(() => resolve(new Response(JSON.stringify({ entries: [entryAt(1)], nextAfter: 1, hasEarlier: false, open: true })))))
  : answered(address);
button("Load earlier entries")?.dispatch("click");
button("Load earlier entries")?.dispatch("click");
for (const release of releases) release();
await later();
const positions = transcripts[operationId].entries.map((entry) => entry.position);
console.log(JSON.stringify({ requests: releases.length, duplicates: new Set(positions).size !== positions.length }));
`,
  });
  assert.deepEqual(result, { requests: 1, duplicates: false });
});
