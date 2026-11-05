import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { artSlots } from "../src/theme-art.ts";
import { svgElements } from "../src/theme-svg.ts";
import { themeTokens } from "../src/theme-tokens.ts";
import { themeWords } from "../src/theme-words.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const section = readme.slice(
  readme.indexOf("#### Themes of the watch page"),
  readme.indexOf("### Use Cloving from an MCP client"),
);

await test("CLV-290 the README names each token, art slot and word key of the theme check", () => {
  const names = [
    ...Object.keys(themeTokens),
    ...artSlots,
    ...Object.keys(themeWords),
    ...svgElements,
  ];
  assert.ok(names.length > 80);
  assert.deepEqual(
    names.filter((name) => !section.includes(`\`${name}\``)),
    [],
  );
});

await test("CLV-291 the README explains how the watch page applies the selected theme", () => {
  for (const text of [
    "`--color-state-running`",
    "`--shape-cut`",
    "`art-station`",
    "`art-station-mask`",
    "`--art-station`",
    "`--art-station-repeat`",
    "`--art-station-rendering`",
    "theme menu",
    "The page uses the default theme",
  ])
    assert.ok(section.includes(text), text);
  assert.doesNotMatch(section, /does not apply a theme yet/);
});

await test("CLV-292 the README shows the three built-in themes and points to the theme format", () => {
  for (const text of [
    "`floor`",
    "`floor-at-night`",
    "`workshop`",
    "![Floor](",
    "![Floor at night](",
    "![Workshop](",
    "](#the-theme-format)",
    "##### The theme format",
    "SIL Open Font License",
  ])
    assert.ok(section.includes(text), text);
  assert.doesNotMatch(section, /`light` and `dark`|built-in theme `light`/);
});
