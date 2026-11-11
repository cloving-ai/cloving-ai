import assert from "node:assert/strict";
import { replyReader, type ReplyRead } from "./checked-reply-fixture.ts";
import { played } from "./watch-browser.ts";
import { sampleModel, sampleRun } from "./watch-sample.ts";

export const operationId =
  '["cloving-operation",1,"run-1","work","effect",1,null]';
export const streamPath = `api/v1/runs/run-1/turns/${encodeURIComponent(operationId)}/transcript-stream`;
export const turnHash = `#run=run-1&turn=${encodeURIComponent(operationId)}`;
export const heldRead = `
const answered = globalThis.fetch;
let release = () => undefined;
globalThis.fetch = (address) => address.includes("/transcript?")
  ? new Promise((settle) => { release = () => { settle(new Response(JSON.stringify({ entries: [], nextAfter: 1, open: true }))); }; })
  : answered(address);
streams[0].readyState = 2;
streams[0].onerror();
`;
export const turnSection = `document.querySelectorAll = () => [{ getAttribute: () => operationId, scrollIntoView: () => undefined }];`;

export const polled = (turns: string) => `
replies.push(model, { run: { ...archived, turns: ${turns} } });
await load();
await settled();
`;
export const hidden = `app.all("button").filter((node) => node.inner === "Hide").length`;

export function transcriptPlayed<Reply>(scene: {
  readonly outcome: string;
  readonly scenario: string;
  readonly reply: (read: ReplyRead) => Reply;
}): Reply {
  const [reviewed] = sampleRun().turns;
  assert.ok(reviewed !== undefined);
  const archived = sampleRun({
    turns: [{ ...reviewed, operationId, outcome: scene.outcome }],
  });
  const values = played(
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
${scene.scenario}
`,
  );
  return scene.reply(replyReader("transcript-scenario", values));
}

export const loadingReply = (read: ReplyRead) => ({
  loading: read.flag("loading"),
  address: read.text("address"),
  shown: read.flag("shown"),
});

export const notKeptReply = (read: ReplyRead) => ({
  notKept: read.flag("notKept"),
  streams: read.number("streams"),
  closed: read.number("closed"),
});

export const retryReply = (read: ReplyRead) => ({
  message: read.flag("message"),
  streams: read.number("streams"),
  retried: read.number("retried"),
  address: read.text("address"),
});

export const earlierReply = (read: ReplyRead) => ({
  jump: read.textOrNull("jump"),
  streams: read.number("streams"),
  address: read.text("address"),
});

export const leftReply = (read: ReplyRead) => ({
  kept: read.texts("kept"),
  closed: read.number("closed"),
});

export const hiddenShown = (read: ReplyRead) => ({
  hidden: read.flag("hidden"),
  shown: read.flag("shown"),
});

export const streamReply = (read: ReplyRead) => ({
  streams: read.number("streams"),
  address: read.text("address"),
});

export const streamCount = (read: ReplyRead) => ({
  streams: read.number("streams"),
});

export const hiddenStreams = (read: ReplyRead) => ({
  hidden: read.flag("hidden"),
  streams: read.number("streams"),
});

export const closedReply = (read: ReplyRead) => ({
  opened: read.number("opened"),
  shown: read.number("shown"),
  closed: read.flag("closed"),
});

export const openedReply = (read: ReplyRead) => ({
  opened: read.number("opened"),
  shown: read.number("shown"),
  streams: read.number("streams"),
});

export const shownSections = (read: ReplyRead) => ({
  shown: read.number("shown"),
  sections: read.number("sections"),
});

export const expandReply = (read: ReplyRead) => ({
  before: {
    label: read.part("before").text("label"),
    lines: read.part("before").text("lines"),
  },
  opened: {
    expanded: read.part("opened").text("expanded"),
    lines: read.part("opened").text("lines"),
    entry: read.part("opened").flag("entry"),
  },
  closed: {
    expanded: read.part("closed").text("expanded"),
    lines: read.part("closed").text("lines"),
  },
});

export const followReply = (read: ReplyRead) => ({
  jump: read.textOrNull("jump"),
  scrolled: read.texts("scrolled"),
  after: read.flag("after"),
});

export const fullScreenReply = (read: ReplyRead) => ({
  top: read.number("top"),
  jump: read.flag("jump"),
  lines: read.text("lines"),
});

export const jumpReply = (read: ReplyRead) => ({
  jump: read.textOrNull("jump"),
});
