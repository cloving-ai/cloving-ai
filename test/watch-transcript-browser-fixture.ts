import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { located } from "../src/daemon/operation-journal.ts";
import { transcriptFiles } from "../src/daemon/transcript-files.ts";
import type { Fields } from "../src/protocol.ts";
import { operationOf } from "./effect-fixture.ts";
import { requested, untilStates } from "./service-effect-fixture.ts";
import { fields, type Harness } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import type { realBrowser } from "./watch-real-browser.ts";
import { workerScene } from "./worker-report-fixture.ts";

export const said = (words: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: words }] },
  });
export const called = (command: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  });
export const output = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: text }] },
  });
export const paired = (index: number): string =>
  [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: `call-${String(index)}`,
            name: "Bash",
            input: { command: `echo ${String(index)}` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `call-${String(index)}`,
            content: "one\ntwo\nthree",
          },
        ],
      },
    }),
  ].join("\n");

export async function liveTurn(harness: Harness) {
  const scene = await workerScene(harness);
  await scene.service.close();
  const root = dirname(harness.runtimeDirectory);
  const service = await harness.start({
    ...scene.options,
    turnTranscript: {
      read: transcriptFiles(root),
      privateTexts: [],
      cache: new Map(),
    },
  });
  const live = { ...scene, service };
  await requested(live, {
    commandId: `request-${scene.runId}-1`,
    round: 1,
    capability: "claude",
  });
  await untilStates(live, ["running"]);
  const operationId = operationOf(scene.runId, { round: 1 });
  const { folder } = located(join(root, "journal"), operationId);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "started.json"),
    JSON.stringify({
      operationId,
      harness: "claude",
      target: "clv-329",
      branch: "cloving/clv-329",
      worktree: "work",
      startedAt: new Date().toISOString(),
    }),
  );
  const stream = join(folder, "turn.jsonl");
  await writeFile(stream, "");
  return { live, operationId, folder, stream };
}

export type BrowserPage = Awaited<
  ReturnType<Awaited<ReturnType<typeof realBrowser>>["page"]>
>;

export interface ReplyRead {
  readonly number: (key: string) => number;
  readonly text: (key: string) => string;
  readonly flag: (key: string) => boolean;
}

export interface PageWait<Reply> {
  readonly name: string;
  readonly ready: string;
  readonly read: string;
  readonly reply: (read: ReplyRead) => Reply;
}

export interface EntriesReply {
  readonly entries: number;
  readonly calls: number;
}

export interface PanelReply {
  readonly headers: number;
  readonly sections: number;
  readonly width: number;
  readonly height: number;
  readonly window: readonly [number, number];
}

export interface CompactReply {
  readonly calls: number;
  readonly tallest: number;
  readonly sameRow: boolean;
  readonly box: number;
  readonly scroll: number;
  readonly strong: string;
}

export interface ExpandReply {
  readonly expanded: string;
  readonly calls: number;
  readonly height: number;
  readonly scroll: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly edge: number;
}

export interface JumpReply {
  readonly text: string;
  readonly top: number;
  readonly bottom: number;
  readonly window: number;
  readonly entries: number;
  readonly expanded: string;
}

export function replyOf<Reply>(wait: PageWait<Reply>, values: Fields): Reply {
  const failed = (key: string, kind: string): string =>
    `${wait.name}: ${key} is not ${kind}: ${JSON.stringify(values)}`;
  return wait.reply({
    number: (key) => {
      const value = values[key];
      assert.ok(typeof value === "number", failed(key, "a number"));
      return value;
    },
    text: (key) => {
      const value = values[key];
      assert.ok(typeof value === "string", failed(key, "a text"));
      return value;
    },
    flag: (key) => {
      const value = values[key];
      assert.ok(typeof value === "boolean", failed(key, "a flag"));
      return value;
    },
  });
}

export function pagePoll(wait: {
  readonly ready: string;
  readonly read: string;
}): string {
  return `(async () => {
  const ready = () => ${wait.ready};
  const end = performance.now() + ${String(testMilliseconds(2_000))};
  while (!ready() && performance.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return { ok: ready(), ...${wait.read} };
})()`;
}

export async function waitedFor<Reply>(
  page: BrowserPage,
  wait: PageWait<Reply>,
): Promise<Reply> {
  const end = Date.now() + testMilliseconds(20_000);
  let found = fields(await page.evaluate(pagePoll(wait)));
  while (found["ok"] !== true && Date.now() < end)
    found = fields(await page.evaluate(pagePoll(wait)));
  const { ok, ...values } = found;
  assert.equal(ok, true, `${wait.name}: ${JSON.stringify(values)}`);
  return replyOf(wait, values);
}

