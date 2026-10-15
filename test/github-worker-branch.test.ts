import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import { journalKey, until } from "./claude-worker-fixture.ts";
import {
  githubIntent,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const signal = new AbortController().signal;

function observed(scene: GithubScene): {
  readonly calls: string;
  readonly gh: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
} {
  const commands = join(scene.directory, "commands");
  const calls = join(scene.directory, "command-calls");
  mkdirSync(commands);
  for (const name of ["git", "gh"]) {
    const script = join(commands, name);
    writeFileSync(
      script,
      '#!/bin/sh\nprintf "called\\n" >> "$COMMAND_CALLS"\nexit 1\n',
    );
    chmodSync(script, 0o755);
  }
  writeFileSync(calls, "");
  return {
    calls,
    gh: [join(commands, "gh")],
    environment: { PATH: commands, COMMAND_CALLS: calls },
  };
}

await test("CLV-088 every GitHub method refuses branch targets before calling git or gh", () =>
  withGithub(async (scene) => {
    const { calls, gh, environment } = observed(scene);
    const worker = scene.worker({
      gh,
      environment,
      document: () => Promise.resolve("{}"),
    });
    for (const method of methods.keys()) {
      assert.deepEqual(
        await worker.deliver(
          githubIntent({
            method,
            target: "branch:feature-search",
            operationId: `operation-${method}`,
          }),
          signal,
        ),
        { kind: "failed", reason: "branch-target-not-supported" },
      );
    }
    assert.equal(readFileSync(calls, "utf8"), "");
    assert.equal(existsSync(scene.journal), false);
  }));

await test("CLV-088 a GitHub restart refuses a journaled branch target before calling git or gh", () =>
  withGithub(async (scene) => {
    const { calls, gh, environment } = observed(scene);
    const operationId = "operation-kept";
    const folder = join(scene.journal, journalKey(operationId));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "started.json"),
      JSON.stringify({
        ...githubIntent({
          operationId,
          method: "prepare",
          target: "branch:feature-search",
        }),
        payloadText: "{}",
      }),
    );
    const worker = scene.unscanned({ gh, environment });
    await worker.scan();
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      [scene.reports[0]?.outcome, scene.reports[0]?.reason],
      ["failed", "branch-target-not-supported"],
    );
    assert.equal(readFileSync(calls, "utf8"), "");
  }));
