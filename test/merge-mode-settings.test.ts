import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { settingsEnvironment } from "../src/cli/project-settings.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { configurationEntries } from "../src/configuration-display.ts";
import {
  configuration,
  settingScope,
  validateSetting,
} from "../src/configuration-schema.ts";
import { mergeMode } from "../src/merge-mode.ts";
import { refusedStart } from "./cli-start-fixture.ts";
import { check, withDoctor } from "./doctor-fixture.ts";
import { settingsScene } from "./project-settings-fixture.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";

await test("CLV-297 the project file accepts merge.mode direct and queue", () => {
  for (const mode of ["direct", "queue"])
    assert.deepEqual(
      configuration({ version: 1, merge: { mode } }, "project").merge,
      { mode },
    );
  assert.equal(settingScope("merge.mode"), "project");
});

await test("CLV-297 merge.mode refuses a value that is not direct or queue", () => {
  assert.throws(() => {
    validateSetting("merge.mode", "fast");
  }, /invalid-setting: merge\.mode/);
  assert.throws(
    () => configuration({ version: 1, merge: { mode: "fast" } }, "project"),
    /invalid-setting: merge\.mode/,
  );
});

await test("CLV-297 merge.mode becomes CLOVING_MERGE_MODE and has the default direct", () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.project, { version: 1, merge: { mode: "queue" } });
    const environment = settingsEnvironment(
      fixture.environment,
      fixture.repository,
    );
    assert.equal(environment["CLOVING_MERGE_MODE"], "queue");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  const shown = configurationEntries({
    project: undefined,
    private: undefined,
    environment: {},
  }).find((entry) => entry.field === "merge.mode");
  assert.deepEqual([shown?.value, shown?.source], ["direct", "default"]);
});

await test("CLV-297 the start variable gives the merge mode and refuses another value", () => {
  assert.equal(mergeMode(undefined), "direct");
  assert.equal(mergeMode("direct"), "direct");
  assert.equal(mergeMode("queue"), "queue");
  assert.throws(() => mergeMode("fast"), {
    message: "invalid-setting: CLOVING_MERGE_MODE must be direct or queue",
  });
});

await test("CLV-297 start refuses a merge mode that is not direct or queue and names the variable", async () => {
  assert.match(
    await refusedStart({
      CLOVING_MERGE_MODE: "fast",
      CLOVING_SELF_UPDATE_SECONDS: undefined,
    }),
    /invalid-setting: CLOVING_MERGE_MODE must be direct or queue/,
  );
});

await test("CLV-297 start gives the merge mode to the daemon settings", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const child = await fixture.start({ CLOVING_MERGE_MODE: "queue" });
    try {
      const launcher = await readFile(
        join(fixture.directory, "project/main.mjs"),
        "utf8",
      );
      assert.ok(launcher.includes('\\"mergeMode\\":\\"queue\\"'), launcher);
    } finally {
      assert.equal(await ended(child), 0);
    }
  }));

await test("CLV-297 doctor shows the merge mode and fails an invalid merge mode", () =>
  withDoctor(async (doctor) => {
    const shown = check(await doctor.report(), "merge-mode");
    assert.deepEqual(
      [shown["result"], shown["detail"]],
      ["ok", "merge.mode direct"],
    );
    const queued = check(
      await doctor.report({ CLOVING_MERGE_MODE: "queue" }),
      "merge-mode",
    );
    assert.equal(queued["detail"], "merge.mode queue");
    const failed = check(
      await doctor.report({ CLOVING_MERGE_MODE: "fast" }),
      "merge-mode",
    );
    assert.deepEqual(
      [failed["result"], failed["detail"], failed["required"]],
      [
        "fail",
        "invalid-setting: CLOVING_MERGE_MODE must be direct or queue",
        false,
      ],
    );
  }));

await test("CLV-297 start help and the README describe the merge mode", () => {
  const line = String(commandUsage["start"])
    .split("\n")
    .filter((text) => text.startsWith("  CLOVING_MERGE_MODE "));
  assert.equal(line.length, 1);
  assert.match(
    String(line[0]),
    /direct or queue.*default is direct.*merge queue/,
  );
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const fact of [
    /`merge\.mode`/,
    /merge queue rule/,
    /`merge-queue-removed`/,
    /`merge-queue-timeout`/,
    /`enqueuePullRequest`/,
  ])
    assert.match(readme, fact);
});
