import assert from "node:assert/strict";
import { test } from "node:test";
import { withHarness, fields, items } from "./service-fixture.ts";
import { watching } from "./watch-fixture.ts";
import {
  actionHeaders,
  cardWatch,
  pageToken,
  postCard,
} from "./watch-action-fixture.ts";

await test("CLV-135 concurrent retries with the same command ID admit one real service run and reach the board", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [{ ...harness.registration, workflowId: "develop-prd" }],
    });
    await cardWatch(harness.runtimeDirectory);
    const watch = await watching(harness.runtimeDirectory);
    try {
      const headers = actionHeaders(watch, await pageToken(watch));
      const replies = await Promise.all([
        postCard(watch, { headers }),
        postCard(watch, { headers }),
      ]);
      assert.deepEqual(
        replies.map((reply) => reply.status),
        [200, 200],
      );
      const results = replies.map((reply) =>
        fields(fields(JSON.parse(reply.body))["result"]),
      );
      assert.equal(results[0]?.["runId"], results[1]?.["runId"]);
      assert.deepEqual(results.map((result) => result["replayed"]).sort(), [
        false,
        true,
      ]);
      assert.equal(harness.resolved.length, 1);
      const model: unknown = await (
        await fetch(`${watch.address}data.json`)
      ).json();
      assert.equal(items(fields(model)["runs"]).length, 1);
      assert.equal(
        fields(items(fields(model)["runs"])[0])["runId"],
        results[0]?.["runId"],
      );
    } finally {
      await watch.stop();
      await service.close();
    }
  }));
