import assert from "node:assert/strict";
import { test } from "node:test";
import { oneLine, show, visible } from "../src/cli/terminal-text.ts";

await test("terminal text preserves printable Unicode and serializes data", () => {
  for (const text of ["review-queue", "¡Hola! 🥳", "plain\\text", ""]) {
    assert.equal(show(text), text);
    assert.equal(oneLine(text), text);
    assert.equal(visible(text), text);
  }
  assert.equal(show({ slot: 12 }), '{"slot":12}');
  assert.equal(oneLine(300), "300");
  assert.equal(visible(null), "null");
});

await test("terminal text escapes invisible controls and only indents intentional multiline text", () => {
  const controls =
    "\u0000\u001b\u007f\u009f\u061c\u200b\u200f\u2028\u202e\u2060\u2069\ufeff";
  const escaped =
    "\\u0000\\u001b\\u007f\\u009f\\u061c\\u200b\\u200f\\u2028\\u202e\\u2060\\u2069\\ufeff";
  assert.equal(
    oneLine(`Schedule ${controls}\nnext`),
    `Schedule ${escaped}\\u000anext`,
  );
  assert.equal(
    visible(`Schedule ${controls}\nnext`),
    `Schedule ${escaped}\n    next`,
  );
});
