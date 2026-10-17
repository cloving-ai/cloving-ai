import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimatedCostUsd,
  parseTokenPrices,
  priceForModel,
  commandModel,
} from "../src/token-prices.ts";

const usage = {
  input_tokens: 1_000_000,
  cache_read_input_tokens: 400_000,
  output_tokens: 100_000,
};
const price = { input: 2, cachedInput: 0.5, output: 8 };

await test("CLV-105 estimates Codex inclusive cache and Claude additive cache at operator prices", () => {
  assert.equal(estimatedCostUsd(usage, { worker: "codex", price }), 2.2);
  assert.equal(estimatedCostUsd(usage, { worker: "claude", price }), 3);
});

await test("CLV-105 model prices require an explicit known model and setting", () => {
  const prices = parseTokenPrices(JSON.stringify({ model: price }));
  assert.deepEqual(priceForModel(prices, "model"), price);
  for (const model of [null, "", "missing", "toString", "constructor"])
    assert.equal(priceForModel(prices, model), undefined);
  assert.equal(priceForModel(parseTokenPrices(undefined), "model"), undefined);
  assert.deepEqual(parseTokenPrices("{}"), {});
});

await test("CLV-105 model arguments support long, short and equals forms and stop at the prompt separator", () => {
  for (const argumentsList of [
    ["--model", "model"],
    ["-m", "model"],
    ["--model=model"],
    ["--model", "old", "--model=model"],
  ])
    assert.equal(commandModel(["worker", ...argumentsList]), "model");
  for (const argumentsList of [
    [],
    ["--model"],
    ["--model="],
    ["--model", "--json"],
    ["--", "--model", "model"],
  ])
    assert.equal(commandModel(["worker", ...argumentsList]), null);
});

await test("CLV-105 invalid token price settings fail with the setting name", () => {
  for (const invalid of [
    "",
    "{",
    "null",
    "[]",
    "3",
    '"text"',
    '{"model":null}',
    '{"model":[]}',
    '{"model":{}}',
    ...[-1, "1", null, true].map((input: unknown) =>
      JSON.stringify({ model: { ...price, input } }),
    ),
    '{"model":{"input":1e400,"cachedInput":0,"output":1}}',
  ])
    assert.throws(() => parseTokenPrices(invalid), /CLOVING_TOKEN_PRICES/);
});

await test("CLV-105 missing prices and unknown token counts have no estimate", () => {
  assert.equal(
    estimatedCostUsd(usage, { worker: "codex", price: undefined }),
    null,
  );
  for (const name of Object.keys(usage))
    for (const worker of ["codex", "claude"] as const)
      assert.equal(
        estimatedCostUsd({ ...usage, [name]: null }, { worker, price }),
        null,
      );
});

await test("CLV-105 rejects impossible cache counts and overflow, preserving a zero estimate", () => {
  assert.equal(
    estimatedCostUsd({ ...usage, input_tokens: 1 }, { worker: "codex", price }),
    null,
  );
  assert.equal(
    estimatedCostUsd(
      { ...usage, output_tokens: Number.MAX_SAFE_INTEGER },
      { worker: "claude", price: { ...price, output: Number.MAX_VALUE } },
    ),
    null,
  );
  assert.equal(
    estimatedCostUsd(usage, {
      worker: "codex",
      price: { input: 0, cachedInput: 0, output: 0 },
    }),
    0,
  );
});
