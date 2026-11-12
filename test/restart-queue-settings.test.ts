import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record, type Fields } from "../src/protocol.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { capturedSetting } from "./daemon-settings-capture.ts";
import {
  field,
  scene,
  withoutChildren,
  type Scene,
} from "./self-host-fixture.ts";
import { call, runCli } from "./service-fixture.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";

await rm(join(candidatePackageRoot, "dist/package.json"), { force: true });

await test("CLV-352 the emitted start program includes restart settings validation", () => {
  assert.equal(
    existsSync(join(candidatePackageRoot, "dist/tools/restart-settings.js")),
    true,
  );
});

async function queueFiles(fixture: Scene): Promise<void> {
  await mkdir(join(fixture.repository, ".cloving"), { recursive: true });
  await writeFile(
    join(fixture.repository, ".cloving/config.json"),
    JSON.stringify({ version: 1, queue: { everySeconds: 3600, lanes: 2 } }),
  );
  const folder = join(fixture.root, "config/cloving/projects");
  await mkdir(folder, { recursive: true });
  const id = createHash("sha256")
    .update(fixture.repository)
    .digest("hex")
    .slice(0, 8);
  await writeFile(
    join(folder, `repository-${id}.json`),
    JSON.stringify({
      version: 1,
      queue: { lanes: 6, workingLanes: 6 },
      harness: { name: "codex", command: [process.execPath, "unused-worker"] },
      tickets: {
        command: [process.execPath, "unused-ticket"],
        nextCommand: ["false"],
      },
    }),
  );
}

async function started(fixture: Scene): Promise<void> {
  await queueFiles(fixture);
  await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
  await fixture.start({
    XDG_CONFIG_HOME: join(fixture.root, "config"),
    CLOVING_QUEUE_SECONDS: "3600",
    CLOVING_QUEUE_LANES: "8",
    CLOVING_QUEUE_WORKING_LANES: "8",
    CLOVING_CHECK_COMMAND: '["false"]',
    CLOVING_NEXT_COMMAND: '["false"]',
    CLOVING_SELF_UPDATE_SECONDS: undefined,
    CLOVING_NOTIFY_COMMAND: undefined,
  });
}

function status(fixture: Scene): Promise<Fields> {
  return call(fixture, { operation: "status", parameters: {} });
}

const incompatible = [
  { set: { "queue.lanes": "4" }, key: "queue.lanes" },
  {
    settings: "files",
    set: { "queue.lanes": "4" },
    key: "queue.lanes",
  },
] as const;

const startupRefusals = [
  {
    set: { "harness.name": "my-tool" },
    key: "harness.name",
    detail: /harness-no-worker: my-tool/,
    nextCommand: undefined,
  },
  {
    set: { "queue.everySeconds": "60" },
    key: "queue.everySeconds",
    detail: /queue-needs-next-command/,
    nextCommand: undefined,
  },
  {
    set: { "queue.everySeconds": "60" },
    key: "queue.everySeconds",
    detail: /queue-needs-ticket-command/,
    nextCommand: '["false"]',
  },
  {
    set: { "queue.everySeconds": "60", "tickets.nextCommand": "[]" },
    key: "tickets.nextCommand",
    detail: /queue-needs-next-command/,
    nextCommand: '["false"]',
  },
  {
    set: { "queue.everySeconds": "60", "tickets.command": "[]" },
    key: "tickets.command",
    detail: /queue-needs-ticket-command/,
    nextCommand: '["false"]',
  },
  {
    set: { "selfUpdate.everySeconds": "60" },
    key: "selfUpdate.everySeconds",
    detail: /self-update-needs-own-repository/,
    nextCommand: undefined,
  },
] as const;

