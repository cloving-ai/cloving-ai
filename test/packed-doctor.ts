import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { withDoctor } from "./doctor-fixture.ts";
import { fields, items } from "./service-fixture.ts";

export function packedDoctor(root: string): Promise<void> {
  return withDoctor((scene) => {
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/cloving/dist/src/cli.js"), "doctor", "--json"],
      {
        cwd: scene.repository,
        env: scene.environment,
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = fields(JSON.parse(result.stdout));
    assert.equal(report["version"], 1);
    const checks = items(report["checks"]).map(fields);
    assert.equal(checks.length, 15);
    assert.ok(
      checks
        .filter((check) => check["required"])
        .every((check) => check["result"] === "ok"),
    );
    assert.equal(
      checks.find((check) => check["code"] === "runtime-directory")?.["result"],
      "ok",
    );
  });
}
