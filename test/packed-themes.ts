import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { packedEnvironment } from "./packed-daemon-fixture.ts";
import { builtInThemes } from "./theme-scene-fixture.ts";

export const packedThemeFiles = [
  "themes/floor-at-night/theme.json",
  "themes/floor/theme.json",
  "themes/workshop/assets/bench.svg",
  "themes/workshop/assets/bricks.svg",
  "themes/workshop/assets/pennants.svg",
  "themes/workshop/assets/shoe.svg",
  "themes/workshop/assets/tiles.svg",
  "themes/workshop/assets/worker.svg",
  "themes/workshop/theme.json",
];

export function packedThemePaths(paths: readonly string[]): void {
  assert.deepEqual(
    paths.filter((path) => path.startsWith("themes/")).sort(),
    packedThemeFiles,
  );
}

export async function packedThemes(root: string): Promise<void> {
  const listed = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/cloving/dist/src/cli.js"),
      "themes",
      "list",
      "--json",
    ],
    {
      cwd: root,
      env: await packedEnvironment(root),
      encoding: "utf8",
      timeout: 20000,
    },
  );
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), builtInThemes);
}
