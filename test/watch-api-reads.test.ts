import assert from "node:assert/strict";
import { test } from "node:test";
import { watchApiDocument } from "../src/cli/watch-api-document.ts";
import { contractBody } from "./watch-api-contract.ts";
import { declaredWatch } from "./watch-action-fixture.ts";
import { watchReplies, withWatchService } from "./watch-service-fixture.ts";

const now = Date.now();
const waitingAt = new Date(now - 60000).toISOString();
const completedAt = new Date(now - 120000).toISOString();

const workflowReplies = (): ReturnType<typeof watchReplies> =>
  watchReplies({
    workflows: ["review-corpus", "develop"],
    runs: [
      {
        runId: "run-waiting",
        workflowId: "review-corpus",
        state: "waiting_gate",
        latestSequence: 0,
        latestAt: waitingAt,
        pendingDecisions: ["run-waiting/design-1"],
      },
      {
        runId: "run-completed",
        workflowId: "develop",
        state: "completed",
        latestSequence: 0,
        latestAt: completedAt,
      },
    ],
  });

const reviewCorpus = {
  workflowId: "review-corpus",
  activeCount: 1,
  waitingCount: 1,
  latestAt: waitingAt,
};
const develop = {
  workflowId: "develop",
  activeCount: 0,
  waitingCount: 0,
  latestAt: completedAt,
  inputs: [],
};

async function listedWorkflows(address: string): Promise<unknown> {
  const response = await fetch(`${address}api/v1/workflows`);
  assert.equal(response.status, 200);
  return contractBody(watchApiDocument, { response, path: "/workflows" });
}

await test("CLV-254 GET api/v1/workflows gives the counts, the latest time and the card form fields of each workflow", () =>
  withWatchService(
    {
      answer: workflowReplies().answer,
      configure: (runtime) => declaredWatch(runtime),
    },
    async (watch) => {
      assert.deepEqual(await listedWorkflows(watch.address), {
        workflows: [
          {
            ...reviewCorpus,
            inputs: [
              {
                name: "importId",
                label: "importId",
                multiline: false,
                optional: false,
              },
            ],
          },
          develop,
        ],
      });
    },
  ));

await test("CLV-254 GET api/v1/workflows gives an empty inputs list when the watch actions are off", () =>
  withWatchService(
    {
      answer: workflowReplies().answer,
      configure: async (runtime) => ({
        ...(await declaredWatch(runtime)),
        environment: { CLOVING_WATCH_ACTIONS: "off" },
      }),
    },
    async (watch) => {
      assert.deepEqual(await listedWorkflows(watch.address), {
        workflows: [{ ...reviewCorpus, inputs: [] }, develop],
      });
    },
  ));
