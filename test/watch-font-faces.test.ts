import assert from "node:assert/strict";
import { test } from "node:test";
import { pageDocument } from "../src/cli/watch-page.ts";

await test("CLV-130 CLV-292 nineteen packaged Latin font faces use fixed local URLs and swap while loading", () => {
  const page = pageDocument();
  const rules = [...page.matchAll(/@font-face\s*\{([^}]+)\}/g)];
  const expected = [
    ["Barlow", "barlow", [400, 500, 600, 700]],
    ["Barlow Semi Condensed", "barlow-semi-condensed", [700]],
    ["Fira Code", "fira-code", [400, 500]],
    ["Heebo", "heebo", [500, 700, 800]],
    ["Pixelify Sans", "pixelify-sans", [400, 500, 600, 700]],
    ["Silkscreen", "silkscreen", [700]],
    ["Space Grotesk", "space-grotesk", [400, 500, 600, 700]],
  ] as const;
  assert.equal(rules.length, 19);
  const declarations = rules.map((rule) =>
    rule[1]?.replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(
    declarations,
    expected.flatMap(([family, file, weights]) =>
      weights.map(
        (weight) =>
          `font-family: "${family}"; font-style: normal; font-weight: ${String(weight)}; font-display: swap; src: url("/watch-fonts-v1/${file}-latin-${String(weight)}-normal.woff2") format("woff2");`,
      ),
    ),
  );
  assert.doesNotMatch(
    page,
    /local\(|fonts\.googleapis|fonts\.gstatic|media="print"|onload=|blocking="render"/,
  );
});
