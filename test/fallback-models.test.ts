import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseFallbackModels,
  replaceCommandModel,
  commandModel,
} from "../src/token-prices.ts";

await test("CLV-139 replaces an explicit model without changing other arguments or the input", () => {
  for (const argumentsList of [
    ["-m", "main"],
    ["--model", "main"],
    ["--model=main"],
  ]) {
    const command = ["worker", "exec", ...argumentsList, "--json", "-"];
    const before = [...command];
    assert.deepEqual(replaceCommandModel(command, "fallback"), [
      "worker",
      "exec",
      ...argumentsList.map((part) => part.replace("main", "fallback")),
      "--json",
      "-",
    ]);
    assert.deepEqual(command, before);
  }
});

await test("CLV-139 fallback lists are optional and preserve up to three explicit model names", () => {
  for (const models of [[], ["one"], ["one", "two", "three"]])
    assert.deepEqual(parseFallbackModels(JSON.stringify(models)), models);
  assert.deepEqual(parseFallbackModels(undefined), []);
});

await test("CLV-139 replacement respects the effective model and the prompt separator", () => {
  const command = [
    "worker",
    "-m",
    "old",
    "--model=main",
    "--",
    "--model",
    "prompt",
  ];
  const changed = replaceCommandModel(command, "fallback");
  assert.deepEqual(changed, [
    "worker",
    "-m",
    "old",
    "--model=fallback",
    "--",
    "--model",
    "prompt",
  ]);
  assert.equal(commandModel(changed), "fallback");
});

await test("CLV-139 leaves commands without an explicit model unchanged", () => {
  for (const argumentsList of [
    [],
    ["exec", "--json", "-"],
    ["--", "--model", "main"],
    ["--model"],
    ["--model="],
    ["-m", "--json"],
    ["-m", "--", "--model=prompt"],
    ["--model", "--", "--model", "prompt"],
  ]) {
    const command = ["worker", ...argumentsList];
    assert.deepEqual(replaceCommandModel(command, "fallback"), command);
  }
});
