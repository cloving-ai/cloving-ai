import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedTheme } from "../src/theme-check.ts";
import { workshopTheme } from "./theme-check-fixture.ts";

await test("CLV-290 the example Workshop theme has no refusal code", () => {
  const checked = checkedTheme(workshopTheme());
  assert.deepEqual(checked, {
    codes: [],
    title: "Workshop",
    colorScheme: "light",
    assets: ["assets/bench.svg"],
  });
});