const entryCount = `document.querySelectorAll(".transcript-lines .entry").length`;
const callCount = `document.querySelectorAll(".transcript-lines .entry.tool-call").length`;

export const entriesWait = (entries: number): PageWait<EntriesReply> => ({
  name: "transcript-entries-missing",
  ready: `${entryCount} >= ${String(entries)}`,
  read: `({ entries: ${entryCount}, calls: ${callCount}, wanted: ${String(entries)} })`,
  reply: (read) => ({
    entries: read.number("entries"),
    calls: read.number("calls"),
  }),
});

export const panelWait: PageWait<PanelReply> = {
  name: "transcript-panel-missing",
  ready: `document.querySelector(".transcript-lines .entry") !== null`,
  read: `(() => {
    const box = document.querySelector(".transcript")?.getBoundingClientRect();
    return { headers: document.querySelectorAll("header").length, sections: document.querySelectorAll("section").length, width: box?.width ?? null, height: box?.height ?? null, windowWidth: innerWidth, windowHeight: innerHeight };
  })()`,
  reply: (read) => ({
    headers: read.number("headers"),
    sections: read.number("sections"),
    width: read.number("width"),
    height: read.number("height"),
    window: [read.number("windowWidth"), read.number("windowHeight")],
  }),
};

export const compactWait: PageWait<CompactReply> = {
  name: "compact-lines-missing",
  ready: `${callCount} >= 40 && document.querySelector(".transcript-lines .markdown strong") !== null`,
  read: `(() => {
    const rows = [...document.querySelectorAll(".transcript-lines .entry.tool-call")].map((call) => {
      const line = call.querySelector(".tool-line > summary")?.getBoundingClientRect();
      const fold = call.querySelector(".tool-result > summary")?.getBoundingClientRect();
      return { height: call.getBoundingClientRect().height, same: line !== undefined && fold !== undefined && Math.abs(line.top - fold.top) < 2 && fold.left > line.right - 1 };
    });
    const box = document.querySelector(".transcript-lines");
    return { calls: rows.length, tallest: Math.max(0, ...rows.map((row) => row.height)), sameRow: rows.every((row) => row.same), box: box?.clientHeight ?? null, scroll: box?.scrollHeight ?? null, strong: document.querySelector(".transcript-lines .markdown strong")?.textContent ?? null };
  })()`,
  reply: (read) => ({
    calls: read.number("calls"),
    tallest: read.number("tallest"),
    sameRow: read.flag("sameRow"),
    box: read.number("box"),
    scroll: read.number("scroll"),
    strong: read.text("strong"),
  }),
};

export const expandWait = (
  expanded: "true" | "false",
): PageWait<ExpandReply> => ({
  name:
    expanded === "true" ? "transcript-not-expanded" : "transcript-not-capped",
  ready: `document.querySelector(".transcript-expand")?.getAttribute("aria-expanded") === "${expanded}"`,
  read: `(() => {
    const button = document.querySelector(".transcript-expand");
    const box = document.querySelector(".transcript-lines");
    const area = box?.getBoundingClientRect();
    const place = button?.getBoundingClientRect();
    return { expanded: button?.getAttribute("aria-expanded") ?? null, calls: ${callCount}, height: area?.height ?? null, scroll: box?.scrollHeight ?? null, top: area?.top ?? null, right: place?.right ?? null, bottom: place?.bottom ?? null, edge: document.querySelector(".transcript")?.getBoundingClientRect().right ?? null };
  })()`,
  reply: (read) => ({
    expanded: read.text("expanded"),
    calls: read.number("calls"),
    height: read.number("height"),
    scroll: read.number("scroll"),
    top: read.number("top"),
    right: read.number("right"),
    bottom: read.number("bottom"),
    edge: read.number("edge"),
  }),
});

export const jumpWait = (count: number): PageWait<JumpReply> => ({
  name: "jump-count-missing",
  ready: `document.querySelector(".transcript-jump")?.textContent === "Jump to the end · ${String(count)} new entries"`,
  read: `(() => {
    const jump = document.querySelector(".transcript-jump");
    const place = jump?.getBoundingClientRect();
    return { text: jump?.textContent ?? null, top: place?.top ?? null, bottom: place?.bottom ?? null, window: innerHeight, entries: ${entryCount}, expanded: document.querySelector(".transcript-expand")?.getAttribute("aria-expanded") ?? null };
  })()`,
  reply: (read) => ({
    text: read.text("text"),
    top: read.number("top"),
    bottom: read.number("bottom"),
    window: read.number("window"),
    entries: read.number("entries"),
    expanded: read.text("expanded"),
  }),
});

export const turnAtTop = `(async () => {
  scrollTo(0, document.querySelector(".transcript").getBoundingClientRect().top + scrollY - 10);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { top: scrollY };
})()`;
