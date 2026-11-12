import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function capturedSetting(input: {
  readonly directory: string;
  readonly field: string;
}): unknown {
  const project = join(input.directory, "project");
  writeFileSync(
    join(project, "capture-settings.mjs"),
    `export function startDaemon(settings) {
      console.log(JSON.stringify(settings[${JSON.stringify(input.field)}] ?? null));
      return { kind: "refused", reason: "captured", detail: "settings recorded" };
    }`,
  );
  const launcher = readFileSync(join(project, "main.mjs"), "utf8").replace(
    /from "[^"\n]*\/src\/daemon\/daemon\.(?:ts|js)";/,
    'from "./capture-settings.mjs";',
  );
  writeFileSync(join(project, "capture.mjs"), launcher);
  const result = spawnSync(process.execPath, [join(project, "capture.mjs")], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /settings recorded/);
  return JSON.parse(result.stdout.trim());
}
