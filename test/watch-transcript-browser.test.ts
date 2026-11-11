import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { located } from "../src/daemon/operation-journal.ts";
import { transcriptFiles } from "../src/daemon/transcript-files.ts";
import { operationOf } from "./effect-fixture.ts";
import { requested, untilStates } from "./service-effect-fixture.ts";
import { fields, withHarness, type Harness } from "./service-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { directWatch } from "./watch-direct-fixture.ts";
import { realBrowser } from "./watch-real-browser.ts";
import { reportTurn, workerScene } from "./worker-report-fixture.ts";
import {
  called,
  compactLines,
  output,
  paired,
  panelBox,
  said,
} from "./watch-transcript-browser-fixture.ts";

async function liveTurn(harness: Harness) {
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

await test("CLV-332 a link with the turn opens the run detail with that ended turn expanded, the run detail without it opens the last ended turn, and a turn that the reader hides stays closed", () =>
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
      assert.deepEqual(linked, { count: 1, last: "⏺Done." });
      await page.navigate("about:blank");
      await page.navigate(run);
      assert.deepEqual(await page.evaluate(entryCount(1)), {
        count: 1,
        last: "⏺Done.",
      });
      await page.click(".transcript-toggle");
      await delay(1500);
      const closed = await page.evaluate(`(() => ({
        toggle: document.querySelector(".transcript-toggle")?.textContent ?? null,
        lines: document.querySelectorAll(".transcript-lines").length,
      }))()`);
      assert.deepEqual(closed, { toggle: "Show", lines: 0 });
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));

const callWith = (id: string, command: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
    },
  });
const outputFor = (id: string, text: string): string =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content: text }],
    },
  });

const terminalForm = (
  expected: readonly (readonly string[])[],
) => `(async () => {
  const form = () => [...document.querySelectorAll(".transcript-lines > .entry")].map((node) =>
    node.classList.contains("tool-call")
      ? [node.querySelector(".tool-line > summary")?.textContent ?? "", ...[...node.querySelectorAll(".entry.tool-result")].map((item) => [...item.querySelectorAll("summary, pre")].map((part) => part.textContent).join(" | "))]
      : [node.textContent]);
  const wanted = ${JSON.stringify(JSON.stringify(expected))};
  for (let attempt = 0; attempt < ${String(testMilliseconds(10_000) / 20)}; attempt++) {
    if (JSON.stringify(form()) === wanted) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { form: form() };
})()`;

