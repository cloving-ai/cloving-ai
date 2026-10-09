import assert from "node:assert/strict";
import { test } from "node:test";
import { routeVerificationFailure } from "../../quality/verification-repair.ts";

await test("QG-12 ordinary violations consume the next repair attempt without a decision", () => {
  assert.deepEqual(
    routeVerificationFailure(
      { kind: "ordinary", diagnostics: ["main.ts: max-lines 401 > 400"] },
      { attempts: 1, limit: 4 },
    ),
    { action: "repair", attempt: 2 },
  );
});

await test("QG-12 exhausted repairs block without resetting the budget", () => {
  assert.deepEqual(
    routeVerificationFailure(
      { kind: "ordinary", diagnostics: ["max-lines"] },
      { attempts: 4, limit: 4 },
    ),
    { action: "blocked", reason: "verification-repair-budget-exhausted" },
  );
});

await test("QG-12 policy proposals route to a stable decision reference without activating them", () => {
  const failure = { kind: "policy-change", proposal: "policy-sha256" } as const;
  const budget = { attempts: 0, limit: 4 };
  const expected = { action: "design-decision", proposal: "policy-sha256" };
  assert.deepEqual(routeVerificationFailure(failure, budget), expected);
  assert.deepEqual(routeVerificationFailure(failure, budget), expected);
  assert.deepEqual(budget, { attempts: 0, limit: 4 });
});

await test("QG-12 invalid budgets and empty failures cannot request repair or activation", () => {
  for (const attempts of [-1, 0.5, NaN, Infinity, 5]) {
    assert.throws(() => {
      routeVerificationFailure(
        { kind: "ordinary", diagnostics: ["failure"] },
        { attempts, limit: 4 },
      );
    }, /invalid-verification-repair-budget/);
  }
  for (const failure of [
    { kind: "ordinary", diagnostics: [] },
    { kind: "ordinary", diagnostics: [" "] },
    { kind: "policy-change", proposal: "" },
  ] as const) {
    assert.throws(() => {
      routeVerificationFailure(failure, { attempts: 0, limit: 4 });
    }, /invalid-verification-failure/);
  }
});
