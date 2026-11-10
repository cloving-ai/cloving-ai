import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  removeWorkspaceRecord,
  workspaceRecordPath,
  writeWorkspaceRecord,
} from "../src/cli/workspace-record.ts";
import type { Fields } from "../src/protocol.ts";
import { commandUsage } from "../src/cli/usage.ts";
import type { RestartInvocation } from "../src/cli/restart-arguments.ts";
import { workspaceRestartCommand } from "../src/cli/workspace-restart-command.ts";
import { listen } from "../src/service/transport.ts";
import { entry } from "./workspace-fixture.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "clv-restart-ws-")));
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

const environment: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  NODE_V8_COVERAGE: process.env["NODE_V8_COVERAGE"],
  XDG_STATE_HOME: join(root, "state"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: "",
};

async function cloving(argumentsList: readonly string[]) {
  return promisify(execFile)(process.execPath, [entry, ...argumentsList], {
    cwd: root,
    env: environment,
    timeout: 20000,
  }).catch((error: unknown) => ({
    stdout: String(Reflect.get(Object(error), "stdout")),
    stderr: String(Reflect.get(Object(error), "stderr")),
    code: Number(Reflect.get(Object(error), "code")),
  }));
}

async function withSupervisor(
  body: (requests: readonly Fields[]) => Promise<void>,
): Promise<void> {
  const record = String(workspaceRecordPath(environment));
  await writeWorkspaceRecord(record, {
    processId: process.pid,
    members: [
      {
        name: "alpha",
        repository: join(root, "alpha"),
        runtime: join(root, "a"),
      },
      {
        name: "beta",
        repository: join(root, "beta"),
        runtime: join(root, "b"),
      },
    ],
  });
  const requests: Fields[] = [];
  const supervisor = await listen({
    path: join(dirname(record), "control.sock"),
    handle: (request) => {
      requests.push({ operation: request.operation, ...request.parameters });
      return Promise.resolve({
        kind: "result",
        result: {
          kind: "workspace-restart",
          commandId: request.parameters["commandId"],
          repositories: [
            { name: "alpha", serviceStartedAt: "2026-11-08T10:00:00.000Z" },
            { name: "beta", serviceStartedAt: "2026-11-08T10:00:01.000Z" },
          ],
        },
      });
    },
  });
  try {
    await body(requests);
  } finally {
    await supervisor.close();
    await removeWorkspaceRecord(record, process.pid);
  }
}

function invocation(changes: Partial<RestartInvocation>): RestartInvocation {
  return {
    kind: "restart",
    at: "gap",
    cancel: false,
    resumeQueue: false,
    settings: "environment",
    update: false,
    within: null,
    commandId: "restart-8",
    json: false,
    ...changes,
  };
}

async function restartedInProcess(changes: Partial<RestartInvocation>) {
  const output = { out: "", error: "" };
  const status = await workspaceRestartCommand(invocation(changes), {
    terminal: {
      out: (text) => {
        output.out += text;
      },
      error: (text) => {
        output.error += text;
      },
    },
    identifier: () => "generated-1",
    variables: environment,
    interrupted: () => new Promise<void>(() => undefined),
  });
  return { status, ...output };
}

await test("CLV-312 cloving restart restarts the whole workspace through the supervisor while a workspace runs", () =>
  withSupervisor(async (requests) => {
    const json = await cloving([
      "restart",
      "--resume-queue",
      "--command-id",
      "restart-7",
      "--json",
    ]);
    assert.deepEqual(JSON.parse(json.stdout), {
      schemaVersion: 1,
      kind: "workspace-restart",
      commandId: "restart-7",
      repositories: [
        { name: "alpha", serviceStartedAt: "2026-11-08T10:00:00.000Z" },
        { name: "beta", serviceStartedAt: "2026-11-08T10:00:01.000Z" },
      ],
    });
    const text = await restartedInProcess({ at: "now", settings: "files" });
    assert.equal(text.status, 0);
    assert.equal(
      text.out,
      "The workspace restarted all repositories:\n  alpha: service started at 2026-11-08T10:00:00.000Z\n  beta: service started at 2026-11-08T10:00:01.000Z\n",
    );
    assert.deepEqual(
      requests.map(({ operation, at, resumeQueue, settings }) => [
        operation,
        at,
        resumeQueue,
        settings,
      ]),
      [
        ["restart", "keep", true, undefined],
        ["restart", "now", undefined, "files"],
      ],
    );
    assert.deepEqual(
      requests.map((request) => request["commandId"]),
      ["restart-7", "restart-8"],
    );
  }));

await test("CLV-312 a workspace restart refuses --update, --cancel and --within", () =>
  withSupervisor(async (requests) => {
    for (const changes of [
      { update: true },
      { cancel: true },
      { within: 3600 },
    ]) {
      const refused = await restartedInProcess(changes);
      assert.equal(refused.status, 1);
      assert.match(refused.error, /workspace-restart-option: /);
    }
    assert.deepEqual(requests, []);
  }));

await test("CLV-312 CLV-337 the restart help and the README describe the restart of a whole workspace at once with kept turns, or at a common gap", async () => {
  assert.match(
    String(commandUsage["restart"]).replaceAll("\n", " "),
    /While a workspace runs, cloving restart with no --repository restarts all repositories at once, and each one keeps its turns running\. With --at gap, it restarts them at a common gap\..*no --update, --cancel or --within/,
  );
  assert.match(
    await readFile(new URL("../README.md", import.meta.url), "utf8"),
    /While a workspace runs, `cloving restart` with no `--repository` restarts all repositories of the workspace at once, and each repository keeps its turns running, as a restart of one repository does\. With `--at gap`, it restarts them at a common gap\./,
  );
});

await test("CLV-312 a workspace restart reports a supervisor that does not answer", async () => {
  const record = String(workspaceRecordPath(environment));
  await writeWorkspaceRecord(record, {
    processId: process.pid,
    members: [
      {
        name: "alpha",
        repository: join(root, "alpha"),
        runtime: join(root, "a"),
      },
    ],
  });
  try {
    const refused = await restartedInProcess({ commandId: "lost-1" });
    assert.equal(refused.status, 1);
    assert.match(refused.error, /service-unavailable/);
  } finally {
    await removeWorkspaceRecord(record, process.pid);
  }
});
