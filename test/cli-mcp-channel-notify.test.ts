import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { notifyRuns } from "../src/daemon/notify.ts";
import { record } from "../src/protocol.ts";
import {
  approval,
  approvalRun,
  channelServer,
  channelService,
} from "./mcp-channel-fixture.ts";
import { eventually, fields, withHarness } from "./service-fixture.ts";

const timeline = [
  { runId: "run-paused0000", workflowId: "develop", state: "paused" },
  { runId: "run-failed0000", workflowId: "develop", state: "failed" },
  {
    runId: "run-blocked000",
    workflowId: "develop",
    state: "completed",
    outcome: { kind: "blocked", reason: "needs help" },
  },
  {
    runId: "run-continued0",
    workflowId: "develop",
    state: "failed",
    continuedBy: "run-next",
  },
  {
    runId: "run-dismissed0",
    workflowId: "develop",
    state: "failed",
    dismissed: true,
  },
  {
    runId: "run-handoff000",
    workflowId: "develop",
    state: "completed",
    outcome: { kind: "handoff_requested", reason: "done" },
  },
];

const stop = {
  workflowId: "patrol",
  stops: [
    {
      stoppedAt: 900_000,
      stoppedSlot: 3,
      failedRunIds: ["run-one", "run-two", "run-three00000"],
    },
  ],
};

async function notified(file: string): Promise<readonly string[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)) ?? {})
    .map((notice) => `${String(notice["event"])}:${String(notice["runId"])}`);
}

await test("CLV-338 the channel and the notify command give the same events for one timeline", () =>
  withHarness(async (harness) => {
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    const directory = harness.stateDirectory;
    const output = join(directory, "notifications");
    await writeFile(join(directory, "notify-events.json"), "[]");
    await writeFile(output, "");
    const notifier = await notifyRuns({
      directory,
      runtimeDirectory: harness.runtimeDirectory,
      command: [
        process.execPath,
        "-e",
        `import { appendFileSync } from "node:fs"; let text = ""; for await (const chunk of process.stdin) text += chunk; appendFileSync(${JSON.stringify(output)}, text);`,
      ],
      intervalMilliseconds: 20,
    });
    harness.cleanup(() => notifier.stop());
    const server = await channelServer({ runtime: harness.runtimeDirectory });
    harness.cleanup(() => {
      server.child.kill();
    });
    service.run(approvalRun, "run.started");
    service.decide(approval);
    for (const run of timeline) service.run(run, "run.changed");
    service.stop(stop, "run-three00000");
    const expected = [
      "blocked:run-blocked000",
      `decision:${approvalRun.runId}`,
      "failed:run-failed0000",
      "paused:run-paused0000",
      "schedule-stopped:run-three00000",
    ];
    const notices = await eventually(async () => {
      const found = await notified(output);
      return found.length >= expected.length ? found : undefined;
    });
    const messages = await server.sent(expected.length);
    await notifier.stop();
    assert.equal((await server.end()).status, 0);
    assert.deepEqual(notices.toSorted(), expected);
    assert.deepEqual(
      messages
        .map((message) => fields(message["meta"]))
        .map(
          (meta) =>
            `${String(meta["kind"]).replace("_", "-")}:${String(meta["run_id"])}`,
        )
        .toSorted(),
      expected,
    );
  }));
