import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyCommand, notifyRuns } from "../src/daemon/notify.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withHarness } from "./service-fixture.ts";

const notification = {
  event: "failed",
  runId: "run-one",
  workflowId: "develop-ticket",
  subject: "Failed",
  body: "cloving status run-one",
} as const;

await test("CLV-090 notify commands that cannot start fail without an unhandled input error", async () => {
  await assert.rejects(
    notifyCommand(["/missing-notify-command"], notification),
    /ENOENT/,
  );
  await assert.rejects(notifyCommand([], notification), /empty/);
});

await test("CLV-090 notify commands that ignore termination are killed after the thirty second deadline", async () => {
  const started = performance.now();
  await assert.rejects(
    notifyCommand(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
      ],
      notification,
    ),
    /SIGKILL/,
  );
  assert.ok(performance.now() - started >= 29_000);
  assert.ok(performance.now() - started < 35_000);
});

await test("CLV-090 invalid and unreadable notification records refuse notification startup", async () => {
  await withHarness(async (harness) => {
    const file = join(harness.stateDirectory, "notify-events.json");
    const settings = {
      directory: harness.stateDirectory,
      runtimeDirectory: harness.runtimeDirectory,
      command: ["false"],
    };
    for (const text of ["{", "{}", "[1]"]) {
      await writeFile(file, text);
      await assert.rejects(notifyRuns(settings));
    }
    await assert.rejects(
      notifyRuns({ ...settings, directory: file }),
      /ENOTDIR/,
    );
  });
});
