import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { queueFeed } from "../src/daemon/queue-feed.ts";
import { withHarness } from "./service-fixture.ts";

await test("CLV-362 restart restores the last feed counts and all reported skips", () =>
  withHarness(async (harness) => {
    const file = join(harness.stateDirectory, "queue-feed.json");
    const skipped = Array.from({ length: 70 }, () => ({
      id: "900",
      reason: "in work",
    }));
    const last = { at: "2026-11-13T09:40:00.000Z", picks: 20, skipped };
    await writeFile(file, JSON.stringify({ last }));
    const shown: unknown[] = [];
    await queueFeed(
      {
        directory: harness.stateDirectory,
        runtimeDirectory: harness.runtimeDirectory,
        workflowId: "develop",
        intervalMilliseconds: 1000,
      },
      (value) => shown.push(value),
    );
    assert.deepEqual(shown, [last]);
  }));

await test("CLV-362 corrupt feed progress fails closed instead of starting a fresh feed", () =>
  withHarness(async (harness) => {
    const file = join(harness.stateDirectory, "queue-feed.json");
    const valid = { at: "2026-11-13T09:40:00.000Z", picks: 1, skipped: [] };
    const malformed = [
      [],
      { commandId: 1 },
      { index: -1 },
      { index: 21 },
      { notBefore: null },
      {
        inWork: Array.from({ length: 21 }, () => ({
          id: "900",
          reason: "in work",
        })),
      },
      { last: { ...valid, at: "bad time" } },
      { last: { ...valid, picks: 21 } },
      { last: { ...valid, skipped: [{ id: "bad id", reason: "wait" }] } },
      {
        last: {
          ...valid,
          skipped: Array.from({ length: 71 }, () => ({
            id: "900",
            reason: "wait",
          })),
        },
      },
    ];
    const settings = {
      directory: harness.stateDirectory,
      runtimeDirectory: harness.runtimeDirectory,
      workflowId: "develop",
      intervalMilliseconds: 1000,
    };
    for (const value of malformed) {
      await writeFile(file, JSON.stringify(value));
      await assert.rejects(
        queueFeed(settings, () => undefined),
        /invalid-feed-journal/,
      );
    }
    await writeFile(file, "{");
    await assert.rejects(
      queueFeed(settings, () => undefined),
      SyntaxError,
    );
    await mkdir(join(harness.stateDirectory, "blocked"));
    await mkdir(join(harness.stateDirectory, "blocked", "queue-feed.json"));
    await assert.rejects(
      queueFeed(
        {
          ...settings,
          queueDirectory: join(harness.stateDirectory, "blocked"),
        },
        () => undefined,
      ),
      /EISDIR/,
    );
  }));
