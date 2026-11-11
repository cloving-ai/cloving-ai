import assert from "node:assert/strict";
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

export function transcriptPlayed(
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
