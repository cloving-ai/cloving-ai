import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closedReply,
  earlierReply,
  expandReply,
  followReply,
  fullScreenReply,
  heldRead,
  hidden,
  hiddenShown,
  hiddenStreams,
  jumpReply,
  leftReply,
  loadingReply,
  notKeptReply,
  openedReply,
  polled,
  retryReply,
  shownSections,
  streamCount,
  streamPath,
  streamReply,
  transcriptPlayed,
  turnHash,
  turnSection,
} from "./watch-transcript-client-fixture.ts";

await test("CLV-329 the page opens the stream of the turn in work, shows the loading line, and shows each entry of the stream", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: loadingReply,
    scenario: `
const loading = app.inner.includes("The transcript loads.");
send(streams[0], "entry", entryAt(1));
await later();
console.log(JSON.stringify({ loading, address: streams[0]?.address, shown: app.inner.includes("Entry 1") }));
`,
  });
  assert.deepEqual(result, {
    loading: true,
    address: `${streamPath}?after=0`,
    shown: true,
  });
});

await test("CLV-329 a stream that the service refuses after it opens shows the reason and opens no new stream", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: notKeptReply,
    scenario: `
send(streams[0], "refused", { code: "transcript-not-kept", detail: "The transcript of this turn is not kept." });
await later();
draw();
draw();
console.log(JSON.stringify({ notKept: app.inner.includes("The transcript of this turn is not kept."), streams: streams.length, closed: streams[0].readyState }));
`,
  });
  assert.deepEqual(result, { notKept: true, streams: 1, closed: 2 });
});

await test("CLV-329 a failed transcript read opens no new stream at each draw and opens one again at a click on Retry", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: retryReply,
    scenario: `
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
  });
  assert.deepEqual(result, {
    message: true,
    streams: 1,
    retried: 2,
    address: `${streamPath}?after=0`,
  });
});

await test("CLV-329 earlier entries of an ended turn with more than 2000 entries show Jump to the end, and the jump replays the stream into the last window", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: earlierReply,
    scenario: `
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
  });
  assert.deepEqual(result, {
    jump: "Jump to the end",
    streams: 2,
    address: `${streamPath}?after=0`,
  });
});

await test("CLV-329 a page that leaves the run detail closes and drops the transcripts of the run", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: leftReply,
    scenario: `
send(streams[0], "entry", entryAt(1));
await later();
location.hash = "";
replies.push(model);
listeners.hashchange();
await settled();
console.log(JSON.stringify({ kept: Object.keys(transcripts), closed: streams[0].readyState }));
`,
  });
  assert.deepEqual(result, { kept: [], closed: 2 });
});

