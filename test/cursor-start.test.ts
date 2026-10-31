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
import { call, runCli } from "./service-fixture.ts";
import { cursorFixture, fakeCursor } from "./cursor-fixture.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

await test("CLV-214 start uses a saved Cursor default for develop and status retains unknown usage", () =>
  withoutChildren(async () => {
    const fixture = await scene(undefined, entry);
    await writeLocalWorkflow(fixture.repository, { input: "prompt" });
    const config = join(fixture.root, "config");
    await mkdir(join(config, "cloving/projects"), { recursive: true });
    const harness = fakeCursor(
      { directory: fixture.root },
      { output: cursorFixture("completed") },
    );
    await writeFile(
      privateSettingsPath({ XDG_CONFIG_HOME: config }, fixture.repository),
      JSON.stringify({ version: 1, harness }),
    );
    const daemon = await fixture.start({ XDG_CONFIG_HOME: config });
    try {
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop",
          source: "prompt",
          submission: { prompt: "Implement the change." },
          commandId: "cursor-default",
        },
      });
      assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
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
      assert.match(String(field(decision, "prompt")), /^Review this subject:/);
      const status = await runCli(["status", runId], {
        directory: fixture.repository,
        runtime: fixture.runtimeDirectory,
      });
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /Implemented the change/);
      assert.match(status.stdout, /Harness: cursor-agent/);
      assert.match(status.stdout, /Token usage not known/);
      assert.match(status.stdout, /Price not known/);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
