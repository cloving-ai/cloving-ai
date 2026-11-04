import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { themeList, type ThemeFolders } from "../src/cli/theme-folders.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { withThemeData, workshopTheme } from "./theme-check-fixture.ts";

const bench = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

function themeFiles(
  folder: string,
  theme: Fields = workshopTheme(),
): Readonly<Record<string, string>> {
  return {
    [`${folder}/theme.json`]: JSON.stringify(theme),
    [`${folder}/assets/bench.svg`]: bench,
  };
}

function folders(root: string): ThemeFolders {
  return {
    project: join(root, "project"),
    user: join(root, "user"),
    builtIn: join(root, "built-in"),
  };
}

function listed(files: Readonly<Record<string, string>>) {
  return withFiles(files, (root) => themeList(folders(root)));
}

await test("CLV-290 a valid project theme folder is usable with no refusal code", async () => {
  assert.deepEqual(await listed(themeFiles("project/workshop")), [
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
});

await test("CLV-290 a project theme replaces a user theme and a built-in theme of the same name", async () => {
  const themes = await listed({
    ...themeFiles("built-in/workshop"),
    ...themeFiles("user/workshop", withThemeData({ name: "User shop" })),
    ...themeFiles("project/workshop", withThemeData({ name: "Team shop" })),
    ...themeFiles("user/plain", withThemeData({ name: "Plain" })),
    ...themeFiles("built-in/plain"),
  });
  assert.deepEqual(
    themes.map((theme) => [
      theme.name,
      theme.place,
      theme.title,
      theme.replaces,
    ]),
    [
      ["plain", "user", "Plain", ["built-in"]],
      ["workshop", "project", "Team shop", ["user", "built-in"]],
    ],
  );
});

await test("CLV-290 a refused project theme still replaces a valid user theme", async () => {
  const [theme] = await listed({
    ...themeFiles("user/workshop"),
    "project/workshop/theme.json": "{",
  });
  assert.deepEqual(theme, {
    name: "workshop",
    place: "project",
    title: null,
    colorScheme: null,
    usable: false,
    codes: ["invalid-theme-json"],
    replaces: ["user"],
  });
});

async function refusal(
  prepare: (root: string) => Promise<void>,
  files: Readonly<Record<string, string>> = themeFiles("project/workshop"),
): Promise<readonly (string | boolean)[]> {
  return withFiles(files, async (root) => {
    await prepare(root);
    const themes = await themeList(folders(root));
    return themes.flatMap((theme) => [
      theme.name,
      theme.usable,
      ...theme.codes,
    ]);
  });
}

const nothing = (): Promise<void> => Promise.resolve();

await test("CLV-290 a theme folder with no theme.json gives missing-theme-file", async () => {
  assert.deepEqual(
    await refusal(nothing, { "project/workshop/assets/bench.svg": bench }),
    ["workshop", false, "missing-theme-file"],
  );
});

await test("CLV-290 a theme.json larger than 256 KB gives theme-file-too-large", async () => {
  const resized = (root: string) =>
    truncate(join(root, "project/workshop/theme.json"), 262_145);
  assert.deepEqual(await refusal(resized), [
    "workshop",
    false,
    "theme-file-too-large",
  ]);
});

await test("CLV-290 a missing asset gives missing-asset", async () => {
  assert.deepEqual(
    await refusal(nothing, {
      "project/workshop/theme.json": JSON.stringify(workshopTheme()),
    }),
    ["workshop", false, "missing-asset"],
  );
});

await test("CLV-290 an asset larger than 512 KB gives asset-too-large", async () => {
  const resized = (root: string) =>
    truncate(join(root, "project/workshop/assets/bench.svg"), 524_289);
  assert.deepEqual(await refusal(resized), [
    "workshop",
    false,
    "asset-too-large",
  ]);
});

await test("CLV-290 an SVG asset with a script gives svg-script", async () => {
  const scripted = (root: string) =>
    writeFile(
      join(root, "project/workshop/assets/bench.svg"),
      "<svg><script>alert(1)</script></svg>",
    );
  assert.deepEqual(await refusal(scripted), ["workshop", false, "svg-script"]);
});

await test("CLV-290 an asset link to a file outside the assets folder gives invalid-asset-path", async () => {
  const linked = async (root: string) => {
    const asset = join(root, "project/workshop/assets/bench.svg");
    await writeFile(join(root, "outside.svg"), bench);
    await mkdir(join(root, "project/workshop/assets"), { recursive: true });
    await rm(asset);
    await symlink(join(root, "outside.svg"), asset);
  };
  assert.deepEqual(await refusal(linked), [
    "workshop",
    false,
    "invalid-asset-path",
  ]);
});

await test("CLV-290 an asset folder gives missing-asset", async () => {
  const folder = async (root: string) => {
    const asset = join(root, "project/workshop/assets/bench.svg");
    await rm(asset);
    await mkdir(asset);
  };
  assert.deepEqual(await refusal(folder), ["workshop", false, "missing-asset"]);
});

await test("CLV-290 a folder name that is not a theme name gives invalid-folder-name", async () => {
  assert.deepEqual(await refusal(nothing, themeFiles("project/Work_Shop")), [
    "Work_Shop",
    false,
    "invalid-folder-name",
  ]);
});

await test("CLV-290 a theme folder named auto gives reserved-theme-name", async () => {
  assert.deepEqual(await refusal(nothing, themeFiles("project/auto")), [
    "auto",
    false,
    "reserved-theme-name",
  ]);
});

await test("CLV-290 a theme folder link gives invalid-theme-folder", async () => {
  const linked = (root: string) =>
    symlink(join(root, "user/workshop"), join(root, "project/linked"));
  assert.deepEqual(
    await refusal(linked, {
      ...themeFiles("user/workshop"),
      "project/file.txt": "",
    }),
    ["linked", false, "invalid-theme-folder", "workshop", true],
  );
});

await test("CLV-290 places with no theme folder give no themes", async () => {
  assert.deepEqual(await listed({}), []);
});

await test("CLV-290 an assets folder link to a folder outside the theme gives invalid-asset-path", async () => {
  const linked = async (root: string) => {
    const assets = join(root, "project/workshop/assets");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/bench.svg"), bench);
    await rm(assets, { recursive: true });
    await symlink(join(root, "outside"), assets);
  };
  assert.deepEqual(await refusal(linked), [
    "workshop",
    false,
    "invalid-asset-path",
  ]);
});

await test("CLV-290 an assets folder with no art file gives missing-asset", async () => {
  assert.deepEqual(
    await refusal(nothing, {
      "project/workshop/theme.json": JSON.stringify(workshopTheme()),
      "project/workshop/assets/other.svg": bench,
    }),
    ["workshop", false, "missing-asset"],
  );
});

await test("CLV-290 a place that is a file and hidden folders give no themes", async () => {
  assert.deepEqual(
    await listed({
      project: "",
      ...themeFiles("user/.hidden"),
    }),
    [],
  );
});

async function lockedRefusal(locked: string): Promise<readonly unknown[]> {
  return withFiles(
    { ...themeFiles("project/workshop"), ...themeFiles("user/plain") },
    async (root) => {
      const path = join(root, "project/workshop", locked);
      await chmod(path, 0o000);
      try {
        const themes = await themeList(folders(root));
        return themes.map((theme) => [theme.name, theme.usable, theme.codes]);
      } finally {
        await chmod(path, 0o700);
      }
    },
  );
}

for (const locked of ["theme.json", "assets/bench.svg", "."])
  await test(`CLV-290 an unreadable ${locked} gives unreadable-file and the list continues`, async () => {
    assert.deepEqual(await lockedRefusal(locked), [
      ["plain", true, []],
      ["workshop", false, ["unreadable-file"]],
    ]);
  });
