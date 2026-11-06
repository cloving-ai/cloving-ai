import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unresumableRuns } from "../src/daemon/unresumable-turns.ts";

function operationOf(run: string): string {
  return JSON.stringify([
    "cloving-operation",
    1,
    run,
    "implement",
    "claude-turn",
    null,
    null,
  ]);
}

async function turn(
  directory: string,
  entry: {
    readonly key: string;
    readonly files: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const folder = join(directory, "journal", entry.key);
  await mkdir(folder, { recursive: true });
  for (const [name, value] of Object.entries(entry.files))
    await writeFile(join(folder, name), JSON.stringify(value));
}

function started(run: string, harness: string): Record<string, unknown> {
  return {
    operationId: operationOf(run),
    harness,
    attempt: 1,
    startedAt: "2026-11-05T10:00:00.000Z",
    turnStartCommit: "0123456789abcdef0123456789abcdef01234567",
  };
}

await test("CLV-306 the runs whose open turns cannot resume are the turns of other harnesses and the turns with no session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-unresumable-"));
  try {
    await turn(directory, {
      key: "claude-session",
      files: {
        "started.json": started("run-claude", "claude"),
        "attempt-1.json": { sessionId: "session-1" },
      },
    });
    await turn(directory, {
      key: "codex-session",
      files: {
        "started.json": started("run-codex", "codex"),
        "attempt-1.json": { sessionId: "session-2" },
      },
    });
    await turn(directory, {
      key: "claude-no-session",
      files: { "started.json": started("run-no-session", "claude") },
    });
    await turn(directory, {
      key: "shell-one",
      files: { "started.json": started("run-shell", "shell") },
    });
    await turn(directory, {
      key: "shell-two",
      files: { "started.json": started("run-shell", "shell") },
    });
    await turn(directory, { key: "not-started", files: {} });
    await turn(directory, {
      key: "shell-no-operation",
      files: { "started.json": { harness: "shell" } },
    });
    await turn(directory, {
      key: "shell-ended",
      files: {
        "started.json": started("run-ended", "shell"),
        "result.json": { outcome: "completed" },
      },
    });
    assert.deepEqual(await unresumableRuns(directory), [
      "run-no-session",
      "run-shell",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CLV-306 a service folder with no turn journal has no run that cannot resume, and a journal that is not a folder fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloving-unresumable-"));
  try {
    assert.deepEqual(await unresumableRuns(directory), []);
    await writeFile(join(directory, "journal"), "");
    await assert.rejects(unresumableRuns(directory), { code: "ENOTDIR" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
