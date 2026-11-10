import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eventually,
  fields,
  items,
  parsed,
  startedRun,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import { watching, type Watching } from "./watch-fixture.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";

interface Page {
  readonly watch: Watching;
  readonly headers: Readonly<Record<string, string>>;
  readonly runId: string;
}

async function shownRun(
  page: Page,
  wanted: string,
): Promise<Readonly<Record<string, unknown>>> {
  return eventually(async () => {
    const model: unknown = await (
      await fetch(`${page.watch.address}data.json`)
    ).json();
    const run = items(fields(model)["runs"])
      .map(fields)
      .find((item) => item["runId"] === page.runId);
    return run?.["state"] === wanted ? run : undefined;
  });
}

async function clicked(
  page: Page,
  command: {
    readonly name: string;
    readonly revision: unknown;
    readonly commandId?: string;
  },
): Promise<Readonly<Record<string, unknown>>> {
  const commandId = command.commandId ?? `page-${command.name}`;
  const reply = await postCard(page.watch, {
    path: `actions/${command.name}`,
    headers: page.headers,
    body: JSON.stringify({
      runId: page.runId,
      expectedRevision: command.revision,
      commandId,
    }),
  });
  assert.equal(reply.status, 200, reply.body);
  return fields(JSON.parse(reply.body));
}

async function sameAsCli(
  harness: Harness,
  click: {
    readonly page: Page;
    readonly name: string;
    readonly revision: unknown;
    readonly reply: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const cli = await harness.cli([
    click.name,
    click.page.runId,
    "--expected-revision",
    String(click.revision),
    "--command-id",
    `page-${click.name}`,
    "--json",
  ]);
  assert.equal(cli.status, 0, cli.stderr);
  const replayed = parsed(cli);
  assert.equal(replayed["replayed"], true);
  assert.equal(click.reply["replayed"], false);
  assert.deepEqual(replayed["receipt"], click.reply["receipt"]);
  assert.equal(replayed["command"], click.reply["command"]);
}

await test("CLV-335 Pause, Resume and Drop of the page change a run in work like the CLI, give the receipt of the CLI command with the same command ID, and an old revision gives stale-revision", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const watch = await watching(harness.runtimeDirectory);
    try {
      const page = {
        watch,
        runId,
        headers: actionHeaders(watch, await pageToken(watch)),
      };
      const working = await shownRun(page, "running");
      const steps = [
        { name: "pause", state: "paused", committed: "paused" },
        { name: "resume", state: "running", committed: "running" },
      ];
      let revision = working["revision"];
      for (const step of steps) {
        const reply = await clicked(page, { name: step.name, revision });
        assert.equal(fields(reply["committed"])["state"], step.committed);
        await sameAsCli(harness, { page, name: step.name, revision, reply });
        revision = (await shownRun(page, step.state))["revision"];
      }
      const stale = await clicked(page, {
        name: "pause",
        revision: working["revision"],
        commandId: "page-stale",
      });
      assert.equal(fields(stale["error"])["code"], "stale-revision");
      const dropped = await clicked(page, { name: "drop", revision });
      assert.equal(fields(dropped["committed"])["state"], "cancelled");
      await sameAsCli(harness, {
        page,
        name: "drop",
        revision,
        reply: dropped,
      });
      await shownRun(page, "cancelled");
    } finally {
      await watch.stop();
      await service.close();
    }
  }));
