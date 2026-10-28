import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import {
  ended,
  field,
  items,
  reached,
  scene,
  withoutChildren,
} from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";
import { fakeCodex } from "./codex-fixture.ts";
import { chunkStream } from "./gemini-fixture.ts";

await test("CLV-211 start runs a saved Gemini default without inheriting the Claude command", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const program = join(fixture.root, "saved-gemini");
    await writeFile(
      program,
      `#!${process.execPath}\nfor await (const chunk of process.stdin) String(chunk);\nprocess.stdout.write(${JSON.stringify(chunkStream.map((event) => JSON.stringify(event)).join("\n"))});`,
      { mode: 0o700 },
    );
    const config = join(fixture.root, "gemini-config");
    const path = privateSettingsPath(
      { XDG_CONFIG_HOME: config },
      fixture.repository,
    );
    await mkdir(join(config, "cloving/projects"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        harness: { name: "gemini", kind: "file", path: program },
      }),
    );
    const daemon = await fixture.start({ XDG_CONFIG_HOME: config });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(launcher.includes(`\\"command\\":[\\"${program}\\"`), launcher);
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop-ticket",
          source: "ticket",
          submission: { ticket: "CLV-900" },
          commandId: "private-gemini",
        },
      });
      const decision = await reached(
        async () =>
          items(
            (
              await call(fixture, {
                operation: "questions",
                parameters: { runId: admitted["runId"] },
              })
            )["decisions"],
          )[0],
      );
      assert.match(String(field(decision, "prompt")), /Added HELLO.md/);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));

await test("CLV-210 start runs the saved Codex program without an environment worker", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const config = join(fixture.root, "config");
    await mkdir(join(config, "cloving/projects"), { recursive: true });
    const program = join(fixture.root, "saved-codex");
    await writeFile(program, `#!${process.execPath}\n${fakeCodex}`, {
      mode: 0o700,
    });
    await writeFile(
      privateSettingsPath({ XDG_CONFIG_HOME: config }, fixture.repository),
      JSON.stringify({
        version: 1,
        harness: { name: "codex", kind: "file", path: program },
      }),
    );
    const daemon = await fixture.start({ XDG_CONFIG_HOME: config });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(launcher.includes(`\\"command\\":[\\"${program}\\"`), launcher);
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop-ticket",
          source: "ticket",
          submission: { ticket: "CLV-900" },
          commandId: "private-codex",
        },
      });
      const runId = String(admitted["runId"]);
      const decision = await reached(
        async () =>
          items(
            (
              await call(fixture, {
                operation: "questions",
                parameters: { runId },
              })
            )["decisions"],
          )[0],
      );
      assert.match(String(field(decision, "prompt")), /Done\./);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));

await test("CLV-210 start names a harness with no worker", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    assert.match(
      await fixture.refused("8", { CLOVING_WORKER: "unsupported" }),
      /harness-no-worker: unsupported/,
    );
  }));

for (const ending of ["failed", "stopped"])
  await test(`CLV-210 ${ending} turns without a stream result retain their harness after restart`, () =>
    withoutChildren(async () => {
      const script =
        ending === "failed"
          ? "process.stdin.resume();process.exitCode=1;"
          : "process.stdin.resume();setInterval(() => {}, 1000);";
      const fixture = await scene(script);
      const daemon = await fixture.start();
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop-ticket",
          source: "ticket",
          submission: { ticket: "CLV-900" },
          commandId: ending,
        },
      });
      const runId = String(admitted["runId"]);
      try {
        if (ending === "stopped") await dropRunningTurn(fixture, runId);
        await terminalHarness(fixture, runId);
      } finally {
        assert.equal(await ended(daemon), 0);
      }
      const reopened = await fixture.start();
      try {
        await terminalHarness(fixture, runId);
      } finally {
        assert.equal(await ended(reopened), 0);
      }
    }));

async function dropRunningTurn(
  fixture: { readonly runtimeDirectory: string },
  runId: string,
): Promise<void> {
  const run = await reached(async () => {
    const status = await call(fixture, {
      operation: "status",
      parameters: { runId },
    });
    return items(field(status["run"], "effects")).some(
      (effect) => field(effect, "state") === "running",
    )
      ? status["run"]
      : undefined;
  });
  await call(fixture, {
    operation: "run-command",
    parameters: {
      command: "drop",
      runId,
      expectedRevision: field(run, "revision"),
      commandId: "drop-turn",
    },
  });
}

async function terminalHarness(
  fixture: { readonly runtimeDirectory: string },
  runId: string,
): Promise<void> {
  const turn = await reached(async () => {
    const status = await call(fixture, {
      operation: "status",
      parameters: { runId },
    });
    return items(field(status["run"], "workerTurns"))[0];
  });
  assert.equal(field(turn, "harness"), "claude");
}
