import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  ticketRegistrations,
  ticketRegistrationTable,
} from "../src/daemon/ticket-registration.ts";
import { withProject, workflowId } from "./cli-fixture.ts";
import { feedDeclaration } from "./workflow-feed-fixture.ts";
import type { WorkflowDeclaration } from "../src/workflow-declaration.ts";

const declaration: WorkflowDeclaration = {
  ...feedDeclaration.workflow,
  capabilities: ["claude", "github", "command"],
  input: { maximumBytes: 4096, fields: { ticket: { type: "ticket" } } },
};

const feedId = "workflow//./workflows/develop//triageFeed";
const files = {
  "project with spaces/artifacts/manifest.json": JSON.stringify({
    steps: {},
    workflows: {
      "workflows/develop.ts": {
        develop: { workflowId },
        triageFeed: { workflowId: feedId },
      },
    },
  }),
  "project with spaces/work.workflow.json": JSON.stringify({
    schemaVersion: 1,
    name: "develop",
    workflowId,
    steps: [],
    capabilities: ["claude", "github", "command"],
    resources: [],
    artifacts: "artifacts",
  }),
  "project with spaces/feed.workflow.json": JSON.stringify({
    schemaVersion: 1,
    name: "triageFeed",
    workflowId: feedId,
    steps: [],
    capabilities: ["github", "command"],
    resources: [],
    artifacts: "artifacts",
  }),
};

function tableIn(directory: string) {
  return ticketRegistrationTable(
    { repository: directory, command: undefined },
    [
      {
        ...declaration,
        functionName: "develop",
        effectLimit: 8,
        handoffs: ["triage"],
        queue: { ...feedDeclaration.workflow.queue, feedEffectLimit: 3 },
      },
    ],
  );
}

await test("CLV-362 daemon admission retains the distinct feed manifest and its separate effect budget", () =>
  withProject(files, async (_cli, directory) => {
    const bundleDigest = "a".repeat(64);
    const admitted = await ticketRegistrations(
      {
        develop: join(directory, "work.workflow.json"),
        triageFeed: join(directory, "feed.workflow.json"),
      },
      {
        table: tableIn(directory),
        commands: { list: ["list-issues"] },
        bundleDigest,
      },
    );
    assert.equal(admitted.kind, "admitted", JSON.stringify(admitted));
    assert.equal(admitted.registrations.length, 1);
    const registration = admitted.registrations[0];
    assert.ok(registration);
    assert.ok(registration.feed, "The feed needs its own admitted manifest.");
    assert.equal(registration.effectLimit, 8);
    assert.equal(registration.manifest.workflowId, workflowId);
    assert.equal(registration.feed.functionName, "triageFeed");
    assert.equal(registration.feed.effectLimit, 3);
    assert.equal(registration.feed.manifest.workflowId, feedId);
    assert.equal(registration.feed.manifest.bundleDigest, bundleDigest);
    assert.deepEqual(registration.feed.manifest.commands, ["list"]);
    assert.equal(registration.feed.manifest.queue, undefined);
    assert.equal(registration.feed.manifest.handoffs, undefined);
  }));

await test("CLV-362 a missing compiled feed refuses the entire daemon registration", () =>
  withProject(files, async (_cli, directory) => {
    assert.deepEqual(
      await ticketRegistrations(
        { develop: join(directory, "work.workflow.json") },
        { table: tableIn(directory), commands: { list: ["list-issues"] } },
      ),
      {
        kind: "rejected",
        detail: "queue-feed-missing: triage -> triageFeed",
      },
    );
  }));

await test("CLV-362 an invalid compiled feed refuses the entire daemon registration", () =>
  withProject(
    { ...files, "project with spaces/feed.workflow.json": "{}" },
    async (_cli, directory) => {
      const result = await ticketRegistrations(
        {
          develop: join(directory, "work.workflow.json"),
          triageFeed: join(directory, "feed.workflow.json"),
        },
        { table: tableIn(directory), commands: { list: ["list-issues"] } },
      );
      assert.equal(result.kind, "rejected", JSON.stringify(result));
      assert.equal(
        result.detail,
        "invalid-manifest: schemaVersion or artifacts",
      );
    },
  ));

await test("CLV-362 a manifest for another function cannot stand in for the feed", () =>
  withProject(files, async (_cli, directory) => {
    const result = await ticketRegistrations(
      {
        develop: join(directory, "work.workflow.json"),
        triageFeed: join(directory, "work.workflow.json"),
      },
      { table: tableIn(directory), commands: { list: ["list-issues"] } },
    );
    assert.deepEqual(result, {
      kind: "rejected",
      detail: "queue-feed-missing: triage -> triageFeed",
    });
  }));

await test("CLV-362 a feed without feedEffectLimit keeps its own budget with the work limit as default", () =>
  withProject(files, async (_cli, directory) => {
    const table = ticketRegistrationTable(
      { repository: directory, command: undefined },
      [
        {
          ...declaration,
          functionName: "develop",
          effectLimit: 8,
          queue: { feed: "triageFeed" },
        },
      ],
    );
    const result = await ticketRegistrations(
      {
        develop: join(directory, "work.workflow.json"),
        triageFeed: join(directory, "feed.workflow.json"),
      },
      { table, commands: { list: ["list-issues"] } },
    );
    assert.equal(result.kind, "admitted", JSON.stringify(result));
    assert.equal(result.registrations[0]?.feed?.effectLimit, 8);
  }));

await test("CLV-362 a feedless declaration cannot retain an unvalidated feed from a supplied row", () =>
  withProject(files, async (_cli, directory) => {
    const table = ticketRegistrationTable(
      { repository: directory, command: undefined },
      [{ ...declaration, functionName: "develop", queue: true }],
    ).map((row) => ({
      ...row,
      feed: {
        functionName: "unvalidated",
        effectLimit: 999,
        manifest: { workflowId: "unvalidated" },
      },
    }));
    const result = await ticketRegistrations(
      { develop: join(directory, "work.workflow.json") },
      { table, commands: { list: ["list-issues"] } },
    );
    assert.equal(result.kind, "admitted", JSON.stringify(result));
    assert.equal(result.registrations[0]?.feed, undefined);
  }));
