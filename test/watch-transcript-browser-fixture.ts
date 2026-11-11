import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { located } from "../src/daemon/operation-journal.ts";
import { transcriptFiles } from "../src/daemon/transcript-files.ts";
import { operationOf } from "./effect-fixture.ts";
import { requested, untilStates } from "./service-effect-fixture.ts";
import type { Harness } from "./service-fixture.ts";
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
export const compactLines = `(async () => {
  const all = () => [...document.querySelectorAll(".transcript-lines .entry.tool-call")];
  for (let attempt = 0; attempt < 500 && (all().length < 40 || !document.querySelector(".transcript-lines .markdown strong")); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const box = document.querySelector(".transcript-lines");
  const rows = all().map((call) => {
    const line = call.querySelector(".tool-line > summary").getBoundingClientRect();
    const fold = call.querySelector(".tool-result > summary").getBoundingClientRect();
    return { height: call.getBoundingClientRect().height, same: Math.abs(line.top - fold.top) < 2 && fold.left > line.right - 1 };
  });
  return {
    calls: rows.length,
    tallest: Math.max(...rows.map((row) => row.height)),
    sameRow: rows.every((row) => row.same),
    box: box.clientHeight,
    scroll: box.scrollHeight,
    strong: document.querySelector(".transcript-lines .markdown strong")?.textContent ?? null,
  };
})()`;
export const panelBox = `(async () => {
  for (let attempt = 0; attempt < 500 && !document.querySelector(".transcript-lines .entry"); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const box = document.querySelector(".transcript").getBoundingClientRect();
  return {
    headers: document.querySelectorAll("header").length,
    sections: document.querySelectorAll("section").length,
    width: box.width,
    height: box.height,
    window: [innerWidth, innerHeight],
  };
})()`;

export const expandBox = (expanded: "true" | "false") => `(async () => {
  const button = () => document.querySelector(".transcript-expand");
  for (let attempt = 0; attempt < 500 && button()?.getAttribute("aria-expanded") !== "${expanded}"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const box = document.querySelector(".transcript-lines");
  const area = box.getBoundingClientRect();
  const place = button().getBoundingClientRect();
  return {
    expanded: button().getAttribute("aria-expanded"),
    height: area.height,
    scroll: box.scrollHeight,
    top: area.top,
    right: place.right,
    bottom: place.bottom,
    edge: document.querySelector(".transcript").getBoundingClientRect().right,
  };
})()`;

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

export const pageAtTurn = `(async () => {
  for (let attempt = 0; attempt < 500 && document.querySelectorAll(".transcript-lines .entry.tool-call").length < 60; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  scrollTo(0, document.querySelector(".transcript").getBoundingClientRect().top + scrollY - 10);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { top: scrollY };
})()`;

export const jumpPlace = `(async () => {
  const jump = () => document.querySelector(".transcript-jump");
  for (let attempt = 0; attempt < 500 && !(jump()?.textContent ?? "").includes("2 new"); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const place = jump().getBoundingClientRect();
  return { text: jump().textContent, top: place.top, bottom: place.bottom, window: innerHeight };
})()`;
