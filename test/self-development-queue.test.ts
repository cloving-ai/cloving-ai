import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { privateQueue } from "./self-development-fixture.ts";
import { ended, reached, withoutChildren } from "./self-host-fixture.ts";
import { call, fields, items } from "./service-fixture.ts";

await test("CLV-227 the private default template receives the queue before and after daemon restart", () =>
  withoutChildren(async () => {
    const fixture = await privateQueue();
    const asked = () =>
      call(
        { runtimeDirectory: fixture.runtimeDirectory },
        { operation: "status", parameters: {} },
      );
    for (const count of [1, 2]) {
      await writeFile(join(fixture.root, "ready"), String(899 + count));
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
