import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { requestLine } from "../src/protocol.ts";
import { socketAddress } from "../src/broker/socket-address.ts";
import { testMilliseconds } from "./test-timing.ts";
import { mergeRepository } from "./watch-merge-fixture.ts";
import { watchReader } from "../src/cli/watch-reads.ts";
import { fields, items } from "./service-fixture.ts";
import {
  attentionMark,
  completionReplies,
  laterMark,
  stoppedMark,
  terminalDetailReplies,
  withCompletionService,
} from "./watch-completion-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

await test(
  "CLV-091 the watch service fixture survives a client closing before its reply",
  { timeout: testMilliseconds(10000) },
  async () => {
    const answered = Promise.withResolvers<undefined>();
    const replies = watchReplies({ runs: [] });
    await withWatchService(
      (request) => {
        if (request.operation === "disconnected-probe")
          answered.resolve(undefined);
        return replies.answer(request);
      },
      async (_watch, runtime) => {
        const address = socketAddress(join(runtime, "control.sock"));
        assert.equal(address.kind, "address");
        const request = requestLine({
          operation: "disconnected-probe",
          parameters: {},
        });
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { connect } from "node:net";
const client = connect(${JSON.stringify(address.path)});
client.on("connect", () => client.write(${JSON.stringify(request)}, () => client.destroy()));`,
          ],
          { timeout: testMilliseconds(5000) },
        );
        await answered.promise;
        await setImmediate();
        assert.equal(replies.requests.at(-1)?.operation, "disconnected-probe");
      },
    );
  },
);

await test("CLV-091 older completion candidates are not read without a visible blocked issue card", async () => {
  const { runs } = completionReplies();
  const stopped = runs[0];
  const older = runs.at(-1);
  assert.ok(stopped && older);
  const recent = new Date().toISOString();
  const hidden = Array.from({ length: 20 }, (_, index) => ({
    ...stopped,
    runId: `failed-${String(index).padStart(2, "0")}`,
    state: "failed",
    latestAt: recent,
  }));
  for (const shown of [
    [],
    [{ ...stopped, outcome: { kind: "handoff_requested" } }],
    [{ ...stopped, issueIdentity: null }],
    [{ ...stopped, latestAt: "2020-01-01T00:00:00Z" }],
    [
      ...hidden,
      { ...stopped, latestAt: new Date(Date.now() - 1000).toISOString() },
    ],
  ]) {
    const { answer, requests } = watchReplies({ runs: [...shown, older] });
    await withCompletionService(answer, async (watch) => {
      await watchData(watch.address);
      assert.ok(
        !requests.some(
          (request) => request.parameters["runId"] === older["runId"],
        ),
      );
    });
  }
});

await test("CLV-091 older candidates retain compact creation facts and selected runs still read full histories", async () => {
  const { runs } = completionReplies();
  const events = Array.from({ length: 1001 }, (_, index) => ({
    sequence: index + 1,
    recordedAt: "2026-10-14T10:01:00Z",
    type: index === 0 ? "run.created" : "run.started",
    payload: { private: "unneeded event content" },
  }));
  const { answer, requests } = watchReplies({ runs, events });
  await withCompletionService(answer, async (_watch, runtimeDirectory) => {
    const reader = watchReader(runtimeDirectory, mergeRepository);
    const read = await reader.read(new Date().toISOString());
    const candidate = read.completionCandidates[0];
    assert.ok(candidate);
    assert.deepEqual(candidate.events, [
      {
        sequence: 1,
        recordedAt: "2026-10-14T10:01:00Z",
        type: "run.created",
      },
    ]);
    const olderReads = requests.filter(
      (request) =>
        request.operation === "events" &&
        request.parameters["runId"] === "zz-later",
    );
    assert.equal(olderReads.length, 1);
    assert.equal(olderReads[0]?.parameters["limit"], 1);
    const before = requests.filter(
      (request) => request.parameters["runId"] === "zz-later",
    );
    await reader.read(new Date().toISOString());
    assert.deepEqual(
      requests.filter((request) => request.parameters["runId"] === "zz-later"),
      before,
    );
    const selected = await reader.run("zz-later");
    assert.equal(selected.runs[0]?.events.length, 1001);
    assert.equal(
      selected.runs[0].events[1000]?.["payload"] !== undefined,
      true,
    );
  });
});

await test("CLV-091 older runs without a matching successful ticket need no event reads", async () => {
  const { runs } = completionReplies();
  const later = runs.at(-1);
  assert.ok(later);
  const unrelated = [
    { issueIdentity: { owner: "fixture", repository: "demo", number: 8 } },
    { outcome: { kind: "blocked" } },
    { issueIdentity: {} },
    { issueIdentity: null },
    { issueIdentity: { owner: "other", repository: "demo", number: 7 } },
  ].map((changed, index) => ({
    ...later,
    ...changed,
    runId: `zz-later-${String(index)}`,
  }));
  const { answer, requests } = watchReplies({ runs: [...runs, ...unrelated] });
  await withCompletionService(answer, async (_watch, runtimeDirectory) => {
    const reader = watchReader(runtimeDirectory, mergeRepository);
    await reader.read(new Date().toISOString());
    for (const run of unrelated)
      assert.ok(
        !requests.some(
          (request) =>
            request.operation === "events" &&
            request.parameters["runId"] === run.runId,
        ),
      );
  });
});

await test("CLV-091 a complete older search without creation evidence caches absence", async () => {
  const { runs } = completionReplies();
  const { answer, requests } = watchReplies({ runs });
  await withCompletionService(answer, async (_watch, runtimeDirectory) => {
    const reader = watchReader(runtimeDirectory, mergeRepository);
    const first = await reader.read(new Date().toISOString());
    assert.deepEqual(first.completionCandidates[0]?.events, []);
    const reads = requests.filter(
      (request) => request.parameters["runId"] === "zz-later",
    );
    await reader.read(new Date().toISOString());
    assert.deepEqual(
      requests.filter((request) => request.parameters["runId"] === "zz-later"),
      reads,
    );
  });
});

await test("CLV-091 terminal detail changes outside retention cannot hide visible search targets", async () => {
  const now = "2026-10-15T10:31:00Z";
  for (const latestAt of [
    "2026-10-15T10:32:00Z",
    "2020-01-01T00:00:00Z",
    "invalid",
  ]) {
    const { answer } = terminalDetailReplies({ now, latestAt });
    await withCompletionService(answer, async (_watch, runtimeDirectory) => {
      const read = await watchReader(runtimeDirectory, mergeRepository).read(
        now,
      );
      assert.equal(read.completionCandidates[0]?.status.runId, "zz-later");
    });
  }
});

await test("CLV-091 watch searches later status pages and paginated evidence outside Done limits and retention", async () => {
  const recent = new Date().toISOString();
  for (const latestAt of [
    recent,
    "2020-01-01T00:00:00Z",
    "2099-01-01T00:00:00Z",
    "invalid",
    null,
  ]) {
    const { answer, requests } = completionReplies(latestAt);
    await withCompletionService(answer, async (watch) => {
      const model = await watchData(watch.address);
      assert.deepEqual(stoppedMark(model), laterMark);
      const board = fields(items(model["workflows"])[0]);
      const done = items(board["columns"])
        .map(fields)
        .find((column) => column["name"] === "Done");
      assert.equal(items(done?.["cards"]).length, 20);
      assert.ok(
        !items(done?.["cards"]).some(
          (card) => fields(card)["runId"] === "zz-later",
        ),
      );
      assert.equal(
        items(model["runs"]).some((run) => fields(run)["runId"] === "zz-later"),
        latestAt === recent,
      );
      for (const runId of ["a-stopped", "zz-later"])
        assert.ok(
          requests.some(
            (request) =>
              request.operation === "events" &&
              request.parameters["runId"] === runId &&
              request.parameters["after"] ===
                (runId === "a-stopped" || latestAt === recent ? 1000 : 1),
          ),
        );
      assert.ok(
        requests.every((request) =>
          ["status", "events", "questions"].includes(request.operation),
        ),
      );
    });
  }
});

await test("CLV-091 each board read recomputes completion when only the later run changes", async () => {
  const { answer, requests, runs } = completionReplies();
  const index = runs.findIndex((run) => run["runId"] === "zz-later");
  const completed = runs[index];
  assert.ok(completed);
  runs[index] = {
    ...completed,
    state: "running",
    outcome: null,
    latestSequence: 1000,
  };
  await withCompletionService(answer, async (watch) => {
    assert.deepEqual(
      stoppedMark(await watchData(watch.address)),
      attentionMark,
    );
    const reads = requests.filter(
      (request) => request.parameters["runId"] === "a-stopped",
    ).length;
    runs[index] = completed;
    assert.deepEqual(stoppedMark(await watchData(watch.address)), laterMark);
    assert.equal(
      requests.filter((request) => request.parameters["runId"] === "a-stopped")
        .length,
      reads,
    );
  });
});

await test("CLV-077 watch reads both run pages and every active run, including the second page", async () => {
  const runs = Array.from({ length: 51 }, (_, index) => ({
    runId: `run-${String(index).padStart(3, "0")}`,
    workflowId: "develop-issue",
    state: "running",
    latestSequence: 1,
    latestAt: "2020-01-01T00:00:00Z",
  }));
  const { requests, answer } = watchReplies({ runs });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    assert.equal(items(model["runs"]).length, 51);
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "status" &&
          request.parameters["after"] === "run-049",
      ),
    );
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "events" &&
          request.parameters["runId"] === "run-050",
      ),
    );
  });
});

await test("CLV-077 watch excludes old ended runs from board reads but serves a requested older run", async () => {
  const runs = [
    {
      runId: "old",
      workflowId: "develop-ticket",
      state: "completed",
      latestAt: "2020-01-01T00:00:00Z",
      latestSequence: 1,
      title: "Older work",
      outcome: { kind: "handoff_requested" },
    },
    {
      runId: "recent",
      workflowId: "develop-issue",
      state: "completed",
      latestAt: new Date().toISOString(),
      latestSequence: 2,
    },
  ];
  const { requests, answer } = watchReplies({ runs });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    assert.equal(items(model["runs"]).length, 1);
    assert.ok(
      !requests.some((request) => request.parameters["runId"] === "old"),
    );
    const older = await fetch(`${watch.address}data.json?runId=old`);
    assert.equal(older.status, 200);
    const data: unknown = await older.json();
    const run = fields(fields(data)["run"]);
    assert.equal(run["runId"], "old");
    assert.equal(run["title"], "Older work");
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "events" &&
          request.parameters["runId"] === "old",
      ),
    );
  });
});

await test("CLV-077 watch follows event sequences beyond a thousand events to the newest round", async () => {
  const operationId = JSON.stringify([
    "cloving-operation",
    2,
    "long",
    "implement",
    "claude-turn",
  ]);
  const events = Array.from({ length: 1001 }, (_, index) => ({
    sequence: index * 2 + 1,
    recordedAt: `2026-10-14T${index === 1000 ? "11" : "10"}:00:00Z`,
    type: index === 1000 ? "effect.requested" : "run.started",
    payload: { operationId },
  }));
  const run = {
    runId: "long",
    workflowId: "develop-issue",
    state: "running",
    latestSequence: 2001,
  };
  const { requests, answer } = watchReplies({ runs: [run], events });
  await withWatchService(answer, async (watch) => {
    const model = await watchData(watch.address);
    const shown = fields(items(model["runs"])[0]);
    assert.equal(items(shown["events"]).length, 1001);
    assert.deepEqual(shown["currentStep"], {
      name: "Agent turn",
      startedAt: "2026-10-14T11:00:00Z",
    });
    assert.ok(
      requests.some(
        (request) =>
          request.operation === "events" &&
          request.parameters["after"] === 1999,
      ),
    );
  });
});
