import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { redGreen, runs, testFile, withRedGreen } from "./red-green-fixture.ts";

await test("CLV-248 the built CLI includes and starts the red-green tool", () =>
  withRedGreen(
    {
      red: { status: 1, output: "ERR_ASSERTION" },
      green: { status: 0, output: "passed" },
    },
    (scene) => {
      const result = redGreen(scene, {
        entry: join(candidatePackageRoot, "dist/src/cli.js"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        verdict: "accepted",
        base: scene.base,
        head: scene.head,
        files: [testFile],
        output: "passed",
      });
      assert.deepEqual(runs(scene), [
        { phase: "red", files: [testFile] },
        { phase: "green", files: [testFile] },
      ]);
    },
  ));
