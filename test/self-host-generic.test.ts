import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { writeLocalWorkflow } from "./workflow-folder-fixture.ts";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import {
  ended,
  field,
  items,
  reached,
  scene,
  withoutChildren,
} from "./self-host-fixture.ts";
import { call, parsed, runCli } from "./service-fixture.ts";
import { unknownUsage } from "./worker-report-fixture.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

await test("CLV-215 the service runs a generic harness and CLI status keeps unknown usage", () =>
  withoutChildren(async () => {
    const fixture = await scene(
      'for await (const chunk of process.stdin) String(chunk); console.log("Generic report.\\nTicket status: complete");',
      entry,
    );
    await writeLocalWorkflow(fixture.repository);
    const config = join(fixture.root, "config");
    await mkdir(join(config, "cloving/projects"), { recursive: true });
    await writeFile(
      privateSettingsPath({ XDG_CONFIG_HOME: config }, fixture.repository),
      JSON.stringify({
        version: 1,
        harness: {
          name: "mytool",
          turn: [process.execPath, join(fixture.root, "fake-claude.mjs")],
        },
      }),
    );
    const daemon = await fixture.start({ XDG_CONFIG_HOME: config });
    try {
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop",
          source: "ticket",
          submission: { ticket: "CLV-900" },
          commandId: "generic-turn",
        },
      });
      assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
      const runId = String(admitted["runId"]);
      const turn = await reached(
        async () =>
          items(
            field(
              (
                await call(fixture, {
                  operation: "status",
                  parameters: { runId },
                })
              )["run"],
              "workerTurns",
            ),
          )[0],
      );
      assert.equal(field(turn, "harness"), "mytool");
      await verifyUnknownUsage(fixture, runId);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));

async function verifyUnknownUsage(
  fixture: { readonly repository: string; readonly runtimeDirectory: string },
  runId: string,
): Promise<void> {
  const environment = {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
  };
  const json = parsed(await runCli(["status", runId, "--json"], environment));
  const run = json["run"];
  assert.equal(field(run, "claudeCostUsd"), null);
  assert.deepEqual(field(run, "usage"), unknownUsage);
  const text = await runCli(["status", runId], environment);
  assert.match(text.stdout, /Price not known/);
  assert.match(text.stdout, /Token usage not known/);
}
