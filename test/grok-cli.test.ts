import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { call, runCli } from "./service-fixture.ts";
import {
  ended,
  field,
  items,
  reached,
  scene,
  withoutChildren,
  type Scene,
} from "./self-host-fixture.ts";
import { grokMessages, grokReport, grokResult } from "./grok-worker-fixture.ts";

async function configuredGrok(fixture: Scene): Promise<string> {
  const configuration = join(fixture.root, "config");
  const program = join(fixture.root, "grok");
  await mkdir(join(configuration, "cloving/projects"), { recursive: true });
  await writeFile(
    program,
    `#!${process.execPath}
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
for await (const chunk of process.stdin) String(chunk);
writeFileSync("grok.txt", process.argv.at(-1));
execFileSync("git", ["add", "grok.txt"]);
execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "commit", "-qm", "Add grok work"]);
process.stdout.write(${JSON.stringify([...grokMessages, grokResult].map((event) => JSON.stringify(event)).join("\n"))});
`,
    { mode: 0o700 },
  );
  await writeFile(
    privateSettingsPath({ XDG_CONFIG_HOME: configuration }, fixture.repository),
    JSON.stringify({
      version: 1,
      harness: { name: "grok", kind: "file", path: program },
    }),
  );
  return configuration;
}

await test("CLV-213 develop-prompt status shows the grok report, model and counts after restart", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const configuration = await configuredGrok(fixture);
    const daemon = await fixture.start({ XDG_CONFIG_HOME: configuration });
    let runId = "";
    try {
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop-prompt",
          source: "prompt",
          submission: { prompt: 'Add "grok"\nwith a commit' },
          commandId: "grok-prompt",
        },
      });
      runId = String(admitted["runId"]);
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
      assert.match(String(field(decision, "prompt")), /Added the worker/);
      await verifyStatus(fixture, runId);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
    const restarted = await fixture.start({ XDG_CONFIG_HOME: configuration });
    try {
      await verifyStatus(fixture, runId);
    } finally {
      assert.equal(await ended(restarted), 0);
    }
  }));

async function verifyStatus(fixture: Scene, runId: string): Promise<void> {
  const status = await call(fixture, {
    operation: "status",
    parameters: { runId },
  });
  const turn = items(field(status["run"], "workerTurns"))[0];
  assert.equal(field(turn, "harness"), "grok");
  assert.equal(field(turn, "summary"), grokReport);
  assert.equal(field(turn, "model"), "grok-4.6");
  assert.deepEqual(field(turn, "usage"), {
    input_tokens: 912,
    cache_read_input_tokens: 200,
    output_tokens: 210,
  });
  const printed = await runCli(["status", runId], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
  });
  assert.equal(printed.status, 0);
  assert.match(printed.stdout, /Harness: grok/);
  assert.match(printed.stdout, /Model: grok-4\.6/);
  assert.match(printed.stdout, /Added the worker/);
  assert.match(printed.stdout, /Input tokens: 912/);
  assert.match(printed.stdout, /Price not known/);
}
