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
import { call } from "./service-fixture.ts";
import { fakeOpencode, opencodeReport } from "./opencode-fixture.ts";

await test("CLV-212 saved opencode runs develop-prompt and status retains report and total tokens", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const config = join(fixture.root, "config");
    await mkdir(join(config, "cloving/projects"), { recursive: true });
    const program = fakeOpencode({ directory: fixture.root });
    await writeFile(
      privateSettingsPath({ XDG_CONFIG_HOME: config }, fixture.repository),
      JSON.stringify({
        version: 1,
        harness: { name: "opencode", kind: "file", path: program },
      }),
    );
    const daemon = await fixture.start({
      XDG_CONFIG_HOME: config,
      CLOVING_CLAUDE_COMMAND: "must-be-ignored",
      CLOVING_CODEX_COMMAND: "must-be-ignored",
    });
    try {
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop-prompt",
          source: "prompt",
          submission: { prompt: "Make an opencode change." },
          commandId: "saved-opencode",
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
      assert.ok(String(field(decision, "prompt")).includes(opencodeReport));
      const status = await call(fixture, {
        operation: "status",
        parameters: { runId },
      });
      const turn = items(field(status["run"], "workerTurns"))[0];
      assert.equal(field(turn, "harness"), "opencode");
      assert.deepEqual(field(turn, "usage"), {
        input_tokens: 300,
        cache_read_input_tokens: 100,
        output_tokens: 62,
      });
      assert.deepEqual(field(status["run"], "usage"), field(turn, "usage"));
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
