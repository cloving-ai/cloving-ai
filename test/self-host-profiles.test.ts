import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";

await test("CLV-086 start snapshots profiles once and preserves every allowed profile name in daemon settings", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const file = join(fixture.root, "profiles.json");
    const profiles = {
      ["__proto__"]: {
        env: { TURN_NAME: "{turn}" },
        workflows: ["review-loop"],
      },
      checker: { maxBudgetUsd: 15 },
    };
    writeFileSync(file, JSON.stringify({ profiles }));
    const daemon = await fixture.start({ CLOVING_PROFILES: file });
    assert.equal(await ended(daemon), 0);
    writeFileSync(file, "no longer valid JSON");
    const project = join(fixture.directory, "project");
    writeFileSync(
      join(project, "capture-settings.mjs"),
      `export function startDaemon(settings) {
      console.log(JSON.stringify(settings.profiles));
      return { kind: "refused", reason: "captured", detail: "settings recorded" };
    }`,
    );
    const launcher = readFileSync(join(project, "main.mjs"), "utf8").replace(
      /from "[^"\n]*\/src\/daemon\/daemon\.ts";/,
      'from "./capture-settings.mjs";',
    );
    writeFileSync(join(project, "capture.mjs"), launcher);
    const result = spawnSync(process.execPath, [join(project, "capture.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /settings recorded/);
    const captured: unknown = JSON.parse(result.stdout.trim());
    assert.deepEqual(captured, profiles);
  }));
