import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { check, withDoctor, type DoctorScene } from "./doctor-fixture.ts";
import { withThemeData } from "./theme-check-fixture.ts";
import { projectThemes, writeTheme } from "./theme-scene-fixture.ts";

async function selected(scene: DoctorScene, theme: string): Promise<void> {
  const file = privateSettingsPath(scene.environment, scene.repository);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, watch: { theme } }));
}

await test("CLV-290 doctor reports a refused theme that watch.theme selects", () =>
  withDoctor(async (scene) => {
    await writeTheme(
      join(projectThemes(scene), "workshop"),
      withThemeData({ words: { "board.sparkle": "url(x)" } }),
    );
    await selected(scene, "workshop");
    const output = await scene.report();
    assert.deepEqual(check(output, "theme"), {
      code: "theme",
      required: false,
      fix: "See the refusal codes: cloving themes list; fix the theme folder, or select another theme: cloving config set watch.theme auto",
      result: "fail",
      detail:
        "watch.theme workshop: the project theme is refused: css-text, unknown-word",
    });
  }));

await test("CLV-290 doctor reports a missing theme that watch.theme selects", () =>
  withDoctor(async (scene) => {
    const output = await scene.report({ CLOVING_WATCH_THEME: "garage" });
    const reported = check(output, "theme");
    assert.equal(reported["result"], "fail");
    assert.equal(
      reported["detail"],
      "watch.theme garage: no theme folder has this name",
    );
  }));

await test("CLV-290 doctor accepts a usable selected theme and the default auto", () =>
  withDoctor(async (scene) => {
    await writeTheme(join(projectThemes(scene), "workshop"));
    const usable = check(
      await scene.report({ CLOVING_WATCH_THEME: "workshop" }),
      "theme",
    );
    assert.equal(usable["result"], "ok");
    assert.equal(
      usable["detail"],
      'watch.theme workshop: the project theme "Workshop"',
    );
    const builtIn = check(
      await scene.report({ CLOVING_WATCH_THEME: "floor-at-night" }),
      "theme",
    );
    assert.equal(
      builtIn["detail"],
      'watch.theme floor-at-night: the built-in theme "Floor at night"',
    );
    const automatic = check(await scene.report(), "theme");
    assert.equal(automatic["result"], "ok");
    assert.equal(automatic["detail"], "watch.theme auto");
  }));

await test("CLV-290 doctor skips the theme check when the settings files are invalid", () =>
  withDoctor(async (scene) => {
    await mkdir(join(scene.repository, ".cloving"), { recursive: true });
    await writeFile(join(scene.repository, ".cloving/config.json"), "{");
    const skipped = check(await scene.report(), "theme");
    assert.equal(skipped["result"], "skip");
    assert.equal(skipped["detail"], "Settings files are invalid");
  }));

await test("CLV-290 doctor reports a theme folder that it cannot read", () =>
  withDoctor(async (scene) => {
    await mkdir(projectThemes(scene), { recursive: true });
    await chmod(projectThemes(scene), 0o000);
    try {
      const output = await scene.report({ CLOVING_WATCH_THEME: "workshop" });
      const reported = check(output, "theme");
      assert.equal(reported["result"], "fail");
      assert.match(
        String(reported["detail"]),
        /^watch\.theme workshop: unreadable-theme-folder: EACCES: /,
      );
    } finally {
      await chmod(projectThemes(scene), 0o755);
    }
  }));
