import assert from "node:assert/strict";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Handle } from "../src/service/transport.ts";
import { eventually } from "./service-fixture.ts";
import {
  blockedRun,
  notifyReply,
  withNotifier,
} from "./notify-check-fixture.ts";

function pagedRuns(pages: unknown[]): Handle {
  return (request) => {
    if (request.operation === "questions")
      return notifyReply({ decisions: [] });
    if (request.parameters["runId"] !== undefined)
      return notifyReply({ run: blockedRun });
    const after = request.parameters["after"];
    pages.push(after);
    return notifyReply(
      after === ""
        ? { runs: [], next: "page-two" }
        : { runs: [blockedRun], next: null },
    );
  };
}

function failingScans(counts: { reads: number }): Handle {
  const invalid = [
    { kind: "error", error: { code: "unavailable", detail: "unavailable" } },
    notifyReply({ runs: null }),
    notifyReply({ runs: [null] }),
    notifyReply({ runs: [], next: "" }),
    notifyReply({ runs: [], next: 7 }),
  ] as const;
  return (request) => {
    if (request.operation === "questions")
      return notifyReply({ decisions: [] });
    if (request.parameters["runId"] !== undefined)
      return notifyReply({ run: blockedRun });
    return Promise.resolve(
      invalid[counts.reads++] ??
        notifyReply({ runs: [blockedRun], next: null }),
    );
  };
}

function changingRuns(state: { ready: boolean }): Handle {
  return (request) => {
    if (request.operation === "questions")
      return notifyReply({ decisions: [] });
    if (request.parameters["runId"] !== undefined)
      return notifyReply({ run: blockedRun });
    return notifyReply({ runs: state.ready ? [blockedRun] : [], next: null });
  };
}

await test("CLV-090 the notifier reads every page and records the event before running the command without added arguments", async () => {
  const pages: unknown[] = [];
  await withNotifier(
    {
      handle: pagedRuns(pages),
    },
    async (scene) => {
      const notices = await eventually(async () => {
        const found = await scene.notices();
        return found.length === 1 ? found : undefined;
      });
      await scene.stop();
      assert.equal(notices[0]?.["event"], "blocked");
      assert.ok(pages.includes("page-two"));
    },
  );
});

await test("CLV-090 a check in progress skips timer ticks and shutdown waits for the check", async () => {
  const release = Promise.withResolvers<undefined>();
  let reads = 0;
  await withNotifier(
    {
      handle: async () => {
        reads += 1;
        await release.promise;
        return notifyReply({ runs: [], next: null });
      },
    },
    async (scene) => {
      try {
        await eventually(() => (reads === 1 ? true : undefined));
        await delay(40);
        assert.equal(reads, 1);
        const stopping = scene.stop();
        release.resolve(undefined);
        await stopping;
        assert.deepEqual(await scene.notices(), []);
      } finally {
        release.resolve(undefined);
      }
    },
  );
});

await test("CLV-090 failed scans cannot consume event keys and a later check recovers", async () => {
  const counts = { reads: 0 };
  await withNotifier(
    {
      handle: failingScans(counts),
    },
    async (scene) => {
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
      await scene.stop();
      assert.ok(counts.reads > 5);
      assert.deepEqual(
        JSON.parse(
          await readFile(join(scene.directory, "notify-events.json"), "utf8"),
        ),
        ["blocked:run-blocked"],
      );
    },
  );
});

await test("CLV-090 a failed record write sends nothing and retries after the record becomes writable", async () => {
  const state = { ready: false };
  await withNotifier(
    {
      handle: changingRuns(state),
    },
    async (scene) => {
      const temporary = join(scene.directory, "notify-events.json.tmp");
      await mkdir(temporary);
      state.ready = true;
      await delay(75);
      assert.deepEqual(await scene.notices(), []);
      await rm(temporary, { recursive: true });
      await eventually(async () =>
        (await scene.notices()).length === 1 ? true : undefined,
      );
    },
  );
});
