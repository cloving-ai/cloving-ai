import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";

await test("CLV-205 start reads the shared before-merge command into daemon settings", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    await mkdir(join(fixture.repository, ".cloving"));
    await writeFile(
      join(fixture.repository, ".cloving/config.json"),
      JSON.stringify({ version: 1, checks: { beforeMerge: ["npm", "test"] } }),
    );
    const child = await fixture.start({ CLOVING_CHECK_COMMAND: undefined });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(
        launcher.includes('\\"checkCommand\\":[\\"npm\\",\\"test\\"]'),
        launcher,
      );
    } finally {
      assert.equal(await ended(child), 0);
    }
  }));

await test("CLV-205 start reads inline private profiles and reports setting sources", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const id = createHash("sha256")
      .update(fixture.repository)
      .digest("hex")
      .slice(0, 8);
    const config = join(fixture.root, "config");
    await mkdir(join(config, "cloving/projects"), { recursive: true });
    await writeFile(
      join(config, "cloving/projects", `repository-${id}.json`),
      JSON.stringify({
        version: 1,
        profiles: { checker: { model: "test-model" } },
        harness: { kind: "file", path: "agent" },
      }),
    );
    const child = await fixture.start({
      XDG_CONFIG_HOME: config,
      CLOVING_PROFILES: undefined,
    });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(
        launcher.includes(
          '\\"profiles\\":{\\"checker\\":{\\"model\\":\\"test-model\\"}}',
        ),
        launcher,
      );
      assert.match(launcher, /profiles: private/);
    } finally {
      assert.equal(await ended(child), 0);
    }
  }));

import { spawnSync } from "node:child_process";

await test("CLV-205 invalid project settings stop start before preparing the daemon", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    await mkdir(join(fixture.repository, ".cloving"));
    for (const [settings, error] of [
      [
        { privateTexts: ["acme"] },
        "private-setting-in-project-file: privateTexts",
      ],
      [{ queue: { lane: 2 } }, "unknown-setting: queue.lane"],
      [
        { workflows: { folder: "/srv/workflows" } },
        "private-setting-in-project-file: workflows",
      ],
      [
        { checks: { beforeMerge: "npm test" } },
        "invalid-setting: checks.beforeMerge",
      ],
    ] as const) {
      await writeFile(
        join(fixture.repository, ".cloving/config.json"),
        JSON.stringify({ version: 1, ...settings }),
      );
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dirname, "../src/cli.ts"), "start"],
        {
          cwd: fixture.repository,
          env: {
            ...process.env,
            CLOVING_RUNTIME_DIR: fixture.runtimeDirectory,
          },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stderr.includes(error), result.stderr);
    }
  }));
