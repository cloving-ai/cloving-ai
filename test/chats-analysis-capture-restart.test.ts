import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureAnalysisSnapshot,
  readCapturedAnalysisSnapshot,
} from "../src/daemon/chats-capture.ts";
import { readAnalysisSnapshot } from "../src/daemon/chats-files.ts";
import { darwinChatFileArguments } from "./chats-darwin-emulation.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withAnalysis, importId } from "./chats-worker-fixture.ts";

async function pausedCapture(directory: string, boundary: string) {
  const child = fork(
    join(import.meta.dirname, "chats-analysis-capture-crash-fixture.ts"),
    [directory, "capture-restart", importId, boundary],
    { execArgv: [...darwinChatFileArguments()], stdio: "pipe" },
  );
  const exited = once(child, "exit");
  try {
    assert.deepEqual(
      await once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      ["capture-write-paused", undefined],
    );
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }
  return { child, exited };
}

async function interruptCapture(directory: string, boundary: string) {
  const { child, exited } = await pausedCapture(directory, boundary);
  child.kill("SIGKILL");
  assert.deepEqual(await exited, [null, "SIGKILL"]);
}

await test(
  "CLV-119 concurrent captures reuse one complete publication and clean temporary files",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const binding = { runId: "concurrent-capture", importId };
      const [first, second] = await Promise.all([
        captureAnalysisSnapshot(fixture.directory, binding),
        captureAnalysisSnapshot(fixture.directory, binding),
      ]);
      assert.ok(first);
      assert.deepEqual(second, first);
      assert.deepEqual(
        await readCapturedAnalysisSnapshot(fixture.directory, first),
        await readAnalysisSnapshot(fixture.directory, { importId }),
      );
      assert.deepEqual(
        (await fixture.files()).filter((name) => name.includes("capture-")),
        [`capture-${first.key}`],
      );
    });
  }),
);

for (const boundary of [
  "redaction.json",
  "redacted.jsonl",
  "capture.json",
  "checkpoint-0.json",
  "proposal-0.txt",
]) {
  await test(
    `CLV-119 retries capture after process termination at ${boundary}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const expected = await readAnalysisSnapshot(fixture.directory, {
          importId,
        });
        await interruptCapture(fixture.directory, boundary);
        const files = await fixture.files();
        assert.equal(
          files.filter((name) => name.startsWith("capture-")).length,
          0,
        );
        const staged = files.find((name) => name.startsWith(".capture-"));
        assert.ok(staged);
        const folder = join(fixture.directory, staged);
        assert.equal((await stat(folder)).mode & 0o777, 0o700);
        for (const name of await readdir(folder))
          assert.equal((await stat(join(folder, name))).mode & 0o777, 0o600);
        const binding = { runId: "capture-restart", importId };
        const capture = await captureAnalysisSnapshot(
          fixture.directory,
          binding,
        );
        assert.deepEqual(
          await readCapturedAnalysisSnapshot(fixture.directory, capture),
          expected,
        );
        assert.deepEqual(
          await captureAnalysisSnapshot(fixture.directory, binding),
          capture,
        );
        assert.deepEqual(
          (await fixture.files()).filter((name) => name.includes("capture-")),
          [`capture-${capture.key}`],
        );
      });
    }),
  );
}

await test(
  "CLV-119 preserves an active capture and reclaims it after its owner exits even with a publication",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const { child, exited } = await pausedCapture(
        fixture.directory,
        "redacted.jsonl",
      );
      const binding = { runId: "capture-restart", importId };
      try {
        const staged = (await fixture.files()).find((name) =>
          name.startsWith(".capture-"),
        );
        assert.ok(staged);
        const capture = await captureAnalysisSnapshot(
          fixture.directory,
          binding,
        );
        assert.ok((await fixture.files()).includes(staged));
        assert.deepEqual(
          await readCapturedAnalysisSnapshot(fixture.directory, capture),
          await readAnalysisSnapshot(fixture.directory, { importId }),
        );
      } finally {
        child.kill("SIGKILL");
        assert.deepEqual(await exited, [null, "SIGKILL"]);
      }
      const capture = await captureAnalysisSnapshot(fixture.directory, binding);
      assert.deepEqual(
        (await fixture.files()).filter((name) => name.includes("capture-")),
        [`capture-${capture.key}`],
      );
    });
  }),
);

await test(
  "CLV-119 reclaims abandoned captures when a different analysis run starts",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      await interruptCapture(fixture.directory, "redacted.jsonl");
      const capture = await captureAnalysisSnapshot(fixture.directory, {
        runId: "later-analysis",
        importId,
      });
      assert.deepEqual(
        (await fixture.files()).filter((name) => name.includes("capture-")),
        [`capture-${capture.key}`],
      );
    });
  }),
);
