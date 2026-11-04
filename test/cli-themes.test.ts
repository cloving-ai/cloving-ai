import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withDoctor } from "./doctor-fixture.ts";
import { items } from "./service-fixture.ts";
import { withThemeData } from "./theme-check-fixture.ts";
import {
  cloving,
  projectThemes,
  userThemes,
  writeTheme,
} from "./theme-scene-fixture.ts";

const builtIn = [
  {
    name: "dark",
    place: "built-in",
    title: "Cloving dark",
    colorScheme: "dark",
    usable: true,
    codes: [],
    replaces: [],
  },
  {
    name: "light",
    place: "built-in",
    title: "Cloving light",
    colorScheme: "light",
    usable: true,
    codes: [],
    replaces: [],
  },
];

await test("CLV-290 themes list shows a valid project theme with no refusal code and the built-in themes", () =>
  withDoctor(async (scene) => {
    await writeTheme(join(projectThemes(scene), "workshop"));
    const listed = await cloving(scene, ["themes", "list", "--json"]);
    assert.equal(listed.status, 0);
    assert.equal(listed.stderr, "");
    assert.deepEqual(JSON.parse(listed.stdout), [
      ...builtIn,
      {
        name: "workshop",
        place: "project",
        title: "Workshop",
        colorScheme: "light",
        usable: true,
        codes: [],
        replaces: [],
      },
    ]);
    const shown = await cloving(scene, ["themes", "list"]);
    assert.equal(
      shown.stdout,
      'dark (built-in, usable) "Cloving dark"\nlight (built-in, usable) "Cloving light"\nworkshop (project, usable) "Workshop"\n',
    );
  }));

await test("CLV-290 themes list shows that a refused project theme replaces a user theme of the same name", () =>
  withDoctor(async (scene) => {
    await writeTheme(join(userThemes(scene), "light"));
    await writeTheme(
      join(projectThemes(scene), "light"),
      withThemeData({ name: "url(x)" }),
    );
    await mkdir(join(projectThemes(scene), "Bad\u001b[31m"), {
      recursive: true,
    });
    const listed = await cloving(scene, ["themes", "list", "--json"]);
    assert.deepEqual(items(JSON.parse(listed.stdout))[2], {
      name: "light",
      place: "project",
      title: "url(x)",
      colorScheme: "light",
      usable: false,
      codes: ["css-text"],
      replaces: ["user", "built-in"],
    });
    const shown = await cloving(scene, ["themes", "list"]);
    assert.equal(
      shown.stdout,
      'Bad\\u001b[31m (project, refused: invalid-folder-name, missing-theme-file)\ndark (built-in, usable) "Cloving dark"\nlight (project, refused: css-text; replaces user, built-in) "url(x)"\n',
    );
  }));

await test("CLV-290 themes help shows the list command and the setting", () =>
  withDoctor(async (scene) => {
    const help = await cloving(scene, ["themes", "--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: cloving themes list \[--json\]/);
    assert.match(help.stdout, /watch\.theme/);
    const main = await cloving(scene, ["--help"]);
    assert.match(main.stdout, /\n {2}themes list {9}List the themes/);
  }));

for (const [argumentsList, code] of [
  [["themes"], "missing-argument"],
  [["themes", "show"], "unknown-command"],
  [["themes", "list", "extra"], "unexpected-argument"],
  [["themes", "list", "--follow"], "unexpected-option"],
] as const)
  await test(`CLV-290 cloving ${argumentsList.join(" ")} gives ${code}`, () =>
    withDoctor(async (scene) => {
      const refused = await cloving(scene, [...argumentsList, "--json"]);
      assert.equal(refused.status, 2);
      assert.deepEqual(JSON.parse(refused.stdout), {
        schemaVersion: 1,
        kind: "usage-error",
        code,
      });
    }));

await test("CLV-290 themes list outside a repository gives repository-unknown", () =>
  withDoctor(async (scene) => {
    const outside = join(scene.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "file"), "");
    const refused = await cloving({ ...scene, repository: outside }, [
      "themes",
      "list",
    ]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^repository-unknown: /);
  }));

await test("CLV-290 themes list with an unreadable place folder gives unreadable-theme-folder", () =>
  withDoctor(async (scene) => {
    await mkdir(projectThemes(scene), { recursive: true });
    await chmod(projectThemes(scene), 0o000);
    try {
      const refused = await cloving(scene, ["themes", "list"]);
      assert.equal(refused.status, 1);
      assert.equal(refused.stdout, "");
      assert.match(
        refused.stderr,
        /^unreadable-theme-folder: EACCES: permission denied, scandir '[^\n]+'\n$/,
      );
    } finally {
      await chmod(projectThemes(scene), 0o755);
    }
  }));