await test("CLV-329 a link with the turn opens a transcript that the reader hid before", () => {
  const result = transcriptPlayed({
    outcome: "completed",
    reply: hiddenShown,
    scenario: `
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
  });
  assert.deepEqual(result, { hidden: true, shown: true });
});

await test("CLV-329 a stream that stops opens again after its last entry when the transcript read answers", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: streamReply,
    scenario: `
send(streams[0], "entry", entryAt(1));
await later();
${heldRead}
release();
await later();
console.log(JSON.stringify({ streams: streams.length, address: streams.at(-1).address }));
`,
  });
  assert.deepEqual(result, { streams: 2, address: `${streamPath}?after=1` });
});

await test("CLV-329 a transcript read that answers after the page left the run opens no new stream", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: streamCount,
    scenario: `
${heldRead}
location.hash = "";
replies.push(model);
listeners.hashchange();
await settled();
release();
await later();
console.log(JSON.stringify({ streams: streams.length }));
`,
  });
  assert.deepEqual(result, { streams: 1 });
});

await test("CLV-329 a transcript read that answers after the reader hid the turn opens no new stream", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: hiddenStreams,
    scenario: `
${heldRead}
button("Hide")?.dispatch("click");
release();
await later();
console.log(JSON.stringify({ hidden: button("Show") !== undefined, streams: streams.length }));
`,
  });
  assert.deepEqual(result, { hidden: true, streams: 1 });
});

await test("CLV-329 a link with the turn opens a hidden transcript again after the page showed the run without a turn", () => {
  const result = transcriptPlayed({
    outcome: "completed",
    reply: hiddenShown,
    scenario: `
${turnSection}
location.hash = ${JSON.stringify(turnHash)};
listeners.hashchange();
await later();
button("Hide")?.dispatch("click");
location.hash = "#run=run-1";
listeners.hashchange();
await later();
const hidden = button("Show") !== undefined;
location.hash = ${JSON.stringify(turnHash)};
listeners.hashchange();
await later();
await later();
console.log(JSON.stringify({ hidden, shown: button("Hide") !== undefined }));
`,
  });
  assert.deepEqual(result, { hidden: true, shown: true });
});

await test("CLV-329 a click on the link of a hidden turn shows its transcript when the address has that turn already", () => {
  const result = transcriptPlayed({
    outcome: "completed",
    reply: hiddenShown,
    scenario: `
${turnSection}
location.hash = ${JSON.stringify(turnHash)};
listeners.hashchange();
await later();
button("Hide")?.dispatch("click");
const hidden = button("Show") !== undefined;
app.all("a").find((node) => node.inner === "Link")?.dispatch("click");
await later();
await later();
console.log(JSON.stringify({ hidden, shown: button("Hide") !== undefined }));
`,
  });
  assert.deepEqual(result, { hidden: true, shown: true });
});

await test("CLV-332 a reader closes the open transcript of the last turn, and it stays closed after the next poll", () => {
  const result = transcriptPlayed({
    outcome: "completed",
    reply: closedReply,
    scenario: `
const opened = ${hidden};
button("Hide")?.dispatch("click");
await later();
${polled("archived.turns")}
console.log(JSON.stringify({ opened, shown: ${hidden}, closed: button("Show") !== undefined }));
`,
  });
  assert.deepEqual(result, { opened: 1, shown: 0, closed: true });
});

await test("CLV-332 the transcript of a turn that ends stays open when no other turn starts", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: openedReply,
    scenario: `
const opened = ${hidden};
${polled('[{ ...archived.turns[0], outcome: "completed" }]')}
console.log(JSON.stringify({ opened, shown: ${hidden}, streams: streams.length }));
`,
  });
  assert.deepEqual(result, { opened: 1, shown: 1, streams: 1 });
});

await test("CLV-332 a transcript that the reader opened by hand stays open when a new turn becomes the last turn", () => {
  const result = transcriptPlayed({
    outcome: "completed",
    reply: shownSections,
    scenario: `
button("Hide")?.dispatch("click");
button("Show")?.dispatch("click");
await later();
${polled('[archived.turns[0], { ...archived.turns[0], key: "k2", operationId: "operation-2", startedAt: "2026-10-13T21:40:00.000Z" }]')}
const sections = app.all("section").filter((node) => node.getAttribute("data-turn") !== null).length;
console.log(JSON.stringify({ shown: ${hidden}, sections }));
`,
  });
  assert.deepEqual(result, { shown: 2, sections: 2 });
});

await test("CLV-355 the expand button of a turn opens its whole lines area, the turn stays expanded when new entries arrive, and a second click collapses it", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: expandReply,
    scenario: `
send(streams[0], "entry", entryAt(1));
await later();
const expand = () => app.all("button").find((node) => node.getAttribute("class") === "transcript-expand");
const lines = () => app.all("div").find((node) => node.getAttribute("data-transcript") === operationId)?.getAttribute("class");
const before = { label: expand()?.getAttribute("aria-label"), lines: lines() };
expand()?.dispatch("click");
await later();
send(streams[0], "entry", entryAt(2));
await later();
const opened = { expanded: expand()?.getAttribute("aria-expanded"), lines: lines(), entry: app.inner.includes("Entry 2") };
expand()?.dispatch("click");
await later();
console.log(JSON.stringify({ before, opened, closed: { expanded: expand()?.getAttribute("aria-expanded"), lines: lines() } }));
`,
  });
  assert.deepEqual(result, {
    before: { label: "Expand transcript", lines: "transcript-lines" },
    opened: {
      expanded: "true",
      lines: "transcript-lines expanded",
      entry: true,
    },
    closed: { expanded: "false", lines: "transcript-lines" },
  });
});

await test("CLV-355 an expanded turn counts new entries when its end is below the window after a page scroll, and Jump to the end scrolls the page to its end", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: followReply,
    scenario: `
send(streams[0], "entry", entryAt(1));
await later();
app.all("button").find((node) => node.getAttribute("class") === "transcript-expand")?.dispatch("click");
await later();
let bottom = 2000;
const pageMoves = [];
const box = { getAttribute: () => operationId, scrollTop: 0, scrollHeight: 0, getBoundingClientRect: () => ({ bottom }), scrollIntoView: (place) => { pageMoves.push(place.block); } };
document.querySelectorAll = (selector) => (selector === "[data-transcript]" ? [box] : []);
listeners.scroll?.();
send(streams[0], "entry", entryAt(2));
await later();
const jump = button("Jump to the end")?.text ?? null;
button("Jump to the end")?.dispatch("click");
await later();
bottom = 700;
listeners.scroll?.();
send(streams[0], "entry", entryAt(3));
await later();
console.log(JSON.stringify({ jump, scrolled: pageMoves, after: button("Jump to the end") === undefined }));
`,
  });
  assert.deepEqual(result, {
    jump: "Jump to the end · 1 new entry",
    scrolled: ["end"],
    after: true,
  });
});

await test("CLV-355 the full-screen view of an expanded turn follows new entries in its own scroll box", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: fullScreenReply,
    scenario: `
send(streams[0], "entry", entryAt(1));
await later();
app.all("button").find((node) => node.getAttribute("class") === "transcript-expand")?.dispatch("click");
await later();
const box = { getAttribute: () => operationId, scrollTop: 0, scrollHeight: 900, getBoundingClientRect: () => ({ bottom: 2000 }), scrollIntoView: () => undefined };
location.hash = "#run=run-1&turn=" + encodeURIComponent(operationId) + "&view=terminal";
replies.push(model, { run: archived });
document.querySelectorAll = (selector) => (selector === "[data-transcript]" ? [box] : []);
listeners.hashchange();
await later();
send(streams[0], "entry", entryAt(2));
await later();
const lines = app.all("div").find((node) => node.getAttribute("data-transcript") === operationId)?.getAttribute("class");
console.log(JSON.stringify({ top: box.scrollTop, jump: button("Jump to the end") !== undefined, lines }));
`,
  });
  assert.deepEqual(result, {
    top: 900,
    jump: false,
    lines: "transcript-lines",
  });
});

await test("CLV-355 a scroll event of the lines box of an expanded turn does not mark the reader at the end, so a new entry below the window is counted", () => {
  const result = transcriptPlayed({
    outcome: "in work",
    reply: jumpReply,
    scenario: `
send(streams[0], "entry", entryAt(1));
await later();
app.all("button").find((node) => node.getAttribute("class") === "transcript-expand")?.dispatch("click");
await later();
const box = { getAttribute: () => operationId, scrollTop: 0, scrollHeight: 0, getBoundingClientRect: () => ({ bottom: 2000 }), scrollIntoView: () => undefined };
document.querySelectorAll = (selector) => (selector === "[data-transcript]" ? [box] : []);
listeners.scroll?.();
app.all("div").find((node) => node.getAttribute("data-transcript") === operationId)?.dispatch("scroll", { currentTarget: { scrollTop: 0, clientHeight: 1314, scrollHeight: 1314 } });
send(streams[0], "entry", entryAt(2));
await later();
console.log(JSON.stringify({ jump: button("Jump to the end")?.text ?? null }));
`,
  });
  assert.deepEqual(result, { jump: "Jump to the end · 1 new entry" });
});
