import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import type { Fields, Reply, ServiceRequest } from "../src/protocol.ts";
import { contractBody } from "./watch-api-contract.ts";
import { fields } from "./service-fixture.ts";
import { streamReader } from "./watch-api-fixture.ts";
import { watchReplies, withWatchService } from "./watch-service-fixture.ts";

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
  return { asked, answer };
}

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
