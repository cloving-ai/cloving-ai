import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { restartCommand } from "../src/cli/restart-command.ts";
import { restartEnvironment } from "../src/cli/start-environment.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { record } from "../src/protocol.ts";
import {
  restartMark,
  type RestartMark,
  type RestartPort,
} from "../src/restart-request.ts";
import { call, withHarness } from "./service-fixture.ts";

const startEnvironment: NodeJS.ProcessEnv = {
  HOME: "/home/operator",
  CLOVING_RUNTIME_DIR: "/run/cloving",
  CLOVING_QUEUE_LANES: "4",
  CLOVING_TICKET_COMMAND: '["tickets"]',
  CLOVING_CHECK_COMMAND: '["npm","test"]',
  CLOVING_WORKER: "claude",
};

async function inFolder(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-restart-set-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test("CLV-352 a restart note with a set value puts the variable into the new environment and keeps the other variables", () =>
  inFolder(async (directory) => {
    await writeFile(
      join(directory, "restart-variables"),
      JSON.stringify({ CLOVING_QUEUE_LANES: "8" }),
    );
    assert.deepEqual(await restartEnvironment(directory, startEnvironment), {
      ...startEnvironment,
      CLOVING_QUEUE_LANES: "8",
    });
    assert.equal(existsSync(join(directory, "restart-variables")), false);
  }));

await test("CLV-352 with --settings files and --set together, the new environment has no file variables except the set values", () =>
  inFolder(async (directory) => {
    await writeFile(join(directory, "restart-settings"), "files");
    await writeFile(
      join(directory, "restart-variables"),
      JSON.stringify({ CLOVING_QUEUE_LANES: "8" }),
    );
    assert.deepEqual(await restartEnvironment(directory, startEnvironment), {
      HOME: "/home/operator",
      CLOVING_RUNTIME_DIR: "/run/cloving",
      CLOVING_QUEUE_LANES: "8",
    });
    assert.equal(existsSync(join(directory, "restart-settings")), false);
    assert.equal(existsSync(join(directory, "restart-variables")), false);
  }));

await test("CLV-352 a restart mark keeps the set variables and refuses a variable that no setting has", () => {
  const mark = {
    at: "keep",
    requestedAt: 1,
    commandId: "restart-one",
    resumeQueue: false,
  };
  const variables = { CLOVING_QUEUE_LANES: "8", CLOVING_MERGE_MODE: "queue" };
  assert.deepEqual(restartMark(JSON.stringify({ ...mark, variables })), {
    ...mark,
    variables,
  });
  for (const refused of [{ PATH: "/bin" }, { CLOVING_QUEUE_LANES: 8 }, []])
    assert.equal(
      restartMark(JSON.stringify({ ...mark, variables: refused })),
      undefined,
    );
});

const codeOf = (argumentsList: readonly string[]): unknown =>
  record(parseInvocation(argumentsList))?.["code"];

await test("CLV-352 cloving restart takes --set more than one time and refuses a set value without a key", () => {
  assert.deepEqual(
    record(
      parseInvocation([
        "restart",
        "--set",
        "queue.lanes=8",
        "--set=merge.mode=queue",
        "--set",
        'tickets.command=["tickets","a=b"]',
      ]),
    )?.["set"],
    {
      "queue.lanes": "8",
      "merge.mode": "queue",
      "tickets.command": '["tickets","a=b"]',
    },
  );
  assert.deepEqual(record(parseInvocation(["restart"]))?.["set"], {});
  for (const value of ["queue.lanes", "=8"])
    assert.equal(codeOf(["restart", "--set", value]), "invalid-option-value");
  assert.equal(
    codeOf(["restart", "--cancel", "--set", "queue.lanes=8"]),
    "unexpected-option",
  );
  assert.equal(
    codeOf(["status", "--set", "queue.lanes=8"]),
    "unexpected-option",
  );
  assert.equal(
    codeOf(["restart", "--at", "now", "--at", "gap"]),
    "repeated-option",
  );
  assert.match(String(commandUsage["restart"]), /--set <key>=<value>/);
});

function recordingPort(marks: RestartMark[]): RestartPort {
  return {
    pending: () => Promise.resolve(marks.at(-1)),
    request: (mark) => Promise.resolve(void marks.push(mark)),
    cancel: () => Promise.resolve("none"),
    unresumable: () => Promise.resolve([]),
    failure: () => Promise.resolve(undefined),
  };
}

const identity = {
  version: "1.6.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  startedAt: "2026-11-10T10:00:00.000Z",
};

await test("CLV-352 cloving restart --set sends the values, and the request carries their variables in the settings file form", () =>
  withHarness(async (harness) => {
    const marks: RestartMark[] = [];
    await harness.start({ restart: recordingPort(marks), ...identity });
    const invocation = parseInvocation([
      "restart",
      "--set",
      "queue.lanes=8",
      "--set",
      'checks.required=["ci"]',
      "--set",
      "merge.mode=queue",
    ]);
    assert.equal(invocation.kind, "restart");
    const code = await restartCommand(
      {
        runtimeDirectory: harness.runtimeDirectory,
        terminal: { out: () => undefined, error: () => undefined },
        identifier: () => "restart-set",
        interrupted: () => Promise.resolve(),
      },
      invocation,
    );
    assert.equal(code, 130);
    assert.deepEqual(
      marks.map((mark) => [mark.commandId, mark.variables]),
      [
        [
          "restart-set",
          {
            CLOVING_QUEUE_LANES: "8",
            CLOVING_REQUIRED_CHECKS: '["ci"]',
            CLOVING_MERGE_MODE: "queue",
          },
        ],
      ],
    );
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(record(status["restart"])?.["variables"], {
      CLOVING_QUEUE_LANES: "8",
      CLOVING_REQUIRED_CHECKS: '["ci"]',
      CLOVING_MERGE_MODE: "queue",
    });
  }));

const refusedSettings = [
  ["queue.lanez", "8", /unknown-setting: queue\.lanez/],
  ["queue.lanes", "17", /invalid-setting: queue\.lanes must be from 1 to 16/],
  ["queue.lanes", "many", /invalid-setting: /],
  [
    "harness.path",
    "/bin/claude",
    /invalid-setting: harness\.path has no environment variable/,
  ],
] as const;

await test("CLV-352 an unknown key, an invalid value or a key with no variable refuses the restart with invalid-restart-setting and the key, and records no request", () =>
  withHarness(async (harness) => {
    const marks: RestartMark[] = [];
    await harness.start({ restart: recordingPort(marks), ...identity });
    for (const [key, value, detail] of refusedSettings) {
      const result = await harness.cli([
        "restart",
        "--json",
        "--set",
        `${key}=${value}`,
      ]);
      const reply = record(JSON.parse(result.stdout)) ?? {};
      assert.equal(result.status, 1, result.stderr);
      assert.equal(reply["code"], "invalid-restart-setting");
      assert.equal(reply["key"], key);
      assert.match(
        String(reply["detail"]),
        new RegExp(`^The restart cannot set ${key}\\. ${detail.source}`),
      );
    }
    assert.deepEqual(marks, []);
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(status["restart"], null);
  }));

await test("CLV-352 the service refuses a set field that is not a map of texts", () =>
  withHarness(async (harness) => {
    await harness.start({ restart: recordingPort([]), ...identity });
    for (const set of [["queue.lanes=8"], { "queue.lanes": 8 }, "lanes"]) {
      const reply = await call(harness, {
        operation: "restart",
        parameters: { at: "keep", commandId: "restart-shape", set },
      });
      assert.equal(reply["code"], "invalid-request");
    }
  }));

await test("CLV-352 the README describes cloving restart --set, its refusal and the workspace refusal", async () => {
  const readme = (
    await readFile(new URL("../README.md", import.meta.url), "utf8")
  ).replaceAll("\n", " ");
  assert.match(readme, /cloving restart --set queue\.lanes=8/);
  assert.match(
    readme,
    /`cloving restart --set <key>=<value>` changes one start setting at the restart\./,
  );
  assert.match(
    readme,
    /refuses the restart with `invalid-restart-setting` and the key/,
  );
  assert.match(
    readme,
    /A workspace restart has no `--update`, `--cancel`, `--within` or `--set`; it gives `workspace-restart-option`\./,
  );
});
