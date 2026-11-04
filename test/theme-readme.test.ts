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
