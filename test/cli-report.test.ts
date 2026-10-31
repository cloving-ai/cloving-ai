import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items, parsed } from "./service-fixture.ts";
import {
  snapshotReportReply,
  endedEvent,
  reportReply,
  withReportSource,
} from "./report-fixture.ts";

await test("CLV-199 report JSON counts two completed runs and one blocked run through the control socket", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const events = [
    endedEvent("first", { outcome: "completed", at: at, sequence: 1 }),
    endedEvent("second", { outcome: "handoff_requested", at: at, sequence: 2 }),
    endedEvent("third", { outcome: "blocked", at: at, sequence: 3 }),
  ];
  await withReportSource(reportReply(events), async (harness, requests) => {
    const output = await harness.cli(["report", "--since", "24", "--json"]);
    assert.equal(output.status, 0, output.stdout + output.stderr);
    const report = parsed(output);
    assert.equal(report["kind"], "loop-report");
    const metrics = fields(report["metrics"]);
    assert.equal(fields(metrics["runs.completed"])["value"], 2);
    assert.equal(fields(metrics["runs.blocked"])["value"], 1);
    assert.deepEqual(
      items(fields(metrics["runs.completed"])["evidence"]).map(
        (item) => fields(item)["runId"],
      ),
      ["first", "second"],
    );
    assert.ok(
      requests.every((request) =>
        ["events", "status"].includes(request.operation),
      ),
    );
  });
});

await test("CLV-199 report validates hours before contacting the daemon and documents help", async () => {
  await withReportSource(reportReply([]), async (harness, requests) => {
    for (const value of ["0", "169", "1.5", "no", "-1"]) {
      const output = await harness.cli([
        "report",
        `--since=${value}`,
        "--json",
      ]);
      assert.equal(output.status, 2, output.stdout + output.stderr);
    }
    const help = await harness.cli(["report", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--since <hours>/);
    assert.equal(requests.length, 0);
  });
});

await test("CLV-199 text report includes facts, history and unavailable sources", async () => {
  await withReportSource(reportReply([]), async (harness) => {
    const output = await harness.cli(["report"]);
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stdout, /runs.completed: 0/);
    assert.match(output.stdout, /history: short/);
    assert.match(output.stdout, /tickets.completed: unavailable/);
  });
});

import { configuredReportCli } from "./report-fixture.ts";

await test("CLV-199 report uses the configured gh executable and exposes real turn prices", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await withReportSource(
    reportReply(
      [endedEvent("priced", { outcome: "completed", at: at, sequence: 1 })],
      [
        {
          runId: "priced",
          condition: "completed",
          effects: [],
          workerTurns: [{ operationId: "turn", costUsd: 1.25 }],
        },
      ],
    ),
    async (harness) => {
      const output = await configuredReportCli(harness, ["--json"]);
      const report: unknown = JSON.parse(output.stdout);
      const metrics = fields(fields(report)["metrics"]);
      assert.equal(fields(metrics["tickets.completed"])["value"], 1);
      assert.equal(fields(metrics["pullRequests.merged"])["value"], 1);
      assert.equal(fields(metrics["cost.medianRunUsd"])["value"], 1.25);
      assert.deepEqual(
        items(fields(metrics["pullRequests.merged"])["evidence"]),
        [{ pullRequest: 8 }],
      );
    },
  );
});

await test("CLV-199 unreadable or malformed daemon pages are unavailable, never successful zero counts", async () => {
  for (const reply of [
    { kind: "error", error: { code: "event-gap", detail: "History missing" } },
    { kind: "result", result: { latestSequence: 1, events: null } },
    {
      kind: "result",
      result: {
        latestSequence: 1,
        events: [{ sequence: 0, recordedAt: "invalid" }],
      },
    },
  ] as const) {
    await withReportSource(
      () => reply,
      async (harness) => {
        const result = await harness.cli(["report", "--json"]);
        assert.equal(result.status, 0, result.stderr);
        const metric = fields(
          fields(parsed(result)["metrics"])["runs.completed"],
        );
        assert.equal(metric["status"], "unavailable");
        assert.equal(metric["value"], null);
      },
    );
  }
});

import { reportCommand } from "../src/cli/report.ts";

await test("CLV-199 ordinary completed runs count without an optional outcome and never use an unrelated cwd for GitHub", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const event = {
    ...endedEvent("ordinary", { outcome: "completed", at: at, sequence: 1 }),
    payload: {},
  };
  await withReportSource(reportReply([event]), async (harness) => {
    const output: string[] = [];
    let githubReads = 0;
    await reportCommand(
      { since: 24, json: true },
      {
        runtimeDirectory: harness.runtimeDirectory,
        workingDirectory: harness.projectDirectory,
        watchPr: {
          repository: undefined,
          githubCommand: undefined,
          execute: () => {
            githubReads += 1;
            return Promise.resolve({
              status: 0,
              stdout: "git@github.example:other/repo.git",
              stderr: "",
              errorCode: null,
            });
          },
        },
        terminal: { out: (text) => output.push(text) },
      },
    );
    const report: unknown = JSON.parse(output.join(""));
    assert.equal(
      fields(fields(fields(report)["metrics"])["runs.completed"])["value"],
      1,
    );
    assert.equal(githubReads, 0);
  });
});