for (const options of startupRefusals)
  await test(`CLV-352 ${options.detail.source} refuses a restart and preserves the running service`, () =>
    withoutChildren(async () => {
      const fixture = await scene(
        'throw new Error("unexpected-worker");',
        join(candidatePackageRoot, "dist/src/cli.js"),
      );
      await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
      await fixture.start({
        CLOVING_QUEUE_SECONDS: undefined,
        CLOVING_NEXT_COMMAND: options.nextCommand,
        CLOVING_TICKET_COMMAND: undefined,
        CLOVING_SELF_UPDATE_SECONDS: undefined,
      });
      const before = await status(fixture);
      const reply = await call(fixture, {
        operation: "restart",
        parameters: { at: "gap", commandId: "invalid-start", set: options.set },
      });
      assert.equal(
        reply["code"],
        "invalid-restart-setting",
        JSON.stringify(reply),
      );
      assert.equal(reply["key"], options.key);
      assert.match(String(reply["detail"]), options.detail);
      const after = await status(fixture);
      assert.equal(after["serviceStartedAt"], before["serviceStartedAt"]);
      assert.equal(after["restart"], null);
    }));

for (const options of incompatible)
  await test(`CLV-352 incompatible restart queue settings refuse before recording or stopping with ${"settings" in options ? "files" : "environment"} precedence`, () =>
    withoutChildren(async () => {
      const fixture = await scene(
        'throw new Error("unexpected-worker");',
        join(candidatePackageRoot, "dist/src/cli.js"),
      );
      await started(fixture);
      const before = await status(fixture);
      const reply = await call(fixture, {
        operation: "restart",
        parameters: { at: "gap", commandId: "incompatible-queue", ...options },
      });
      assert.equal(
        reply["code"],
        "invalid-restart-setting",
        JSON.stringify(reply),
      );
      assert.equal(reply["key"], options.key);
      assert.match(String(reply["detail"]), /invalid-queue-working-lanes/);
      const after = await status(fixture);
      assert.equal(after["serviceStartedAt"], before["serviceStartedAt"]);
      assert.equal(after["restart"], null);
      assert.equal(field(after["queue"], "lanes"), 8, JSON.stringify(after));
    }));

async function restarted(
  fixture: Scene,
  options: readonly string[],
): Promise<void> {
  const result = await runCli(["restart", "--json", ...options], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(record(JSON.parse(lines.at(-1) ?? "{}"))?.["kind"], "restarted");
}

await test("CLV-352 a compatible multi-key restart preserves other start commands and later restarts while set values override private files", () =>
  withoutChildren(async () => {
    const fixture = await scene(
      'throw new Error("unexpected-worker");',
      join(candidatePackageRoot, "dist/src/cli.js"),
    );
    await started(fixture);
    const before = await status(fixture);
    const commands = ["ticketCommand", "checkCommand", "command"].map((name) =>
      capturedSetting({ directory: fixture.directory, field: name }),
    );
    await restarted(fixture, [
      "--set",
      "queue.lanes=4",
      "--set",
      "queue.workingLanes=3",
    ]);
    const after = await status(fixture);
    assert.notEqual(after["serviceStartedAt"], before["serviceStartedAt"]);
    assert.equal(field(after["queue"], "lanes"), 4);
    assert.equal(
      field(
        capturedSetting({ directory: fixture.directory, field: "queueLimits" }),
        "workingLanes",
      ),
      3,
    );
    assert.deepEqual(
      ["ticketCommand", "checkCommand", "command"].map((name) =>
        capturedSetting({ directory: fixture.directory, field: name }),
      ),
      commands,
    );
    await restarted(fixture, []);
    assert.equal(field((await status(fixture))["queue"], "lanes"), 4);
    await restarted(fixture, [
      "--settings",
      "files",
      "--set",
      "queue.workingLanes=5",
    ]);
    const files = await status(fixture);
    assert.equal(field(files["queue"], "lanes"), 6);
    assert.equal(
      field(
        capturedSetting({ directory: fixture.directory, field: "queueLimits" }),
        "workingLanes",
      ),
      5,
    );
    assert.equal(field(files["settingSources"], "queue.lanes"), "private");
    assert.equal(
      field(files["settingSources"], "queue.workingLanes"),
      "environment",
    );
  }));
