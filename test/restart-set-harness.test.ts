import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restartEnvironment } from "../src/cli/start-environment.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { daemonIdentity } from "../src/daemon/daemon-adapters.ts";
import { record } from "../src/protocol.ts";
import {
  restartMark,
  type RestartMark,
  type RestartPort,
} from "../src/restart-request.ts";
import { call, withHarness, type Harness } from "./service-fixture.ts";

function recordingPort(marks: RestartMark[]): RestartPort {
  return {
    pending: () => Promise.resolve(marks.at(-1)),
    request: (mark) => Promise.resolve(void marks.push(mark)),
    cancel: () => Promise.resolve("none"),
    unresumable: () => Promise.resolve([]),
    failure: () => Promise.resolve(undefined),
  };
}

function restartWith(
  harness: Harness,
  set: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  return call(harness, {
    operation: "restart",
    parameters: { at: "keep", commandId: "restart-harness", set },
  });
}

const command = '["claude","--verbose"]';

const startedAt = "2026-11-10T10:00:00.000Z";

await test("CLV-352 restart --set harness.command sets the command variable of the Claude worker when the service selects no other worker", () =>
  withHarness(async (harness) => {
    const marks: RestartMark[] = [];
    await harness.start({ restart: recordingPort(marks), startedAt });
    const reply = await restartWith(harness, { "harness.command": command });
    assert.equal(reply["code"], undefined, JSON.stringify(reply));
    assert.deepEqual(marks[0]?.variables, { CLOVING_CLAUDE_COMMAND: command });
  }));

await test("CLV-352 restart --set harness.command sets the command variable of the worker of the service", () =>
  withHarness(async (harness) => {
    const marks: RestartMark[] = [];
    await harness.start({
      restart: recordingPort(marks),
      startedAt,
      worker: "codex",
    });
    await restartWith(harness, { "harness.command": '["codex","exec"]' });
    assert.deepEqual(marks[0]?.variables, {
      CLOVING_CODEX_COMMAND: '["codex","exec"]',
    });
  }));

await test("CLV-352 restart --set harness.command with --set harness.name sets the command variable of the set worker", () =>
  withHarness(async (harness) => {
    const marks: RestartMark[] = [];
    await harness.start({
      restart: recordingPort(marks),
      startedAt,
      worker: "claude",
    });
    await restartWith(harness, {
      "harness.command": '["gemini","--yolo"]',
      "harness.name": "gemini",
    });
    assert.deepEqual(marks[0]?.variables, {
      CLOVING_GEMINI_COMMAND: '["gemini","--yolo"]',
      CLOVING_WORKER: "gemini",
    });
  }));

const refusedCommands = [
  {
    worker: "cursor-agent",
    set: { "harness.command": command },
    key: "harness.command",
    detail: /: harness\.command has no environment variable$/,
  },
  {
    worker: "claude",
    set: { "harness.command": command, "harness.name": "my-tool" },
    key: "harness.command",
    detail: /: harness\.command has no environment variable$/,
  },
  {
    worker: "claude",
    set: { "harness.command": '"claude"' },
    key: "harness.command",
    detail: /invalid-setting: harness\.command$/,
  },
  {
    worker: "claude",
    set: { "harness.command": command, "harness.name": "1e999" },
    key: "harness.name",
    detail: /invalid-setting-value$/,
  },
] as const;

await test("CLV-352 restart --set harness.command refuses a worker with no command variable, a value that is not a command list and an invalid worker name", async () => {
  for (const { worker, set, key, detail } of refusedCommands)
    await withHarness(async (harness) => {
      const marks: RestartMark[] = [];
      await harness.start({
        restart: recordingPort(marks),
        startedAt,
        worker,
      });
      const reply = await restartWith(harness, set);
      assert.equal(reply["code"], "invalid-restart-setting");
      assert.equal(reply["key"], key);
      assert.match(String(reply["detail"]), detail);
      assert.deepEqual(marks, []);
    });
});

await test("CLV-352 a restart mark and a restart note keep the command variable of a worker", async () => {
  const mark = {
    at: "keep",
    requestedAt: 1,
    commandId: "restart-one",
    resumeQueue: false,
  };
  const variables = { CLOVING_CODEX_COMMAND: '["codex","exec"]' };
  assert.deepEqual(
    record(restartMark(JSON.stringify({ ...mark, variables }))),
    {
      ...mark,
      variables,
    },
  );
  const directory = await mkdtemp(join(tmpdir(), "cloving-restart-harness-"));
  try {
    await writeFile(join(directory, "restart-settings"), "files");
    await writeFile(
      join(directory, "restart-variables"),
      JSON.stringify({ CLOVING_GROK_COMMAND: '["grok","-p"]' }),
    );
    assert.deepEqual(
      await restartEnvironment(directory, {
        HOME: "/home/operator",
        CLOVING_GROK_COMMAND: '["grok"]',
      }),
      { HOME: "/home/operator", CLOVING_GROK_COMMAND: '["grok","-p"]' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("CLV-352 the service identity names the worker that the service selects", () => {
  assert.equal(daemonIdentity({ worker: "codex" }).worker, "codex");
  assert.equal(
    daemonIdentity({ harness: { name: "my-tool" } }).worker,
    "my-tool",
  );
  assert.equal(daemonIdentity({}).worker, "claude");
});

await test("CLV-352 the restart help and the README name the worker command variable that --set harness.command sets", async () => {
  assert.match(
    String(commandUsage["restart"]),
    /\nFor harness\.command, it sets the command variable of the worker of the service, or of the --set harness\.name worker\.\n/,
  );
  const readme = (
    await readFile(new URL("../README.md", import.meta.url), "utf8")
  ).replaceAll("\n", " ");
  assert.match(
    readme,
    /`--set harness\.command=<list>` sets the command variable of the worker that the service runs, for example `CLOVING_CODEX_COMMAND` for `codex`, or of the worker of `--set harness\.name`\./,
  );
});
