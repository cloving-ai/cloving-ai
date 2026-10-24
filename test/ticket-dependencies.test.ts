import assert from "node:assert/strict";
import { test } from "node:test";
import { hardDependencies } from "../src/ticket-dependencies.ts";

await test("CLV-184 only Needs sentences in the Dependencies section supply hard dependencies", () => {
  assert.deepEqual(
    hardDependencies(`Needs #1.
## Dependencies
Needs #12 and #13. Related #14.
- Needs #12, #15 before work.
Optional #16. Needs #17.
### Details
Needs #18.
## References
Needs #19.`),
    ["12", "13", "15", "17", "18"],
  );
  assert.deepEqual(
    hardDependencies("## Dependencies\nNone.\n## Notes\nNeeds #1."),
    [],
  );
});

await test("CLV-184 periods inside paths and abbreviations do not end a Needs sentence", () => {
  assert.deepEqual(
    hardDependencies(
      "## Dependencies\nNeeds the change in src/a.ts from #123. Related #999.\nNeeds #124, e.g. #125.",
    ),
    ["123", "124", "125"],
  );
});

await test("CLV-184 wrapped Needs sentences retain every dependency", () => {
  assert.deepEqual(hardDependencies("## Dependencies\nNeeds #123 and\n#124."), [
    "123",
    "124",
  ]);
});
