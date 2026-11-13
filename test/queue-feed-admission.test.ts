import { queueJournal } from "../src/daemon/queue-journal.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, field, text, withHarness } from "./service-fixture.ts";
import { queuedFeed } from "./queue-feed-fixture.ts";

await test("CLV-362 a feed resumes after a partial admission without losing in-work skips", () =>
  withHarness(async (harness) => {
    const fixture = await queuedFeed(harness);
    await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "feed",
        submission: { ticket: { id: "900", text: "Active" } },
        commandId: "active",
      },
    });
    let feed = await fixture.load();
    await feed.next(fixture.attempt);
    await fixture.complete({
      picks: [
        { id: "900", text: "Duplicate" },
        { id: "901", text: "Next" },
      ],
      skipped: [],
    });
    let checks = 0;
    await assert.rejects(
      feed.next({
        ...fixture.attempt,
        available: () => {
          if (++checks === 2) throw new Error("lost process");
          return Promise.resolve(true);
        },
      }),
      /lost process/,
    );
    feed = await fixture.load();
    await feed.next(fixture.attempt);
    assert.deepEqual(fixture.shown.at(-1)?.skipped, [
      { id: "900", reason: "in work" },
    ]);
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(Array.isArray(status["runs"]) && status["runs"].length, 2);
  }));

await test("CLV-362 feed picks mark submission ownership before the final workspace check", () =>
  withHarness(async (harness) => {
    const fixture = await queuedFeed(harness);
    const feed = await fixture.load();
    await feed.next(fixture.attempt);
    await fixture.complete({
      picks: [{ id: "900", text: "Work" }],
      skipped: [],
    });
    await feed.next({
      ...fixture.attempt,
      available: async () => {
        assert.equal(
          await readFile(
            join(fixture.settings.directory, "queue-submission"),
            "utf8",
          ),
          "",
        );
        return true;
      },
    });
    await assert.rejects(
      readFile(join(fixture.settings.directory, "queue-submission")),
      /ENOENT/,
    );
  }));

await test("CLV-362 the service capacity check stops a feed when the last free lane disappears", () =>
  withHarness(async (harness) => {
    const fixture = await queuedFeed(harness);
    for (const id of ["900", "901"])
      await call(harness, {
        operation: "run",
        parameters: {
          workflowId: "develop",
          commandId: id,
          source: "feed",
          submission: { ticket: { id, text: "Work" } },
        },
      });
    const feed = await fixture.load();
    await feed.next(fixture.attempt);
    assert.equal(field(await fixture.progress(), "commandId"), undefined);
    assert.deepEqual(fixture.shown, []);
  }));

await test("CLV-362 a failed internal feed names its failure and never admits work", () =>
  withHarness(async (harness) => {
    const fixture = await queuedFeed(harness);
    const feed = await fixture.load();
    await feed.next(fixture.attempt);
    const runId = runIdentity(text(await fixture.progress(), "commandId"));
    assert.equal(
      (
        await fixture.service.worker.failed({
          runId,
          commandId: "failed",
          expectedRevision: 1,
        })
      ).kind,
      "accepted",
    );
    await assert.rejects(feed.next(fixture.attempt), /queue-feed-failed/);
    assert.deepEqual(fixture.shown, []);
  }));

await test("CLV-362 an unexpected pick refusal is reported instead of discarding the feed", () =>
  withHarness(async (harness) => {
    const fixture = await queuedFeed(harness, {
      resolver: {
        id: "unavailable",
        version: "1",
        resolve: () =>
          Promise.resolve({
            kind: "rejected",
            code: "resolver-failure",
            detail: "The input resolver failed.",
          }),
      },
    });
    const feed = await fixture.load();
    await feed.next(fixture.attempt);
    await fixture.complete({
      picks: [{ id: "900", text: "Work" }],
      skipped: [],
    });
    await assert.rejects(feed.next(fixture.attempt), /resolver-failure/);
    assert.equal(typeof field(await fixture.progress(), "commandId"), "string");
  }));

await test("CLV-362 recovery advances an already tracked pick before retiring its completed work", () =>
  withHarness(async (harness) => {
    const fixture = await queuedFeed(harness);
    let feed = await fixture.load();
    await feed.next(fixture.attempt);
    await fixture.complete({
      picks: [{ id: "900", text: "Work" }],
      skipped: [],
    });
    const temporary = join(fixture.settings.directory, "queue-feed.json.tmp");
    await mkdir(temporary);
    await assert.rejects(feed.next(fixture.attempt), /EISDIR/);
    await rm(temporary, { recursive: true });
    const commandId = `${text(await fixture.progress(), "commandId")}:pick:0`;
    const runId = runIdentity(commandId);
    await fixture.service.worker.started({
      runId,
      commandId: "work-start",
      expectedRevision: 1,
    });
    await fixture.service.worker.completed({
      runId,
      commandId: "work-end",
      expectedRevision: 2,
    });
    const pending = await queueJournal(fixture.settings.directory);
    assert.ok(pending.commands.has(commandId));
    feed = await fixture.load();
    let admissions = 0;
    await feed.next({
      ...fixture.attempt,
      pending,
      available: async () => {
        admissions += 1;
        pending.commands.delete(commandId);
        await pending.save();
        return true;
      },
    });
    assert.equal(admissions, 0);
    assert.ok(
      pending.commands.has(commandId),
      "the ordinary queue cycle must retire this run once",
    );
  }));
