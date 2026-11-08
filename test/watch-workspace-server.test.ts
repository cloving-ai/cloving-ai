import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceWatchServer } from "../src/cli/watch-server.ts";
import type { WatchMember } from "../src/cli/watch-snapshot.ts";
import { fields, items, startedRun, withHarness } from "./service-fixture.ts";

async function served(members: readonly WatchMember[]) {
  const ready = Promise.withResolvers<string>();
  const stopped = Promise.withResolvers<undefined>();
  const finished = workspaceWatchServer({
    repositories: members,
    port: 0,
    client: "cloving",
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

async function json(address: string, path: string): Promise<unknown> {
  const reply = await fetch(`${address}${path}`);
  assert.equal(reply.status, 200, path);
  return reply.json();
}

async function assertChangeStream(address: string): Promise<void> {
  const stopping = new AbortController();
  const events = await fetch(`${address}events`, { signal: stopping.signal });
  const reader = events.body?.getReader();
  const first: unknown = (await reader?.read())?.value;
  assert.match(
    new TextDecoder().decode(first instanceof Uint8Array ? first : undefined),
    /^data: change\n\n/,
  );
  stopping.abort();
}

async function assertWorkspaceReads(
  address: string,
  runs: { readonly alphaRun: string; readonly betaRun: string },
): Promise<void> {
  const { alphaRun, betaRun } = runs;
  const model = fields(await json(address, "data.json"));
  assert.deepEqual(
    items(model["repositories"]).map((repository) => [
      fields(repository)["name"],
      fields(repository)["service"],
    ]),
    [
      ["alpha", "up"],
      ["beta", "up"],
    ],
  );
  assert.deepEqual(
    items(model["runs"])
      .map((run) => [fields(run)["repository"], fields(run)["runId"]])
      .toSorted(),
    [
      ["alpha", alphaRun],
      ["beta", betaRun],
    ].toSorted(),
  );
  assert.deepEqual(
    items(model["workflows"]).map((workflow) => [
      fields(workflow)["repository"],
      fields(workflow)["workflowId"],
    ]),
    [
      ["alpha", "develop"],
      ["beta", "develop"],
    ],
  );
  const run = fields(
    fields(
      await json(address, `data.json?runId=${encodeURIComponent(betaRun)}`),
    )["run"],
  );
  assert.deepEqual([run["repository"], run["runId"]], ["beta", betaRun]);
  await assertChangeStream(address);
  const unknown = await fetch(`${address}data.json?runId=unknown-run`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await json(address, "phone.json"), {
    relay: "off",
  });
  const action = await fetch(`${address}actions/run`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(action.status, 404);
  const page = await (await fetch(address)).text();
  assert.match(page, /const actionToken = null;/);
}

await test("CLV-312 one watch server reads the runtime directory of each repository and names the repository of each run", async () => {
  await withHarness(async (alpha) =>
    withHarness(async (beta) => {
      const alphaRun = await startedRun(alpha, {
        service: await alpha.start(),
        commandId: "alpha-command",
      });
      const betaRun = await startedRun(beta, {
        service: await beta.start(),
        commandId: "beta-command",
      });
      const watch = await served([
        { name: "alpha", runtimeDirectory: alpha.runtimeDirectory },
        { name: "beta", runtimeDirectory: beta.runtimeDirectory },
      ]);
      try {
        await assertWorkspaceReads(watch.address, { alphaRun, betaRun });
      } finally {
        assert.equal(await watch.stop(), 0);
      }
    }),
  );
});

await test("CLV-312 the workspace watch page shows a repository as down when its service does not answer", async () => {
  await withHarness(async (alpha) =>
    withHarness(async (beta) => {
      await alpha.start();
      const watch = await served([
        { name: "alpha", runtimeDirectory: alpha.runtimeDirectory },
        { name: "beta", runtimeDirectory: beta.runtimeDirectory },
      ]);
      try {
        const model = fields(await json(watch.address, "data.json"));
        assert.deepEqual(
          items(model["repositories"]).map(
            (repository) => fields(repository)["service"],
          ),
          ["up", "down"],
        );
        assert.equal(model["service"], "down");
      } finally {
        assert.equal(await watch.stop(), 0);
      }
    }),
  );
});
