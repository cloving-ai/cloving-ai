import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { openRuns, waitingRuns } from "../src/daemon/working-runs.ts";
import { listen, type Handle } from "../src/service/transport.ts";
import { withHarness } from "./service-fixture.ts";

async function recorded(
  folder: string,
  entry: {
    readonly key: string;
    readonly started: Fields;
    readonly ended?: boolean;
  },
): Promise<void> {
  const place = join(folder, entry.key);
  await mkdir(place, { recursive: true });
  await writeFile(join(place, "started.json"), JSON.stringify(entry.started));
  if (entry.ended === true)
    await writeFile(join(place, "result.json"), JSON.stringify({}));
}

const operation = (runId: string): string =>
  `["cloving-operation",0,"${runId}","develop","turn",null,null]`;

function pagedService(
  pages: readonly (readonly Fields[])[],
  busyRunIds: readonly string[],
): Handle {
  return (request) => {
    const after = String(request.parameters["after"]);
    const index = after === "" ? 0 : Number(after);
    const next = index + 1 < pages.length ? String(index + 1) : null;
    return Promise.resolve({
      kind: "result",
      result: {
        queue: { busy: busyRunIds.length, busyRunIds },
        runs: pages[index] ?? [],
        next,
      },
    });
  };
}

const run = (runId: string, fields: Fields = {}): Fields => ({
  runId,
  workflowId: "develop",
  state: "running",
  ...fields,
});

async function journals(directory: string): Promise<void> {
  await recorded(join(directory, "journal"), {
    key: "turn",
    started: { operationId: operation("turn") },
  });
  await recorded(join(directory, "journal"), {
    key: "unknown",
    started: { operationId: "not an operation" },
  });
  await recorded(join(directory, "journal"), {
    key: "missing",
    started: {},
  });
  await recorded(join(directory, "commands"), {
    key: "command",
    started: { runId: "command" },
  });
  await recorded(join(directory, "github"), {
    key: "command-ci",
    started: { runId: "command" },
  });
  await recorded(join(directory, "github"), {
    key: "ci",
    started: { runId: "ci" },
  });
  await recorded(join(directory, "github"), {
    key: "ended-ci",
    started: { runId: "ended-ci" },
    ended: true,
  });
  await mkdir(join(directory, "github", "empty"), { recursive: true });
}

await test("CLV-309 a busy queue run waits for CI, a person or a run only when no turn or command runs", () =>
  withHarness(async (harness) => {
    const directory = harness.stateDirectory;
    const pages = [
      [
        run("turn", { pendingDecisions: ["question"] }),
        run("command"),
        run("ci"),
        run("person", { state: "waiting_gate" }),
        run("decision", { pendingDecisions: ["question"] }),
      ],
      [
        run("child", { awaitedRunId: "other" }),
        run("plain"),
        run("ended-ci"),
        run("earlier-queue", {
          workflowId: "develop-issue",
          state: "waiting_gate",
        }),
        run("other-workflow", { workflowId: "other", state: "waiting_gate" }),
      ],
    ];
    const busy = pages
      .flat()
      .map((entry) => String(entry["runId"]))
      .filter((runId) => runId !== "other-workflow");
    await journals(directory);
    const listener = await listen({
      path: join(harness.runtimeDirectory, "control.sock"),
      handle: pagedService(pages, busy),
      limits: { idleMilliseconds: 5000 },
    });
    try {
      const waiting = await waitingRuns({
        directory,
        runtimeDirectory: harness.runtimeDirectory,
      });
      assert.equal(waiting, 5);
    } finally {
      await listener.close();
    }
  }));

await test("CLV-309 the waiting count refuses a run list that is not valid", () =>
  withHarness(async (harness) => {
    const queue = { busy: 0, busyRunIds: [] };
    for (const [result, code] of [
      [{ queue, runs: "none", next: null }, "invalid-run-list"],
      [{ queue, runs: [], next: "" }, "invalid-run-page"],
      [{ runs: [], next: null }, "invalid-queue-status"],
      [
        { queue: { busyRunIds: [7] }, runs: [], next: null },
        "invalid-queue-status",
      ],
    ] as const) {
      const listener = await listen({
        path: join(harness.runtimeDirectory, "control.sock"),
        handle: () => Promise.resolve({ kind: "result", result }),
        limits: { idleMilliseconds: 5000 },
      });
      try {
        await assert.rejects(
          waitingRuns({
            directory: harness.stateDirectory,
            runtimeDirectory: harness.runtimeDirectory,
          }),
          { message: code },
        );
      } finally {
        await listener.close();
      }
    }
  }));

await test("CLV-309 the open run scan reads a finished operation only once", () =>
  withHarness(async (harness) => {
    const journal = join(harness.stateDirectory, "journal");
    await recorded(journal, {
      key: "done",
      started: { runId: "done" },
      ended: true,
    });
    await recorded(journal, { key: "open", started: { runId: "open" } });
    assert.deepEqual([...(await openRuns(journal))], ["open"]);
    await rm(join(journal, "done", "result.json"));
    await writeFile(join(journal, "done", "started.json"), "not JSON");
    await writeFile(join(journal, "open", "result.json"), "{}");
    await recorded(journal, { key: "late", started: { runId: "late" } });
    assert.deepEqual([...(await openRuns(journal))], ["late"]);
  }));
