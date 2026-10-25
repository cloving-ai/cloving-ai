import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommands, parseCommandSeconds } from "../src/command-settings.ts";

await test("CLV-178 reads named argument arrays without interpreting shell syntax", () => {
  const commands = {
    "review-requests": ["/opt/bin/scan", "a b", "$(echo no)", ""],
    constructor: ["/opt/bin/other"],
    ["A".repeat(64)]: ["/scan"],
  };
  assert.deepEqual(parseCommands(JSON.stringify(commands)), commands);
  assert.deepEqual(parseCommands(undefined), {});
  assert.deepEqual(parseCommands("{}"), {});
});

await test("CLV-178 rejects invalid command settings with a fixed code", () => {
  for (const value of [
    "",
    "{",
    "null",
    "[]",
    "true",
    "42",
    '"script"',
    ...["", "a_b", "a/b", "é", "a".repeat(65)].map((name) =>
      JSON.stringify({ [name]: ["/scan"] }),
    ),
    ...[
      null,
      {},
      "scan",
      [],
      ["scan"],
      ["./scan"],
      [""],
      [1],
      ["/scan", 1],
      ["/scan\u0000"],
      ["/scan", "\u0000"],
    ].map((args) => JSON.stringify({ scan: args })),
  ])
    assert.throws(() => parseCommands(value), /^Error: invalid-commands$/);
});

await test("CLV-178 reads a bounded whole-second command deadline", () => {
  assert.equal(parseCommandSeconds(undefined), 60);
  for (const value of ["1", "60", "3600"])
    assert.equal(parseCommandSeconds(value), Number(value));
  for (const value of [
    "",
    "0",
    "3601",
    "-1",
    "1.5",
    "1e2",
    " 60",
    "60 ",
    "Infinity",
    "NaN",
  ])
    assert.throws(
      () => parseCommandSeconds(value),
      /^Error: invalid-command-seconds$/,
    );
});
