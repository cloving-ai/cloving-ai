import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { RunStatus } from "../src/authority/transitions.ts";
import { socketAddress } from "../src/broker/socket-address.ts";
import { listRuns } from "../src/cli/client.ts";
import { runOverview } from "../src/cli/render.ts";
import {
  parseRequest,
  replyLine,
  type Fields,
  type Reply,
  type ServiceRequest,
} from "../src/protocol.ts";
import { withHarness, type Harness } from "./service-fixture.ts";
import { refusalRecords, refusalText } from "./workflow-refusal-fixture.ts";

function statusReply(request: ServiceRequest, runs: readonly Fields[]): Reply {
  if (request.operation === "questions")
    return { kind: "result", result: { kind: "decision-list", decisions: [] } };
  const after = request.parameters["after"];
  const cursor = typeof after === "string" ? after : "";
  const remaining = runs.filter((run) => String(run["runId"]) > cursor);
  const page = remaining.slice(
    0,
    Math.min(Number(request.parameters["limit"] ?? 50), 50),
  );
  return {
    kind: "result",
    result: {
      kind: "run-list",
      workflows: ["develop", "unused"],
      runs: page,
      next: remaining.length > page.length ? page.at(-1)?.["runId"] : null,
    },
  };
}

async function withRunList<Output>(
  listing: {
    readonly runs: readonly Fields[];
    readonly pages: readonly Reply[];
  },
  read: (harness: Harness) => Promise<Output>,
) {
  const { runs, pages } = listing;
  const requests: ServiceRequest[] = [];
  let page = 0;
  return withHarness(async (harness) => {
    const address = socketAddress(
      join(harness.runtimeDirectory, "control.sock"),
    );
    assert.equal(address.kind, "address");
    const server = createServer((socket) => {
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        if (!buffered.includes("\n")) return;
        const parsed = parseRequest(buffered.trim());
        assert.equal(parsed.kind, "request");
        const request = parsed.request;
        requests.push(request);
        const scripted =
          request.operation === "status" ? pages[page++] : undefined;
        socket.end(replyLine(scripted ?? statusReply(request, runs)));
      });
    });
    await new Promise<void>((ready) => server.listen(address.path, ready));
    try {
      return { output: await read(harness), requests };
    } finally {
      await new Promise<void>((closed) =>
        server.close(() => {
          closed();
        }),
      );
    }
  });
}

async function statusList(
  runs: readonly Fields[],
  options: {
    readonly argumentsList?: readonly string[];
    readonly pages?: readonly Reply[];
  } = {},
) {
  const { argumentsList = [], pages = [] } = options;
  const { output, requests } = await withRunList({ runs, pages }, (harness) =>
    harness.cli(["status", ...argumentsList]),
  );
  return { ...output, requests };
}

function endedRuns(count: number): Fields[] {
  return Array.from({ length: count }, (_, index) => ({
    runId: `run-${String(index).padStart(3, "0")}`,
    workflowId: "develop",
    state: ["completed", "failed", "cancelled"][index % 3],
    condition: "ended",
    revision: 2,
    latestAt: new Date(Date.UTC(2026, 9, 17, 0, index)).toISOString(),
  }));
}

const active = {
  runId: "run-999",
  workflowId: "develop",
  state: "running",
  condition: "working",
  revision: 2,
  latestAt: "2026-10-17T00:00:00.000Z",
};

await test("CLV-108 the run overview only selects object entries", () => {
  const ended = endedRuns(1);
  assert.deepEqual(
    runOverview({ runs: [null, [], false, 42, "invalid", ...ended, active] }),
    { runs: [active, ...ended], hiddenRuns: 0 },
  );
});

function runLine(run: Fields): string {
  const latestAt = run["latestAt"];
  return `  ${String(run["runId"])}  ${String(run["workflowId"])}  ${String(run["condition"])}  revision ${String(run["revision"])}  latest at ${typeof latestAt === "string" ? latestAt : "none"}\n`;
}

await test("CLV-108 default status finds an active run on the second page and lists it first", async () => {
  const ended = endedRuns(54);
  const output = await statusList([...ended, active]);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /^Runs:\n {2}run-999 {2}develop {2}working /m);
  assert.deepEqual(
    output.requests
      .filter((request) => request.operation === "status")
      .map((request) => request.parameters),
    [{ limit: 500 }, { limit: 500, after: "run-049" }],
  );
  assert.equal(
    output.stdout,
    "Pending decisions:\n  none\nWorkflows: develop, unused\nRuns:\n" +
      runLine(active) +
      ended.slice(-20).reverse().map(runLine).join("") +
      "34 older runs: use --limit and --after to see them\n",
  );
});

await test("CLV-108 fewer than 20 ended runs are all shown without a hidden-runs line", async () => {
  const ended = endedRuns(3);
  const output = await statusList(ended);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(
    output.stdout,
    "Pending decisions:\n  none\nWorkflows: develop, unused\nRuns:\n" +
      ended.reverse().map(runLine).join(""),
  );
});

