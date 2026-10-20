import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { watchReader } from "../src/cli/watch-reads.ts";
import { Page } from "../src/cli/watch-view.ts";
import { boardModel, boardTime } from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { at, noCopy } from "./watch-sample.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";
import { field } from "./service-fixture.ts";
import { refusalRecords } from "./workflow-refusal-fixture.ts";
import { played } from "./watch-browser.ts";

for (const count of [0, 51])
  await test(`CLV-124 watch carries refusal records beside ${String(count)} runs`, async () => {
    const runs = Array.from({ length: count }, (_, index) => ({
      runId: `run-${String(index).padStart(3, "0")}`,
      workflowId: "sample",
      state: "running",
      latestAt: boardTime,
      latestSequence: 1,
    }));
    const replies = watchReplies({ runs, workflows: ["sample"] });
    const answer = (request: Parameters<typeof replies.answer>[0]) => {
      const reply = replies.answer(request);
      return request.operation === "status" && reply.kind === "result"
        ? {
            ...reply,
            result: { ...reply.result, workflowRefusals: refusalRecords },
          }
        : reply;
    };
    await withWatchService(answer, async (watch, runtimeDirectory) => {
      const read = await watchReader(runtimeDirectory).read(boardTime);
      assert.deepEqual(field(read, "workflowRefusals"), refusalRecords);
      assert.equal(read.runs.length, count);
      const model = boardModel(read.runs, { ...read, updatedAt: boardTime });
      assert.deepEqual(field(model, "workflowRefusals"), refusalRecords);
      assert.deepEqual(
        model.workflows.map((workflow) => workflow.workflowId),
        ["sample"],
      );
      const served = await watchData(watch.address);
      assert.deepEqual(served["workflowRefusals"], refusalRecords);
      assert.equal(
        replies.requests.some(
          (request) => request.parameters["after"] === "run-049",
        ),
        count > 50,
      );
    });
  });

await test("CLV-124 watch lists refusals outside run cards on board and run views", () => {
  const model = {
    ...boardModel([], { workflows: [] }),
    workflowRefusals: refusalRecords,
  };
  for (const selected of ["", "unavailable-run"]) {
    const view = component(Page, {
      model,
      selected,
      now: at("21:34:41"),
      stale: false,
      copying: noCopy,
    });
    const html = rendered(view);
    assert.match(html, /<h2>Refused workflows<\/h2>/);
    assert.match(html, /<li>project broken\.ts: compile-failed<\/li>/);
    assert.match(html, /<li>user workflows\/: workflow-read-failed<\/li>/);
    assert.deepEqual(found(view, "article"), []);
    assert.deepEqual(found(view, "option"), []);
    assert.doesNotMatch(html, /SENTINEL/);
  }
});

await test("CLV-124 embedded browser renders refusals without any runs", () => {
  const model = {
    ...boardModel([], { workflows: [] }),
    workflowRefusals: refusalRecords,
  };
  const result = played(
    model,
    `
location.hash = "";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ html: app.inner, stale: state.stale }));
`,
  );
  assert.equal(result["stale"], false);
  assert.match(String(result["html"]), /<h2>Refused workflows<\/h2>/);
  assert.match(String(result["html"]), /project broken\.ts: compile-failed/);
  assert.match(
    String(result["html"]),
    /user workflows\/: workflow-read-failed/,
  );
  assert.doesNotMatch(String(result["html"]), /class="card"/);
});
