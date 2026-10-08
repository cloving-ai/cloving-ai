import assert from "node:assert/strict";
import { test } from "node:test";
import { lintFixture } from "./lint-fixture.ts";

const forms = [
  { name: "function", open: "export function example() {", close: "}" },
  {
    name: "method",
    open: "export class Example {\n  example() {",
    close: "  }\n}",
  },
  { name: "arrow", open: "export const example = () => {", close: "};" },
  { name: "invocation", open: "(() => {", close: "})();" },
];

for (const form of forms) {
  await test(`QG-03 declaration line boundary for ${form.name}`, () => {
    const source = `${form.open}\n${"\n".repeat(57)}return 1;\n${form.close}`;
    const rule = "max-lines-per-function";
    assert.equal(
      lintFixture(source).some((message) => message.ruleId === rule),
      false,
    );
    const exceeded = lintFixture(source.replace("return 1;", "\nreturn 1;"));
    assert.equal(
      exceeded.filter((message) => message.ruleId === rule).length,
      1,
    );
    assert.match(
      exceeded.find((message) => message.ruleId === rule)?.message ?? "",
      /61.*60/,
    );
  });

  await test(`QG-03 statement boundary for ${form.name}`, () => {
    const statements = "1; ".repeat(40);
    const rule = "max-statements";
    const boundary = lintFixture(`${form.open}\n${statements}\n${form.close}`);
    assert.equal(
      boundary.some((message) => message.ruleId === rule),
      false,
    );
    const exceeded = lintFixture(
      `${form.open}\n${statements} 1;\n${form.close}`,
    );
    assert.equal(
      exceeded.filter((message) => message.ruleId === rule).length,
      1,
    );
    assert.match(
      exceeded.find((message) => message.ruleId === rule)?.message ?? "",
      /41.*40/,
    );
  });
}
