import assert from "node:assert/strict";
import { test } from "node:test";
import { prBody as response } from "./watch-pr-fixture.ts";
import { prResponse } from "../src/cli/watch-pr-identity.ts";

const identity = {
  host: "github.example",
  owner: "fixture",
  repository: "demo",
  number: 7,
};

await test("CLV-093 only boolean merged proves a merge for the exact recorded PR", () => {
  assert.deepEqual(prResponse(identity, response(true)), { status: "merged" });
  assert.deepEqual(prResponse(identity, response(false)), {
    status: "unmerged",
  });
  for (const merged of [undefined, null, "true", 1, {}, []])
    assert.deepEqual(prResponse(identity, response(merged)), {
      status: "unavailable",
      failure: "response",
    });
});

await test("CLV-093 response identity conflicts and absent identities prove no merge", () => {
  const valid = response(true);
  assert.ok(typeof valid === "object" && valid !== null);
  for (const changed of [
    { number: 8 },
    { html_url: "https://other.example/fixture/demo/pull/7" },
    { html_url: "https://github.example/fixture/other/pull/7" },
    {
      base: {
        repo: {
          full_name: "fixture/other",
          name: "other",
          owner: { login: "fixture" },
          html_url: "https://github.example/fixture/other",
        },
      },
    },
  ])
    assert.deepEqual(prResponse(identity, { ...valid, ...changed }), {
      status: "unavailable",
      failure: "identity",
    });
  for (const changed of [
    { number: undefined },
    { html_url: null },
    { base: {} },
  ])
    assert.deepEqual(prResponse(identity, { ...valid, ...changed }), {
      status: "unavailable",
      failure: "response",
    });
});

await test("CLV-093 open and closed-unmerged replies ignore mergeability and test SHAs", () => {
  const valid = response(false);
  assert.ok(typeof valid === "object" && valid !== null);
  for (const state of ["open", "closed"])
    assert.deepEqual(prResponse(identity, { ...valid, state }), {
      status: "unmerged",
    });
});
