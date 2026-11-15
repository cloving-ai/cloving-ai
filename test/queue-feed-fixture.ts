import type { Service } from "../src/service/service.ts";
import type { Resolver } from "../src/service/registry.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { queueFeed, type FeedStatus } from "../src/daemon/queue-feed.ts";
import { queueJournal } from "../src/daemon/queue-journal.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { text, type Harness } from "./service-fixture.ts";
import { feedWorkflow } from "./service-feed-fixture.ts";

export async function queuedFeed(
  harness: Harness,
  options: {
    readonly interval?: number;
    readonly clock?: () => number;
    readonly resolver?: Resolver;
  } = {},
) {
  const service = await harness.start({
    workflows: [
      {
        ...feedWorkflow(harness.registration),
        ...(options.resolver === undefined
          ? {}
          : { resolver: options.resolver }),
      },
    ],
  });
  const settings = {
    directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory,
    workflowId: "develop",
    intervalMilliseconds: options.interval ?? 1000,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const shown: FeedStatus[] = [];
  const pending = await queueJournal(settings.directory);
  const attempt = {
    pending,
    available: () => Promise.resolve(true),
    release: () => undefined,
  };
  const progress = async (): Promise<unknown> =>
    JSON.parse(
      await readFile(join(settings.directory, "queue-feed.json"), "utf8"),
    );
  const load = () => queueFeed(settings, (status) => shown.push(status));
  const complete = (result: unknown) =>
    completeFeed({ service, progress }, result);
  return { service, settings, shown, attempt, progress, load, complete };
}

async function completeFeed(
  parts: {
    readonly service: Service;
    readonly progress: () => Promise<unknown>;
  },
  result: unknown,
): Promise<void> {
  const { service, progress } = parts;
  const runId = runIdentity(text(await progress(), "commandId"));
  assert.equal(
    (
      await service.worker.started({
        runId,
        commandId: `start:${runId}`,
        expectedRevision: 1,
      })
    ).kind,
    "accepted",
  );
  const body = JSON.stringify(result);
  assert.equal(
    (
      await service.worker.submit(
        {
          kind: "complete-run",
          runId,
          commandId: `end:${runId}`,
          expectedRevision: 2,
          result: documentDigest(body),
        },
        [body],
      )
    ).kind,
    "accepted",
  );
}