await test("CLV-333 the open turn shows the prompt and each new entry of a turn that writes a line each second in the terminal form within 2 seconds, with each result under its call", () =>
  withHarness(async (harness) => {
    const turn = await liveTurn(harness);
    await writeFile(
      join(turn.folder, "turn-prompts.jsonl"),
      `${JSON.stringify({ attempt: 1, prompt: "Fix CLV-333." })}\n`,
    );
    const watch = await directWatch(harness.runtimeDirectory);
    try {
      await using browser = await realBrowser();
      const page = await browser.page({ width: 1200, height: 900 });
      await page.navigate(`${watch.address}#run=${turn.live.runId}`);
      const prompt = ["> Fix CLV-333."];
      assert.deepEqual(await page.evaluate(terminalForm([prompt])), {
        form: [prompt],
      });
      const steps: readonly (readonly [
        string,
        readonly (readonly string[])[],
      ])[] = [
        [said("I read the ticket."), [prompt, ["⏺I read the ticket."]]],
        [
          callWith("toolu_1", "npm test"),
          [prompt, ["⏺I read the ticket."], ["⏺ Bash(npm test)"]],
        ],
        [
          callWith("toolu_2", "npm run lint"),
          [
            prompt,
            ["⏺I read the ticket."],
            ["⏺ Bash(npm test)"],
            ["⏺ Bash(npm run lint)"],
          ],
        ],
        [
          outputFor("toolu_1", "1 test failed"),
          [
            prompt,
            ["⏺I read the ticket."],
            ["⏺ Bash(npm test)", "⎿ 1 line | 1 test failed"],
            ["⏺ Bash(npm run lint)"],
          ],
        ],
      ];
      for (const [line, expected] of steps) {
        await appendFile(turn.stream, `${line}\n`);
        const written = performance.now();
        const shown = await page.evaluate(terminalForm(expected));
        const waited = performance.now() - written;
        assert.deepEqual(shown, { form: expected });
        assert.ok(waited <= testMilliseconds(2000), String(waited));
        await delay(1000);
      }
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));

const colors = `(() => {
  const luminance = (color) => {
    const [red, green, blue] = color.match(/[\\d.]+/g).slice(0, 3).map(Number);
    return Math.round(((0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255) * 100) / 100;
  };
  const measured = (scheme) => {
    document.documentElement.setAttribute("data-scheme", scheme);
    return {
      page: luminance(getComputedStyle(document.documentElement).backgroundColor),
      panel: luminance(getComputedStyle(document.querySelector(".transcript")).backgroundColor),
      lines: luminance(getComputedStyle(document.querySelector(".transcript-lines")).backgroundColor),
    };
  };
  return { light: measured("light"), dark: measured("dark") };
})()`;

await test("CLV-333 CLV-355 the terminal panel is dark in the light and the dark scheme, a short open turn is short, a long one stops at 60 percent of the window with its own scroll, each tool call keeps its fold count on its own line, agent text shows its Markdown, and the full-screen link shows only the panel at the size of the window", () =>
  withHarness(async (harness) => {
    const turn = await liveTurn(harness);
    await appendFile(turn.stream, `${said("Done.")}\n`);
    const watch = await directWatch(harness.runtimeDirectory);
    try {
      await using browser = await realBrowser();
      const page = await browser.page({ width: 1200, height: 900 });
      await page.navigate(`${watch.address}#run=${turn.live.runId}`);
      const detail = await page.evaluate(panelBox);
      assert.ok(Number(detail["height"]) < 200, JSON.stringify(detail));
      const calls = Array.from({ length: 40 }, (_, index) => paired(index));
      await appendFile(
        turn.stream,
        `${calls.join("\n")}\n${said("**Checked.** All `tests` pass.")}\n`,
      );
      const lines = fields(await page.evaluate(compactLines));
      assert.equal(lines["calls"], 40, JSON.stringify(lines));
      assert.ok(Number(lines["tallest"]) <= 24, JSON.stringify(lines));
      assert.equal(lines["sameRow"], true, JSON.stringify(lines));
      assert.ok(Number(lines["box"]) <= 0.6 * 900 + 24, JSON.stringify(lines));
      assert.ok(
        Number(lines["scroll"]) > Number(lines["box"]),
        JSON.stringify(lines),
      );
      assert.equal(lines["strong"], "Checked.", JSON.stringify(lines));
      const { light, dark } = await page.evaluate(colors);
      assert.ok(Number(fields(light)["page"]) > 0.8, JSON.stringify(light));
      assert.ok(Number(fields(dark)["page"]) < 0.2, JSON.stringify(dark));
      for (const scheme of [light, dark]) {
        assert.ok(
          Number(fields(scheme)["panel"]) < 0.15,
          JSON.stringify(scheme),
        );
        assert.ok(
          Number(fields(scheme)["lines"]) < 0.15,
          JSON.stringify(scheme),
        );
      }
      await page.navigate("about:blank");
      await page.navigate(
        `${watch.address}#run=${turn.live.runId}&turn=${encodeURIComponent(turn.operationId)}&view=terminal`,
      );
      assert.deepEqual(await page.evaluate(panelBox), {
        headers: 0,
        sections: 1,
        width: 1200,
        height: 900,
        window: [1200, 900],
      });
    } finally {
      assert.equal(await watch.stop(), 0);
    }
  }));
