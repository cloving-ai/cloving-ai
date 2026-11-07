import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { until } from "./claude-worker-fixture.ts";
import { fields, items } from "./service-fixture.ts";
import {
  watchData,
  watchReplies,
  withWatchService,
} from "./watch-service-fixture.ts";

const dayMilliseconds = 86_400_000;

function stoppedRun(
  runId: string,
  run: { readonly ticket: number; readonly endedDays: number },
) {
  return {
    runId,
    workflowId: "develop-issue",
    ticketId: String(run.ticket),
    issueIdentity: { owner: "fixture", repository: "demo", number: run.ticket },
    state: "completed",
    outcome: { kind: "blocked" },
    latestSequence: 2,
    latestAt: new Date(
      Date.now() - run.endedDays * dayMilliseconds,
    ).toISOString(),
  };
}

async function issueWatch(runtime: string) {
  const root = dirname(runtime);
  const repository = join(root, "service-repository");
  await mkdir(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", [
    "-C",
    repository,
    "config",
    "remote.origin.url",
    "git@github.example:fixture/demo.git",
  ]);
  const program = join(root, "fake gh.mjs");
  await writeFile(
    program,
    `const path = process.argv.at(-1);
const number = Number(path.split("/").at(-1));
process.stdout.write(JSON.stringify({
  number,
  html_url: "https://github.example/fixture/demo/issues/" + String(number),
  state: number === 586 ? "closed" : "open",
}));
`,
  );
  return {
    directory: root,
    environment: {
      CLOVING_WATCH_REPOSITORY: repository,
      CLOVING_RETENTION_DAYS: "3",
      CLOVING_GH_COMMAND: JSON.stringify([
        "env",
        "-u",
        "NODE_V8_COVERAGE",
        process.execPath,
        program,
      ]),
    },
  };
}

function finished(model: unknown): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    items(fields(model)["runs"]).map((run) => [
      String(fields(run)["runId"]),
      fields(run)["finished"] ?? null,
    ]),
  );
}

await test("CLV-321 the watch command marks a closed ticket and a run past retention as finished work", async () => {
  const replies = watchReplies({
    runs: [
      stoppedRun("closed-ticket", { ticket: 586, endedDays: 1 }),
      stoppedRun("old-run", { ticket: 261, endedDays: 4 }),
      stoppedRun("open-ticket", { ticket: 592, endedDays: 1 }),
    ],
  });
  await withWatchService(
    { answer: replies.answer, configure: issueWatch },
    async (watch) => {
      await until(async () => {
        const shown = finished(await watchData(watch.address));
        return shown["closed-ticket"] === "ticket-closed";
      });
      assert.deepEqual(finished(await watchData(watch.address)), {
        "closed-ticket": "ticket-closed",
        "old-run": "retention-expired",
        "open-ticket": null,
      });
    },
  );
});