await test("CLV-199 report pages a fixed daemon snapshot and excludes events appended during reading", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await withReportSource(snapshotReportReply(at), async (harness, requests) => {
    const result = await harness.cli(["report", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const metric = fields(fields(parsed(result)["metrics"])["runs.completed"]);
    assert.equal(metric["value"], 1);
    assert.deepEqual(
      requests
        .filter((request) => request.operation === "events")
        .map((request) => request.parameters["after"]),
      [0, 1000],
    );
  });
});

await test("CLV-199 duplicate terminal records cannot double count a run", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await withReportSource(
    reportReply([
      endedEvent("same", { outcome: "completed", at: at, sequence: 1 }),
      endedEvent("same", { outcome: "blocked", at: at, sequence: 2 }),
    ]),
    async (harness) => {
      const result = await harness.cli(["report", "--json"]);
      assert.equal(
        fields(fields(parsed(result)["metrics"])["runs.completed"])["status"],
        "unavailable",
      );
    },
  );
});

await test("CLV-199 cancelling or unresolved effects leave total spending unavailable", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  for (const run of [
    {
      runId: "draining",
      condition: "cancelling",
      effects: [],
      workerTurns: [],
    },
    {
      runId: "draining",
      condition: "completed",
      effects: [{ operationId: "pending", state: "running" }],
      workerTurns: [],
    },
  ]) {
    const event = {
      ...endedEvent("draining", { outcome: "completed", at: at, sequence: 1 }),
      type: "run.cancelled",
    };
    await withReportSource(reportReply([event], [run]), async (harness) => {
      const result = await harness.cli(["report", "--json"]);
      assert.equal(
        fields(items(parsed(result)["runCosts"])[0])["costUsd"],
        null,
      );
    });
  }
});

await test("CLV-199 actual zero is distinguished from unknown or malformed settled turn prices", async () => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const runs = [
    { runId: "zero", condition: "completed", effects: [], workerTurns: [] },
    {
      runId: "unknown",
      condition: "completed",
      effects: [],
      workerTurns: [{ operationId: "unpriced", costUsd: null }],
    },
    {
      runId: "malformed",
      condition: "completed",
      effects: [],
      workerTurns: [{ operationId: "invalid", costUsd: -1 }],
    },
  ];
  const events = runs.map((run, index) =>
    endedEvent(run.runId, { outcome: "completed", at, sequence: index + 1 }),
  );
  await withReportSource(reportReply(events, runs), async (harness) => {
    const result = await harness.cli(["report", "--json"]);
    assert.deepEqual(
      items(parsed(result)["runCosts"]).map((cost) => fields(cost)["costUsd"]),
      [0, null, null],
    );
  });
});

import { fixRoundEvents } from "./report-fixture.ts";

await test("CLV-243 report counts fix rounds only for merged pull requests", async () => {
  await withReportSource(
    reportReply(fixRoundEvents(Date.now() - 3_600_000)),
    async (harness) => {
      const output = await harness.cli(["report", "--since", "24", "--json"]);
      assert.equal(output.status, 0, output.stderr);
      const report = parsed(output);
      assert.equal(
        Object.hasOwn(fields(report["coverage"]), "fixRounds"),
        false,
      );
      const metric = fields(
        fields(report["metrics"])["fixRounds.medianPerMergedPullRequest"],
      );
      assert.equal(metric["value"], 1);
      assert.deepEqual(
        items(metric["evidence"]).map((item) => {
          const value = fields(item);
          return [value["runId"], value["pullRequest"], value["fixRounds"]];
        }),
        [
          ["fix-0", 10, 0],
          ["fix-1", 11, 2],
          ["fix-2", 12, 1],
        ],
      );
      assert.equal(fields(metric["baseline"])["history"], "short");
      assert.equal(metric["mark"], undefined);
    },
  );
});

await test("CLV-244 report measures two queue lanes and clips runs to the window", async () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const events = [
    ["run.started", "lane-a", -30],
    ["run.started", "lane-b", -24],
    ["run.completed", "lane-b", -11],
    ["run.completed", "lane-a", -4],
  ].map(([type, runId, hours], index) => ({
    type,
    runId,
    sequence: index + 1,
    payload: {},
    recordedAt: new Date(now + Number(hours) * 3_600_000).toISOString(),
  }));
  const reply = reportReply(events, [
    { runId: "lane-a", workflowId: "queue-work" },
    { runId: "lane-b", workflowId: "queue-work" },
  ]);
  await withReportSource(
    (request) =>
      request.operation === "status" &&
      request.parameters["metadata"] === undefined &&
      request.parameters["runId"] === undefined
        ? {
            kind: "result",
            result: { queue: { workflowId: "queue-work", lanes: 2 } },
          }
        : reply(request),
    async (harness) => {
      const output: string[] = [];
      await reportCommand(
        { since: 24, json: true },
        {
          now,
          runtimeDirectory: harness.runtimeDirectory,
          workingDirectory: harness.projectDirectory,
          terminal: { out: (text) => output.push(text) },
        },
      );
      const report = fields(JSON.parse(output.join("")));
      assert.equal(fields(report["coverage"])["flow"], undefined);
      const metric = fields(fields(report["metrics"])["flow.busyLaneShare"]);
      assert.equal(metric["value"], 0.6875);
      assert.deepEqual(
        items(metric["evidence"]).flatMap((item) => fields(item)["runIds"]),
        ["lane-a", "lane-b"],
      );
      assert.match(String(fields(report["semantics"])["flowLanes"]), /current/);
    },
  );
});
