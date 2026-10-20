import assert from "node:assert/strict";
import { test } from "node:test";
import { field, parsed, withHarness } from "./service-fixture.ts";
import { refusalRecords, refusalText } from "./workflow-refusal-fixture.ts";

await test("CLV-124 text and JSON status show the same refusals without runs", () =>
  withHarness(async (harness) => {
    await harness.start({ workflowRefusals: refusalRecords });
    for (const options of [[], ["--limit", "1"], ["--after", "missing"]]) {
      const shown = await harness.cli(["status", ...options]);
      assert.equal(shown.status, 0, shown.stderr);
      assert.equal(
        shown.stdout,
        "Pending decisions:\n  none\nWorkflows: develop\n" +
          refusalText +
          "Runs:\n  none\n",
      );
    }
    const json = await harness.cli(["status", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(field(parsed(json), "workflowRefusals"), refusalRecords);
  }));
