import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { themeAsset, watchThemes } from "../src/cli/watch-themes.ts";
import { pageDocument } from "../src/cli/watch-page.ts";
import { watchServer } from "../src/cli/watch-server.ts";
import { workshopTheme } from "./theme-check-fixture.ts";
import { themeScene } from "./watch-theme-fixture.ts";
import { writeTheme } from "./theme-scene-fixture.ts";
import { watching } from "./watch-fixture.ts";

await test("CLV-291 the watch themes list each theme, with a CSS rule, art classes and words for each usable theme", async () => {
  await using folders = await themeScene();
  const themes = await watchThemes({ setting: "workshop", folders });
  assert.equal(themes.setting, "workshop");
  assert.equal(themes.failure, null);
  assert.deepEqual(themes.themes, [
    {
      name: "broken",
      title: "Workshop",
      colorScheme: "light",
      usable: false,
      codes: ["invalid-color"],
      classes: [],
      words: {},
    },
    {
      name: "plain",
      title: "Plain",
      colorScheme: "dark",
      usable: true,
      codes: [],
      classes: [],
      words: {},
    },
    {
      name: "workshop",
      title: "Workshop",
      colorScheme: "light",
      usable: true,
      codes: [],
      classes: ["art-station"],
      words: { "completed.unit": { one: "shoe", other: "shoes" } },
    },
  ]);
  assert.match(
    themes.style,
    /^:root\[data-theme="plain"\] \{ color-scheme: dark; --color-state-running: #7A1FA2; \}\n:root\[data-theme="workshop"\] \{ color-scheme: light; [^}]*--color-state-running: color\(srgb 0\.122 0\.616 0\.333\);[^}]*\}$/,
  );
  assert.doesNotMatch(themes.style, /broken/);
});

await test("CLV-291 an unreadable theme place gives no themes and the reason", async () => {
  await using folders = await themeScene();
  await chmod(folders.user, 0o000);
  const themes = await watchThemes({ setting: "auto", folders });
  assert.deepEqual(themes.themes, []);
  assert.equal(themes.style, "");
  assert.match(themes.failure ?? "", /^unreadable-theme-folder: /);
  assert.equal(
    await themeAsset(folders, { name: "workshop", path: "assets/bench.svg" }),
    null,
  );
});

await test("CLV-291 the watch themes give only the art files that a usable theme sets", async () => {
  await using folders = await themeScene();
  const bench = await themeAsset(folders, {
    name: "workshop",
    path: "assets/bench.svg",
  });
  assert.deepEqual(
    bench,
    await readFile(join(folders.project, "workshop/assets/bench.svg")),
  );
  for (const request of [
    { name: "workshop", path: "assets/other.svg" },
    { name: "workshop", path: "theme.json" },
    { name: "broken", path: "assets/bench.svg" },
    { name: "missing", path: "assets/bench.svg" },
  ])
    assert.equal(
      await themeAsset(folders, request),
      null,
      JSON.stringify(request),
    );
});

await test("CLV-291 the watch server puts the theme rules and data in the page and serves the art files of the themes", async () => {
  await using folders = await themeScene();
  const runtime = join(folders.root, "run");
  const ready = Promise.withResolvers<string>();
  const stopped = Promise.withResolvers<undefined>();
  const finished = watchServer({
    runtimeDirectory: runtime,
    port: 0,
    client: "codex",
    themes: { setting: "workshop", folders },
    announce: (text) => {
      ready.resolve(/(http:\/\/127\.0\.0\.1:\d+\/)/.exec(text)?.[1] ?? "");
    },
    complain: (text) => {
      ready.reject(new Error(text));
    },
    stopped: stopped.promise,
  });
  try {
    const address = await ready.promise;
    const page = await (await fetch(address)).text();
    assert.match(
      page,
      /<style id="theme-style">[^<]*:root\[data-theme="workshop"\] \{/,
    );
    assert.match(page, /const themes = \{"setting":"workshop",/);
    const art = await fetch(`${address}themes/workshop/assets/bench.svg`);
    assert.equal(art.status, 200);
    assert.equal(art.headers.get("content-type"), "image/svg+xml");
    assert.match(
      art.headers.get("content-security-policy") ?? "",
      /default-src 'none'/,
    );
    assert.equal(
      await art.text(),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    );
    for (const path of [
      "themes/workshop/assets/other.svg",
      "themes/broken/assets/bench.svg",
      "themes/workshop/assets/../theme.json",
      "themes/workshop/theme.json",
    ]) {
      const refused = await fetch(`${address}${path}`);
      assert.equal(refused.status, 404, path);
      await refused.arrayBuffer();
    }
  } finally {
    stopped.resolve(undefined);
    await finished;
  }
});

await test("CLV-291 a theme document with a script end tag in a word cannot close the page script", async () => {
  await using folders = await themeScene();
  const theme = workshopTheme();
  await writeTheme(join(folders.project, "workshop"), theme);
  const themes = await watchThemes({ setting: "</script><b>", folders });
  const page = pageDocument(null, themes);
  assert.equal(page.split("</script>").length, 2);
  assert.match(page, /"setting":"\\u003c\/script>\\u003cb>"/);
});

await test("CLV-291 cloving watch uses the watch.theme setting and the theme folders of the repository", async () => {
  await using folders = await themeScene();
  const repository = join(folders.root, "repository");
  execFileSync("git", ["init", "--quiet", repository]);
  await writeTheme(join(repository, ".cloving/themes/workshop"));
  const watch = await watching(join(folders.root, "run"), {
    directory: repository,
    environment: {
      CLOVING_WATCH_THEME: "workshop",
      XDG_CONFIG_HOME: join(folders.root, "config"),
    },
  });
  try {
    const page = await (await fetch(watch.address)).text();
    assert.match(page, /const themes = \{"setting":"workshop",/);
    for (const name of ["dark", "light", "workshop"])
      assert.ok(page.includes(`:root[data-theme="${name}"] {`), name);
    const art = await fetch(`${watch.address}themes/workshop/assets/bench.svg`);
    assert.equal(art.status, 200);
    await art.arrayBuffer();
  } finally {
    await watch.stop();
  }
});
