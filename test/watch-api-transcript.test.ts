import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { contractBody } from "./watch-api-contract.ts";
import { workspaceWatchServer } from "../src/cli/watch-server.ts";
import { fields, withHarness } from "./service-fixture.ts";
import { streamReader } from "./watch-api-fixture.ts";
import {
  fakeService,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

const operationId = JSON.stringify([
  "cloving-operation",
  1,
  "run-a",
  "implement",
  "claude-turn",
  null,
  null,
]);
const turnPath = `api/v1/runs/run-a/turns/${encodeURIComponent(operationId)}`;
const pagePath = "/runs/{runId}/turns/{operationId}/transcript";
const streamPath = "/runs/{runId}/turns/{operationId}/transcript-stream";

function entryAt(position: number): Fields {
  return {
    position,
    attempt: 1,
    kind: "assistant",
    text: `Entry ${String(position)}`,
    tool: null,
    callId: null,
    summary: "",
    error: false,
    omittedBytes: 0,
  };
}

interface Turn {
  entries: Fields[];
  open: boolean;
  refusal?: { readonly code: string; readonly detail: string };
}

function transcriptService(turn: Turn) {
  const replies = watchReplies({
    runs: [{ runId: "run-a", workflowId: "develop", state: "running" }],
  });
  const asked: Fields[] = [];
  const answer = (request: ServiceRequest): Reply => {
    if (request.operation !== "transcript") return replies.answer(request);
    asked.push(request.parameters);
    if (turn.refusal !== undefined)
      return { kind: "error", error: turn.refusal };
    const after = Number(request.parameters["after"]);
    const entries = turn.entries
      .filter((entry) => Number(entry["position"]) > after)
      .slice(0, 2);
    return {
      kind: "result",
      result: {
        schemaVersion: 1,
        kind: "transcript",
        runId: "run-a",
        operationId,
        entries,
        nextAfter: Number(entries.at(-1)?.["position"] ?? after),
        open: turn.open,
      },
    };
  };
  return { asked, answer, turn };
}

await test("CLV-333 the transcript route gives the prompt kind and the call ID of tool calls and tool results", async () => {
  const entries = [
    { ...entryAt(1), kind: "prompt", text: "Fix CLV-333." },
    {
      ...entryAt(2),
      kind: "tool-call",
      tool: "Bash",
      callId: "toolu_1",
      summary: "Bash: npm test",
    },
  ];
  const service = transcriptService({ entries, open: false });
  await withWatchService(service.answer, async (watch) => {
    const response = await fetch(`${watch.address}${turnPath}/transcript`);
    assert.deepEqual(
      await contractBody(watchApiDocument, { response, path: pagePath }),
      { entries, nextAfter: 2, open: false },
    );
  });
});

function positions(messages: readonly string[]): string[] {
  return messages.map((message) => message.split("\n")[0] ?? "");
}

await test("CLV-329 the transcript route gives a page of entries after a position with nextAfter and open", async () => {
  const turn: Turn = { entries: [1, 2, 3].map(entryAt), open: true };
  const service = transcriptService(turn);
  await withWatchService(service.answer, async (watch) => {
    const response = await fetch(
      `${watch.address}${turnPath}/transcript?after=1`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      await contractBody(watchApiDocument, { response, path: pagePath }),
      { entries: [entryAt(2), entryAt(3)], nextAfter: 3, open: true },
    );
    assert.deepEqual(service.asked, [
      { runId: "run-a", operationId, after: 1 },
    ]);
  });
});

await test("CLV-329 the transcript routes refuse an invalid position, an unknown turn, a transcript that is not kept and a service without transcripts", async () => {
  const turn: Turn = { entries: [], open: false };
  const service = transcriptService(turn);
  await withWatchService(service.answer, async (watch) => {
    const invalid = await fetch(
      `${watch.address}${turnPath}/transcript?after=x`,
    );
    assert.equal(invalid.status, 400);
    await invalid.body?.cancel();
    const header = await fetch(
      `${watch.address}${turnPath}/transcript-stream`,
      {
        headers: { "last-event-id": "two" },
      },
    );
    assert.equal(header.status, 400);
    const refused = await contractBody(watchApiDocument, {
      response: header,
      path: streamPath,
    });
    assert.equal(fields(refused)["code"], "invalid-last-event-id");
    const refusals = [
      ["unknown-turn", 404, "not-found"],
      ["transcript-not-kept", 410, "transcript-not-kept"],
      ["transcript-unavailable", 503, "transcript-unavailable"],
      ["unknown-operation", 503, "transcript-unavailable"],
      ["service-unavailable", 503, "service-unavailable"],
    ] as const;
    for (const [code, status, shown] of refusals) {
      turn.refusal = { code, detail: code };
      for (const [route, path] of [
        ["transcript", pagePath],
        ["transcript-stream", streamPath],
      ] as const) {
        const response = await fetch(`${watch.address}${turnPath}/${route}`);
        assert.equal(response.status, status, `${code} ${route}`);
        const body = await contractBody(watchApiDocument, { response, path });
        assert.equal(fields(body)["code"], shown, code);
      }
    }
  });
});

await test("CLV-329 the stream route sends each entry with its position as the event ID, resumes after Last-Event-ID with no lost or doubled entry, and sends end when the turn ends", async () => {
  const turn: Turn = { entries: [1, 2, 3].map(entryAt), open: true };
  const service = transcriptService(turn);
  await withWatchService(service.answer, async (watch) => {
    const first = streamReader(watchApiDocument, {
      response: await fetch(`${watch.address}${turnPath}/transcript-stream`),
      path: streamPath,
    });
    const opened = [await first.next(), await first.next(), await first.next()];
    assert.deepEqual(positions(opened), ["id: 1", "id: 2", "id: 3"]);
    assert.equal(
      opened[0],
      `id: 1\nevent: entry\ndata: ${JSON.stringify(entryAt(1))}\n\n`,
    );
    turn.entries.push(entryAt(4));
    assert.deepEqual(positions([await first.next()]), ["id: 4"]);
    await first.cancel();
    turn.entries.push(entryAt(5), entryAt(6));
    const resumed = streamReader(watchApiDocument, {
      response: await fetch(`${watch.address}${turnPath}/transcript-stream`, {
        headers: { "last-event-id": "4" },
      }),
      path: streamPath,
    });
    assert.deepEqual(positions([await resumed.next(), await resumed.next()]), [
      "id: 5",
      "id: 6",
    ]);
    turn.entries.push(entryAt(7));
    turn.open = false;
    assert.deepEqual(positions([await resumed.next()]), ["id: 7"]);
    assert.equal(await resumed.next(), 'event: end\ndata: {"nextAfter":7}\n\n');
    assert.equal(await resumed.next(), "");
  });
});

await test("CLV-329 the stream route starts after the query parameter after", async () => {
  const turn: Turn = { entries: [1, 2, 3].map(entryAt), open: false };
  const service = transcriptService(turn);
  await withWatchService(service.answer, async (watch) => {
    const stream = streamReader(watchApiDocument, {
      response: await fetch(
        `${watch.address}${turnPath}/transcript-stream?after=2`,
      ),
      path: streamPath,
    });
    assert.deepEqual(positions([await stream.next(), await stream.next()]), [
      "id: 3",
      "event: end",
    ]);
  });
});

const odd = {
  position: "1",
  kind: "other",
  text: 4,
  tool: "Bash",
  omittedBytes: 1.5,
};

function oddService(): (request: ServiceRequest) => Reply {
  const service = transcriptService({ entries: [], open: true });
  const pages = new Map<number, Fields>([
    [0, { entries: [odd, null], nextAfter: 0, open: false }],
    [1, { entries: [], nextAfter: "1", open: true }],
    [2, { entries: {}, open: true }],
  ]);
  return (request) => {
    const page = pages.get(Number(request.parameters["after"]));
    return request.operation === "transcript" && page !== undefined
      ? { kind: "result", result: page }
      : service.answer(request);
  };
}

await test("CLV-329 the transcript route gives the documented entry fields of an odd service entry and 503 for a page without its fields", async () => {
  const answer = oddService();
  await withWatchService(answer, async (watch) => {
    const response = await fetch(`${watch.address}${turnPath}/transcript`);
    assert.deepEqual(
      await contractBody(watchApiDocument, { response, path: pagePath }),
      {
        entries: [
          { ...entryAt(0), attempt: 0, kind: "notice", text: "", tool: "Bash" },
          { ...entryAt(0), attempt: 0, kind: "notice", text: "" },
        ],
        nextAfter: 0,
        open: false,
      },
    );
    for (const after of [1, 2]) {
      const refused = await fetch(
        `${watch.address}${turnPath}/transcript?after=${String(after)}`,
      );
      assert.equal(refused.status, 503, String(after));
      assert.equal(fields(await refused.json())["code"], "service-unavailable");
    }
  });
});

await test("CLV-329 the stream route waits while the service read fails and goes on after the position of its last entry", async () => {
  const turn: Turn = { entries: [entryAt(1)], open: true };
  const service = transcriptService(turn);
  await withWatchService(service.answer, async (watch) => {
    const stream = streamReader(watchApiDocument, {
      response: await fetch(`${watch.address}${turnPath}/transcript-stream`),
      path: streamPath,
    });
    assert.deepEqual(positions([await stream.next()]), ["id: 1"]);
    turn.refusal = { code: "service-unavailable", detail: "down" };
    turn.entries.push(entryAt(2));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    delete turn.refusal;
    turn.open = false;
    assert.deepEqual(positions([await stream.next(), await stream.next()]), [
      "id: 2",
      "event: end",
    ]);
    assert.ok(
      service.asked.filter((asked) => asked["after"] === 1).length >= 2,
    );
  });
});

await test("CLV-329 the stream route sends refused with the problem and closes when the service refuses the turn after the stream opens", async () => {
  const turn: Turn = { entries: [entryAt(1)], open: true };
  const service = transcriptService(turn);
  await withWatchService(service.answer, async (watch) => {
    const stream = streamReader(watchApiDocument, {
      response: await fetch(`${watch.address}${turnPath}/transcript-stream`),
      path: streamPath,
    });
    assert.deepEqual(positions([await stream.next()]), ["id: 1"]);
    turn.refusal = { code: "transcript-not-kept", detail: "gone" };
    const refused = await stream.next();
    assert.match(refused, /^event: refused\ndata: /);
    assert.deepEqual(fields(JSON.parse(refused.split("data: ")[1] ?? "")), {
      type: "about:blank",
      title: "Gone",
      status: 410,
      detail: "The transcript of this turn is not kept.",
      code: "transcript-not-kept",
    });
    assert.equal(await stream.next(), "");
  });
});

async function workspaceServed(
  members: readonly {
    readonly name: string;
    readonly runtimeDirectory: string;
  }[],
) {
  const ready = Promise.withResolvers<string>();
  const stopped = Promise.withResolvers<undefined>();
  const finished = workspaceWatchServer({
    repositories: members.map((member) => ({ ...member, client: "cloving" })),
    port: 0,
    announce: (text) => {
      ready.resolve(/(http:\/\/127\.0\.0\.1:\d+\/)/.exec(text)?.[1] ?? "");
    },
    complain: () => undefined,
    stopped: stopped.promise,
  });
  return {
    address: await ready.promise,
    stop: () => {
      stopped.resolve(undefined);
      return finished;
    },
  };
}

await test("CLV-329 a workspace watch page reads the transcript from the repository whose service knows the turn", () =>
  withHarness(async (alpha) =>
    withHarness(async (beta) => {
      const other = transcriptService({
        entries: [],
        open: true,
        refusal: { code: "unknown-turn", detail: "No such turn." },
      });
      const owner = transcriptService({ entries: [entryAt(1)], open: true });
      const closes = [
        await fakeService(alpha.runtimeDirectory, other.answer),
        await fakeService(beta.runtimeDirectory, owner.answer),
      ];
      const watch = await workspaceServed([
        { name: "alpha", runtimeDirectory: alpha.runtimeDirectory },
        { name: "beta", runtimeDirectory: beta.runtimeDirectory },
      ]);
      try {
        const found = await fetch(`${watch.address}${turnPath}/transcript`);
        assert.equal(found.status, 200);
        assert.deepEqual(fields(await found.json())["entries"], [entryAt(1)]);
        other.turn.refusal = { code: "service-unavailable", detail: "Down." };
        const past = await fetch(`${watch.address}${turnPath}/transcript`);
        assert.equal(past.status, 200);
        await past.body?.cancel();
        other.turn.refusal = { code: "unknown-turn", detail: "No such turn." };
        owner.turn.refusal = { code: "unknown-turn", detail: "No such turn." };
        const unknown = await fetch(`${watch.address}${turnPath}/transcript`);
        assert.equal(unknown.status, 404);
        await unknown.body?.cancel();
      } finally {
        assert.equal(await watch.stop(), 0);
        for (const close of closes) await close();
      }
    }),
  ));
