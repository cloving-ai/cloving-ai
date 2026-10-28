import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { scene, withoutChildren } from "./self-host-fixture.ts";
import { stopChild } from "./stop-child.ts";
import { watching } from "./watch-fixture.ts";
import {
  operatorRestart,
  settledOperatorSegments,
} from "./operator-restart-fixture.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { withHarness } from "./service-fixture.ts";

await test("CLV-154 restart fixture rejects non-object run JSON", () =>
  withHarness(async (fixture) => {
    const folder = join(dirname(fixture.runtimeDirectory), "world/runs");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "invalid.json"), "[]");
    await assert.rejects(
      settledOperatorSegments({
        root: fixture.stateDirectory,
        repository: fixture.projectDirectory,
        runtimeDirectory: fixture.runtimeDirectory,
      }),
      {
        name: "AssertionError",
        message: "Operator run must be a JSON object.",
      },
    );
  }));

await test("CLV-154 operator admission, refusal reporting and unchanged-source continuations survive daemon restart", () =>
  withoutChildren(async () => {
    const fixture = await scene(
      'throw new Error("unexpected-effect");',
      join(candidatePackageRoot, "src/cli.ts"),
    );
    await operatorRestart(fixture, async () => {
      const child = await fixture.start({
        XDG_CONFIG_HOME: join(fixture.root, "config"),
        CLOVING_SELF_UPDATE_SECONDS: undefined,
        CLOVING_NOTIFY_COMMAND: "[]",
      });
      const watch = await watching(fixture.runtimeDirectory);
      return {
        address: watch.address,
        stop: async () => {
          assert.equal(await watch.stop(), 0);
          await stopChild(child);
          assert.equal(child.exitCode, 0);
        },
      };
    });
  }));
