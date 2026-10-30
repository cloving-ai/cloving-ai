import assert from "node:assert/strict";
import { test } from "node:test";
import { queueSpending } from "../src/queue-spend.ts";

for (const scenario of [
  {
    name: "decimal addition",
    costs: [0.02, 0.15],
    limit: 0.2,
    spent: 0.17,
    holding: true,
  },
  {
    name: "many small turns",
    costs: Array.from({ length: 170 }, () => 0.1),
    limit: 20,
    spent: 17,
    holding: true,
  },
  {
    name: "sub-cent scientific prices",
    costs: [1e-9, 7e-10],
    limit: 2e-9,
    spent: 1.7e-9,
    holding: true,
  },
  {
    name: "just below threshold",
    costs: [0.16999999999999998],
    limit: 0.2,
    spent: 0.16999999999999998,
    holding: false,
  },
  {
    name: "large scientific prices",
    costs: [1e21, 2.5e20],
    limit: 1e21,
    spent: 1.25e21,
    holding: true,
  },
  { name: "no turns", costs: [], limit: 20, spent: 0, holding: false },
])
  await test(`CLV-241 exact spend arithmetic preserves ${scenario.name}`, () => {
    assert.deepEqual(queueSpending(scenario.costs, scenario.limit), {
      spentUsd: scenario.spent,
      holding: scenario.holding,
    });
  });
