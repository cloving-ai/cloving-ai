import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { settingsEnvironment } from "../src/cli/project-settings.ts";
import { configurationEntries } from "../src/configuration-display.ts";
import { configuration, validateSetting } from "../src/configuration-schema.ts";
import { retentionSettings } from "../src/record-retention.ts";
import { settingsScene } from "./project-settings-fixture.ts";

await test("CLV-270 the private file accepts a retention period, an action and an archive folder", () => {
  for (const retention of [
    { days: 1, action: "archive", archiveFolder: "/archive" },
    { days: null, action: "delete", archiveFolder: null },
  ])
    assert.deepEqual(
      configuration({ version: 1, retention }, "private").retention,
      retention,
    );
});

for (const [field, value] of [
  ["retention.days", 0],
  ["retention.days", 1.5],
  ["retention.days", "30"],
  ["retention.action", "move"],
  ["retention.archiveFolder", "archive"],
  ["retention.archiveFolder", 1],
] as const)
  await test(`CLV-270 ${field} refuses ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => {
        validateSetting(field, value);
      },
      new RegExp(`invalid-setting: ${field}`),
    );
  });

await test("CLV-270 the project file refuses the retention settings", () => {
  assert.throws(
    () => configuration({ version: 1, retention: { days: 30 } }, "project"),
    { message: "private-setting-in-project-file: retention" },
  );
});

await test("CLV-270 the private retention settings become start variables", () => {
  const fixture = settingsScene();
  try {
    fixture.write(fixture.privateFile, {
      version: 1,
      retention: { days: null, action: "delete", archiveFolder: "/archive" },
    });
    const environment = settingsEnvironment(
      fixture.environment,
      fixture.repository,
    );
    assert.equal(environment["CLOVING_RETENTION_DAYS"], "null");
    assert.equal(environment["CLOVING_RETENTION_ACTION"], "delete");
    assert.equal(environment["CLOVING_RETENTION_ARCHIVE_FOLDER"], "/archive");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-270 the retention settings have defaults of 30 days, archive and the state archive folder", () => {
  assert.deepEqual(retentionSettings({}), {
    days: 30,
    action: "archive",
    archiveFolder: null,
  });
  const shown = configurationEntries({
    project: undefined,
    private: undefined,
    environment: {},
  }).filter((entry) => entry.field.startsWith("retention."));
  assert.deepEqual(
    shown.map(({ field, value, source }) => [field, value, source]),
    [
      ["retention.days", 30, "default"],
      ["retention.action", "archive", "default"],
      ["retention.archiveFolder", null, "default"],
    ],
  );
});

await test("CLV-270 the start variables give the retention settings", () => {
  assert.deepEqual(
    retentionSettings({
      CLOVING_RETENTION_DAYS: "7",
      CLOVING_RETENTION_ACTION: "delete",
      CLOVING_RETENTION_ARCHIVE_FOLDER: "/archive",
    }),
    { days: 7, action: "delete", archiveFolder: "/archive" },
  );
  assert.deepEqual(
    retentionSettings({
      CLOVING_RETENTION_DAYS: "null",
      CLOVING_RETENTION_ARCHIVE_FOLDER: "null",
    }),
    { days: null, action: "archive", archiveFolder: null },
  );
});

for (const [variable, value] of [
  ["CLOVING_RETENTION_DAYS", "0"],
  ["CLOVING_RETENTION_DAYS", "1.5"],
  ["CLOVING_RETENTION_DAYS", "99999999999999999999"],
  ["CLOVING_RETENTION_ACTION", "move"],
  ["CLOVING_RETENTION_ARCHIVE_FOLDER", "archive"],
] as const)
  await test(`CLV-270 ${variable}=${value} stops the start and names the variable`, () => {
    assert.throws(
      () => retentionSettings({ [variable]: value }),
      new RegExp(`invalid-setting: ${variable}`),
    );
  });