await test("CLV-108 default status ignores non-object run entries on every page", async () => {
  const ended = endedRuns(1);
  const pages: readonly Reply[] = [
    {
      kind: "result",
      result: {
        kind: "run-list",
        workflows: ["develop", "unused"],
        runs: [null, active, "invalid"],
        next: "run-999",
      },
    },
    {
      kind: "result",
      result: { runs: [[], ...ended, 42, false], next: null },
    },
  ];
  const listed = await withRunList({ runs: [], pages }, (harness) =>
    listRuns(harness.runtimeDirectory),
  );
  assert.deepEqual(listed.output, {
    kind: "result",
    result: {
      kind: "run-list",
      workflows: ["develop", "unused"],
      runs: [active, ...ended],
      next: null,
    },
  });
  const output = await statusList([], { pages });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(
    output.stdout,
    "Pending decisions:\n  none\nWorkflows: develop, unused\nRuns:\n" +
      [active, ...ended].map(runLine).join(""),
  );
});

await test("CLV-108 JSON status preserves the first service page and its cursor", async () => {
  const runs = [...endedRuns(54), active];
  const output = await statusList(runs, { argumentsList: ["--json"] });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(
    output.stdout,
    JSON.stringify({
      kind: "run-list",
      workflows: ["develop", "unused"],
      runs: runs.slice(0, 50),
      next: "run-049",
    }) + "\n",
  );
  assert.deepEqual(output.requests, [{ operation: "status", parameters: {} }]);
});

for (const [options, parameters, first, last] of [
  [["--limit", "10"], { limit: 10 }, 0, 10],
  [["--after", "run-009"], { after: "run-009" }, 10, 55],
] as const)
  await test(`CLV-108 status ${options.join(" ")} preserves the service page order`, async () => {
    const runs = [...endedRuns(54), active];
    const output = await statusList(runs, { argumentsList: options });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(
      output.stdout,
      "Pending decisions:\n  none\nWorkflows: develop, unused\nRuns:\n" +
        runs.slice(first, last).map(runLine).join(""),
    );
    assert.deepEqual(output.requests, [
      { operation: "questions", parameters: {} },
      { operation: "status", parameters },
    ]);
  });

await test("CLV-108 all active states sort by latest event time before ended runs, with missing times last", async () => {
  const states = [
    "running",
    "paused",
    "waiting_gate",
    "queued",
  ] satisfies readonly RunStatus[];
  const current = Array.from({ length: 25 }, (_, index) => ({
    ...active,
    runId: `active-${String(index).padStart(3, "0")}`,
    state: states[index % states.length],
    latestAt: new Date(Date.UTC(2026, 9, 16, 0, index)).toISOString(),
  }));
  const missing = { ...active, runId: "missing", latestAt: null };
  const output = await statusList([...current, missing, ...endedRuns(21)]);
  assert.equal(output.status, 0, output.stderr);
  const shown = output.stdout.split("Runs:\n")[1];
  assert.equal(
    shown,
    [...current.reverse(), missing, ...endedRuns(21).slice(1).reverse()]
      .map(runLine)
      .join("") + "1 older runs: use --limit and --after to see them\n",
  );
});

await test("CLV-108 a failed later page reports failure without a partial run list", async () => {
  const failure: Reply = {
    kind: "error",
    error: { code: "read-failed", detail: "Read interrupted." },
  };
  for (const pages of [
    [failure],
    [{ kind: "result", result: { runs: [active], next: "run-999" } }, failure],
  ] satisfies readonly (readonly Reply[])[]) {
    const output = await statusList([], { pages });
    assert.equal(output.status, 1);
    assert.equal(output.stderr, "read-failed: Read interrupted.\n");
    assert.equal(output.stdout, "Pending decisions:\n  none\n");
  }
});

await test("CLV-108 a repeated run-list cursor fails without reading it again", async () => {
  const page: Reply = {
    kind: "result",
    result: { runs: [active], next: "run-999" },
  };
  const output = await statusList([], {
    pages: [
      page,
      page,
      {
        kind: "error",
        error: { code: "unexpected-read", detail: "Repeated." },
      },
    ],
  });
  assert.equal(output.status, 1);
  assert.equal(
    output.stderr,
    "invalid-run-page: The run-list cursor did not advance.\n",
  );
  assert.equal(output.requests.length, 3);
  assert.equal(output.stdout, "Pending decisions:\n  none\n");
});

await test("CLV-124 default status preserves refusal metadata across run pages", async () => {
  const pages: readonly Reply[] = [
    {
      kind: "result",
      result: {
        kind: "run-list",
        workflows: ["develop"],
        workflowRefusals: refusalRecords,
        runs: [active],
        next: "run-999",
      },
    },
    {
      kind: "result",
      result: { runs: [], workflowRefusals: refusalRecords, next: null },
    },
  ];
  const output = await statusList([], { pages });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(
    output.stdout,
    "Pending decisions:\n  none\nWorkflows: develop\n" +
      refusalText +
      "Runs:\n" +
      runLine(active),
  );
  assert.equal(output.requests.length, 3);
});
