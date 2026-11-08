import assert from "node:assert/strict";
import { test } from "node:test";
import { played } from "./watch-browser.ts";
import { sampleModel, sampleRun } from "./watch-sample.ts";

const operationId = '["cloving-operation",1,"run-1","work","effect",1,null]';
const streamPath = `api/v1/runs/run-1/turns/${encodeURIComponent(operationId)}/transcript-stream`;

function transcriptPlayed(
  turn: { readonly outcome: string },
  scenario: string,
): Record<string, unknown> {
  const [reviewed] = sampleRun().turns;
  assert.ok(reviewed !== undefined);
  const archived = sampleRun({
    turns: [{ ...reviewed, operationId, outcome: turn.outcome }],
  });
  return played(
    { ...sampleModel([]), archived },
    `
const { archived, ...model } = JSON.parse(process.env.WATCH_MODEL);
const operationId = ${JSON.stringify(operationId)};
const streams = [];
globalThis.EventSource = class {
  constructor(address) { this.address = address; this.listeners = {}; this.readyState = 1; streams.push(this); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  close() { this.readyState = 2; }
};
const send = (source, type, data) => source.listeners[type]?.({ data: JSON.stringify(data) });
const entryAt = (position) => ({ position, attempt: 1, kind: "assistant", text: "Entry " + position, tool: null, summary: "", error: false, omittedBytes: 0 });
const button = (text) => app.all("button").find((node) => node.inner.startsWith(text));
const later = () => new Promise((settle) => { setTimeout(settle, 80); });
location.hash = "#run=run-1";
replies.push(model, { run: archived });
await load();
await settled();
${scenario}
`,
  );
}

await test("CLV-329 the page opens the stream of the turn in work, shows the loading line, and shows each entry of the stream", () => {
  const result = transcriptPlayed(
    { outcome: "in work" },
    `
const loading = app.inner.includes("The transcript loads.");
send(streams[0], "entry", entryAt(1));
await later();
console.log(JSON.stringify({ loading, address: streams[0]?.address, shown: app.inner.includes("Entry 1") }));
`,
  );
  assert.deepEqual(result, {
    loading: true,
    address: `${streamPath}?after=0`,
    shown: true,
  });
});

await test("CLV-329 a stream that the service refuses after it opens shows the reason and opens no new stream", () => {
  const result = transcriptPlayed(
    { outcome: "in work" },
    `
send(streams[0], "refused", { code: "transcript-not-kept", detail: "The transcript of this turn is not kept." });
await later();
draw();
draw();
console.log(JSON.stringify({ notKept: app.inner.includes("The transcript of this turn is not kept."), streams: streams.length, closed: streams[0].readyState }));
`,
  );
  assert.deepEqual(result, { notKept: true, streams: 1, closed: 2 });
});

await test("CLV-329 a failed transcript read opens no new stream at each draw and opens one again at a click on Retry", () => {
  const result = transcriptPlayed(
    { outcome: "in work" },
    `
replies.push(new Response(JSON.stringify({ code: "service-unavailable", detail: "The Cloving service does not answer." }), { status: 503 }));
streams[0].readyState = 2;
streams[0].onerror();
await later();
draw();
draw();
const failed = { message: app.inner.includes("The Cloving service does not answer."), streams: streams.length };
button("Retry")?.dispatch("click");
await settled();
console.log(JSON.stringify({ ...failed, retried: streams.length, address: streams.at(-1).address }));
`,
  );
  assert.deepEqual(result, {
    message: true,
    streams: 1,
    retried: 2,
    address: `${streamPath}?after=0`,
  });
});

await test("CLV-329 earlier entries of an ended turn with more than 2000 entries show Jump to the end, and the jump opens the stream after the last window", () => {
  const result = transcriptPlayed(
    { outcome: "in work" },
    `
for (let position = 1; position <= 2001; position++) send(streams[0], "entry", entryAt(position));
send(streams[0], "end", { nextAfter: 2001 });
await later();
replies.push({ entries: [entryAt(1)], nextAfter: 1, open: false });
button("Load earlier entries")?.dispatch("click");
await later();
const jump = button("Jump to the end")?.inner ?? null;
button("Jump to the end")?.dispatch("click");
await settled();
console.log(JSON.stringify({ jump, streams: streams.length, address: streams.at(-1).address }));
`,
  );
  assert.deepEqual(result, {
    jump: "Jump to the end",
    streams: 2,
    address: `${streamPath}?after=1`,
  });
});

await test("CLV-329 a page that leaves the run detail closes and drops the transcripts of the run", () => {
  const result = transcriptPlayed(
    { outcome: "in work" },
    `
send(streams[0], "entry", entryAt(1));
await later();
location.hash = "";
replies.push(model);
listeners.hashchange();
await settled();
console.log(JSON.stringify({ kept: Object.keys(transcripts), closed: streams[0].readyState }));
`,
  );
  assert.deepEqual(result, { kept: [], closed: 2 });
});

await test("CLV-329 a link with the turn opens a transcript that the reader hid before", () => {
  const result = transcriptPlayed(
    { outcome: "completed" },
    `
button("Show")?.dispatch("click");
button("Hide")?.dispatch("click");
const hidden = button("Show") !== undefined;
location.hash = "#run=run-1&turn=" + encodeURIComponent(operationId);
replies.push(model, { run: archived });
document.querySelectorAll = () => [{ getAttribute: () => operationId, scrollIntoView: () => undefined }];
listeners.hashchange();
await later();
await later();
console.log(JSON.stringify({ hidden, shown: button("Hide") !== undefined }));
`,
  );
  assert.deepEqual(result, { hidden: true, shown: true });
});
