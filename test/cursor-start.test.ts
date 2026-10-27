import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
import { call, runCli } from "./service-fixture.ts";
import { cursorFixture, fakeCursor } from "./cursor-fixture.ts";

await test("CLV-214 start uses a saved Cursor default for develop-prompt and status retains unknown usage", () =>
  withoutChildren(async () => {
    const fixture = await scene();
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
          workflowId: "develop-prompt",
          source: "prompt",
          submission: { prompt: "Implement the change." },
          commandId: "cursor-default",
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
      assert.match(String(field(decision, "prompt")), /Implemented the change/);
      const status = await runCli(["status", runId], {
        directory: fixture.repository,
        runtime: fixture.runtimeDirectory,
      });
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /Harness: cursor-agent/);
      assert.match(status.stdout, /Token usage not known/);
      assert.match(status.stdout, /Price not known/);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
