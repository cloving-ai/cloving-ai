import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { privateQueue } from "./self-development-fixture.ts";
import { ended, reached, withoutChildren } from "./self-host-fixture.ts";
import { call, fields, items } from "./service-fixture.ts";

await test("CLV-363 the private develop feed selects tickets without queue commands before and after restart", () =>
  withoutChildren(async () => {
    const fixture = await privateQueue();
    const asked = () =>
      call(
        { runtimeDirectory: fixture.runtimeDirectory },
        { operation: "status", parameters: {} },
      );
    for (const count of [1, 2]) {
      await readyIssue(fixture.state, 899 + count);
      const child = await fixture.start(fixture.environment);
      try {
        const runs = await reached(async () => {
          const runs = items((await asked())["runs"]).map(fields);
          return runs.length === count &&
            runs.every((run) => run["state"] === "completed")
            ? runs
            : undefined;
        });
        assert.deepEqual(
          runs.map((run) => run["workflowId"]),
          Array.from({ length: count }, () => "develop"),
        );
        const github = fields(
          JSON.parse(await readFile(fixture.state, "utf8")),
        );
        assert.deepEqual(
          items(github["prs"]).map((pull) => fields(pull)["state"]),
          Array.from({ length: count }, () => "MERGED"),
        );
      } finally {
        assert.equal(await ended(child), 0);
      }
    }
  }));

async function readyIssue(state: string, number: number): Promise<void> {
  const github = fields(JSON.parse(await readFile(state, "utf8")));
  await writeFile(
    state,
    JSON.stringify({
      ...github,
      issueRows: [
        {
          number,
          state: "open",
          title: `Task ${String(number)}`,
          body: "Do the work.",
          html_url: `https://github.com/acme/demo/issues/${String(number)}`,
          created_at: "2026-11-01T00:00:00Z",
          labels: [{ name: "cloving: ready" }],
        },
      ],
    }),
  );
}
