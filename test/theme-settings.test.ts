import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { settingsEnvironment } from "../src/cli/project-settings.ts";
import { configurationEntries } from "../src/configuration-display.ts";
import { configuration, validateSetting } from "../src/configuration-schema.ts";
import { settingsScene } from "./project-settings-fixture.ts";

await test("CLV-290 the private file accepts a theme name and auto for watch.theme", () => {
  for (const theme of ["auto", "workshop", "pixel-shop-2"])
    assert.deepEqual(
      configuration({ version: 1, watch: { theme } }, "private").watch,
      { theme },
    );
});

for (const value of ["Workshop", "pixel_shop", "-shop", "", "a".repeat(65), 4])
  await test(`CLV-290 watch.theme refuses ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => {
        validateSetting("watch.theme", value);
      },
      { message: "invalid-setting: watch.theme" },
    );
  });

await test("CLV-290 watch.theme is auto by default", () => {
  assert.deepEqual(
    configurationEntries({
      project: undefined,
      private: undefined,
      environment: {},
      field: "watch.theme",
    }),
    [{ field: "watch.theme", value: "auto", source: "default", hidden: [] }],
  );
});

await test("CLV-290 the private watch.theme becomes CLOVING_WATCH_THEME", () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.privateFile, {
      version: 1,
      watch: { theme: "workshop" },
    });
    const environment = settingsEnvironment(
      fixture.environment,
      fixture.repository,
    );
    assert.equal(environment["CLOVING_WATCH_THEME"], "workshop");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
