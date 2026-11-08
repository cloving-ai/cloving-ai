import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { located } from "../src/daemon/operation-journal.ts";
import { transcriptFiles } from "../src/daemon/transcript-files.ts";
import { operationOf } from "./effect-fixture.ts";
import { requested, untilStates } from "./service-effect-fixture.ts";
import { withHarness, type Harness } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { directWatch } from "./watch-direct-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { reportTurn, workerScene } from "./worker-report-fixture.ts";

const said = (words: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: words }] },
  });
const called = (command: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  });
const output = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: text }] },
  });

async function liveTurn(harness: Harness) {
  const scene = await workerScene(harness);
  await scene.service.close();
  const root = dirname(harness.runtimeDirectory);
  const service = await harness.start({
    ...scene.options,
    turnTranscript: { read: transcriptFiles(root), privateTexts: [] },
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

const entryCount = (count: number) => `(async () => {
  const frame = () => new Promise((resolve) => setTimeout(resolve, 20));
  for (let attempt = 0; attempt < ${String(testMilliseconds(10_000) / 20)}; attempt++) {
    const found = document.querySelectorAll(".transcript-lines .entry");
    if (found.length >= ${String(count)}) return { count: found.length, last: found[found.length - 1].textContent };
    await frame();
  }
  return { count: document.querySelectorAll(".transcript-lines .entry").length, last: "" };
})()`;

const scrolled = `(() => {
  const box = document.querySelector(".transcript-lines");
  return { top: box.scrollTop, end: box.scrollHeight - box.clientHeight, jump: document.querySelector(".transcript-jump")?.textContent ?? null };
})()`;

await test("CLV-329 the open turn of a run detail shows each new assistant text, tool call and tool result of a turn that writes a line each second within 2 seconds, without a page reload", () =>
  withHarness(async (harness) => {
    const turn = await liveTurn(harness);
    const watch = await directWatch(harness.runtimeDirectory);
    try {
      await using browser = await realBrowser();
      const page = await browser.page({ width: 1200, height: 900 });
      await page.navigate(`${watch.address}#run=${turn.live.runId}`);
      await page.evaluate(`(async () => {
        for (let attempt = 0; attempt < 500 && !document.querySelector(".transcript-lines"); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        window.loaded = performance.timeOrigin;
        return {};
      })()`);
      const lines = [
        said("I read the ticket."),
        called("npm test"),
        output("1 test failed"),
      ];
      for (const [index, line] of lines.entries()) {
        await appendFile(turn.stream, `${line}\n`);
        const written = performance.now();
        const shown = await page.evaluate(entryCount(index + 1));
        const waited = performance.now() - written;
        assert.equal(shown["count"], index + 1);
        assert.ok(waited <= testMilliseconds(2000), String(waited));
        await delay(1000);
      }
      const texts = await page.evaluate(`(() => ({
        kinds: [...document.querySelectorAll(".transcript-lines .entry")].map((node) => node.className),
        loaded: window.loaded === performance.timeOrigin,
      }))()`);
      assert.deepEqual(texts, {
        kinds: ["entry assistant", "entry tool-call", "entry tool-result"],
        loaded: true,
      });
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));

await test("CLV-329 the view stops at a scroll up, shows Jump to the end with the count of new entries, and follows again after the jump", () =>
  withHarness(async (harness) => {
    const turn = await liveTurn(harness);
    const many = Array.from({ length: 60 }, (_, index) =>
      output(`output ${String(index)}`),
    );
    await appendFile(turn.stream, `${many.join("\n")}\n`);
    const watch = await directWatch(harness.runtimeDirectory);
    try {
      await using browser = await realBrowser();
      const page = await browser.page({ width: 1200, height: 900 });
      await page.navigate(`${watch.address}#run=${turn.live.runId}`);
      assert.equal((await page.evaluate(entryCount(60)))["count"], 60);
      const following = await page.evaluate(scrolled);
      assert.ok(Number(following["end"]) > 0);
      assert.equal(following["top"], following["end"]);
      await page.evaluate(`(() => {
        const box = document.querySelector(".transcript-lines");
        box.scrollTop = 0;
        box.dispatchEvent(new Event("scroll"));
        return {};
      })()`);
      await appendFile(turn.stream, `${output("later")}\n`);
      assert.equal((await page.evaluate(entryCount(61)))["count"], 61);
      await delay(200);
      const stopped = await page.evaluate(scrolled);
      assert.deepEqual(
        { top: stopped["top"], jump: stopped["jump"] },
        { top: 0, jump: "Jump to the end · 1 new entry" },
      );
      await page.click(".transcript-jump");
      await delay(200);
      const jumped = await page.evaluate(scrolled);
      assert.equal(jumped["top"], jumped["end"]);
      assert.equal(jumped["jump"], null);
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));

await test("CLV-329 a link with the turn opens the run detail with that ended turn expanded, and the run detail without it keeps the ended turn closed", () =>
  withHarness(async (harness) => {
    const turn = await liveTurn(harness);
    await appendFile(turn.stream, `${said("Done.")}\n`);
    await reportTurn(turn.live, { round: 1, result: "{}" });
    await writeFile(
      join(turn.folder, "result.json"),
      JSON.stringify({
        outcome: "completed",
        result: "{}",
        endedAt: new Date().toISOString(),
      }),
    );
    const watch = await directWatch(harness.runtimeDirectory);
    try {
      await using browser = await realBrowser();
      const page = await browser.page({ width: 1200, height: 900 });
      const run = `${watch.address}#run=${turn.live.runId}`;
      await page.navigate(
        `${run}&turn=${encodeURIComponent(turn.operationId)}`,
      );
      const linked = await page.evaluate(entryCount(1));
      assert.deepEqual(linked, { count: 1, last: "Done." });
      await page.navigate("about:blank");
      await page.navigate(run);
      const closed = await page.evaluate(`(async () => {
        for (let attempt = 0; attempt < 500 && !document.querySelector(".transcript-toggle"); attempt++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        return { toggle: document.querySelector(".transcript-toggle")?.textContent ?? null, lines: document.querySelectorAll(".transcript-lines").length };
      })()`);
      assert.deepEqual(closed, { toggle: "Show", lines: 0 });
      await page.click(".transcript-toggle");
      assert.deepEqual(await page.evaluate(entryCount(1)), {
        count: 1,
        last: "Done.",
      });
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));
