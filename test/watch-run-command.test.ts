import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { fields } from "./service-fixture.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const pause = {
  runId: "run-a",
  expectedRevision: 4,
  commandId: "page-pause-1",
};

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "run-command")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    if (request.parameters["expectedRevision"] === 3)
      return {
        kind: "error",
        error: {
          commandId: request.parameters["commandId"],
          runId: "run-a",
          currentRevision: 4,
          code: "stale-revision",
          detail: "stale-revision",
        },
      };
    return {
      kind: "result",
      result: {
        kind: "run-command",
        command: request.parameters["command"],
        commandId: request.parameters["commandId"],
      },
    };
  };
}

await test("CLV-335 a POST to actions/pause, actions/resume and actions/drop with the page token sends one run-command request with the command, the run ID, the revision and the command ID, and gives the reply of the service", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const headers = actionHeaders(watch, await pageToken(watch));
    for (const command of ["pause", "resume", "drop"]) {
      const commandId = `page-${command}-1`;
      const reply = await postCard(watch, {
        path: `actions/${command}`,
        headers,
        body: JSON.stringify({ ...pause, commandId }),
      });
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), {
        kind: "run-command",
        command,
        commandId,
      });
    }
    const stale = await postCard(watch, {
      path: "actions/pause",
      headers,
      body: JSON.stringify({ ...pause, expectedRevision: 3 }),
    });
    assert.equal(stale.status, 200);
    const refusal = fields(fields(JSON.parse(stale.body))["error"]);
    assert.equal(refusal["code"], "stale-revision", stale.body);
    assert.deepEqual(
      requests.map((request) => request.parameters),
      [
        { command: "pause", ...pause },
        { command: "resume", ...pause, commandId: "page-resume-1" },
        { command: "drop", ...pause, commandId: "page-drop-1" },
        { command: "pause", ...pause, expectedRevision: 3 },
      ],
    );
  });
});

await test("CLV-335 the run command endpoints refuse a request with no page token, another Origin or a body that is not a run, a revision and a command ID", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const good = actionHeaders(watch, await pageToken(watch));
    const refused = async (body: string, headers = good) => {
      const reply = await postCard(watch, {
        path: "actions/drop",
        headers,
        body,
      });
      assert.equal(reply.status, 403, body);
    };
    await refused(JSON.stringify(pause), {
      ...good,
      "x-cloving-token": "b".repeat(64),
    });
    await refused(JSON.stringify(pause), {
      ...good,
      origin: "http://example.com",
    });
    for (const body of [
      { ...pause, runId: "bad id" },
      { ...pause, commandId: "bad id" },
      { ...pause, expectedRevision: 0 },
      { ...pause, expectedRevision: 1.5 },
      { ...pause, expectedRevision: "4" },
      { runId: "run-a", expectedRevision: 4 },
      { ...pause, extra: true },
      { ...pause, pad: "x".repeat(17000) },
      [],
    ])
      await refused(JSON.stringify(body));
    await refused("{");
    assert.equal(requests.length, 0);
  });
});

await test("CLV-335 with watch actions off, the page has no token and the run command endpoints are unknown paths", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(
    {
      answer: answered(requests),
      configure: () =>
        Promise.resolve({ environment: { CLOVING_WATCH_ACTIONS: "off" } }),
    },
    async (watch) => {
      const page = await (await fetch(watch.address)).text();
      assert.match(page, /const actionToken = null;/);
      for (const command of ["pause", "resume", "drop"]) {
        const reply = await postCard(watch, {
          path: `actions/${command}`,
          headers: actionHeaders(watch, "wrong"),
          body: JSON.stringify(pause),
        });
        assert.equal(reply.status, 404, command);
        assert.equal(reply.body, "not found");
      }
      assert.equal(requests.length, 0);
    },
  );
});

await test("CLV-335 the README describes the run controls of the watch page, the second click of Drop and the replies", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  for (const part of [
    /the run detail of an active run has \*\*Pause\*\* in its action bar and \*\*Drop\*\* in its `⋯` menu/,
    /\*\*Resume\*\* replaces \*\*Pause\*\*/,
    /`cloving pause`, `cloving resume` and `cloving drop`, with the revision of the run/,
    /`Drop this run\? Its work tree and pull request stay\.` with \*\*Drop the run\*\* and \*\*Keep it\*\*/,
    /`Paused`, `Resumed` or `Dropped`/,
    /the focus moves to \*\*Keep it\*\*\. \*\*Keep it\*\* sends nothing and moves the focus back to \*\*Drop\*\*/,
    /The reply of \*\*Drop\*\* stays after the run ends: the run detail shows it, and the board and the floor show it in one line with the title of the run/,
    /When the page shows a new revision of the run, the next click gets a new command ID/,
    /`The run changed\. Look again and try again\.`/,
    /`actions\/pause`, `actions\/resume` and `actions\/drop` use the write rules/,
    /`CLOVING_WATCH_ACTIONS=off` removes the form control, the queue control, the loop controls, the run controls and their endpoints/,
  ])
    assert.match(readme, part);
});
