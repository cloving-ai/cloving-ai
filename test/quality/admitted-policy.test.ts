import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  admittedModulePolicy,
  readProposedRoles,
} from "../../quality/module-policy.ts";
import { withFiles } from "./files-fixture.ts";

const directory = "/candidate";
const files = [
  "/candidate/src/workflows.ts",
  "/candidate/src/admission.ts",
  "/candidate/test/admission.test.ts",
];

await test("QG-19 the installed policy binds new product and test files proposed under automatic roles", () => {
  const policy = admittedModulePolicy(directory, files, {
    "src/admission.ts": "pure",
    "test/admission.test.ts": "test",
  });
  assert.equal(policy.roles["/candidate/src/admission.ts"], "pure");
  assert.equal(policy.roles["/candidate/src/workflows.ts"], "workflow");
  assert.equal(policy.roles["/candidate/test/admission.test.ts"], "test");
  assert.equal(policy.roles["node:fs"], "stdlib");
  assert.ok(policy.allowed["test"]?.includes("pure"));
});

await test("QG-19 candidate proposals cannot add reviewed roles or change accepted mappings", () => {
  const added = { "test/admission.test.ts": "test" };
  for (const [proposal, expected] of [
    [added, /unmapped-module: src\/admission.ts/],
    [{ ...added, "src/admission.ts": "quality" }, /mapping-requires-review/],
    [
      { ...added, "src/admission.ts": "pure", "src/workflows.ts": "broker" },
      /mapping-policy-change/,
    ],
    [
      { ...added, "src/admission.ts": "pure", "package.json": "pure" },
      /mapping-policy-change/,
    ],
    [
      { ...added, "src/admission.ts": "pure", "node:fs": "pure" },
      /mapping-policy-change/,
    ],
    [{ ...added, "src/admission.ts": "test" }, /mapping-requires-review/],
    [
      { "test/admission.test.ts": "pure", "src/admission.ts": "pure" },
      /mapping-requires-review/,
    ],
  ] as const)
    assert.throws(
      () => admittedModulePolicy(directory, files, proposal),
      expected,
    );
});

await test("QG-19 a malformed candidate role proposal is rejected", async () => {
  await withFiles({}, async (directory) => {
    assert.deepEqual(await readProposedRoles(directory), {});
    await mkdir(join(directory, "quality"));
    for (const proposal of ["[]", '{"other":{}}', '{"roles":{"src/a.ts":1}}']) {
      await writeFile(join(directory, "quality/module-policy.json"), proposal);
      await assert.rejects(
        readProposedRoles(directory),
        /invalid-module-proposal/,
      );
    }
  });
});

await test("QG-19 new step modules bind automatically only under src/steps", () => {
  const stepFiles = [...files, "/candidate/src/steps/load-cycle.ts"];
  const proposal = {
    "src/admission.ts": "pure",
    "test/admission.test.ts": "test",
  };
  const policy = admittedModulePolicy(directory, stepFiles, {
    ...proposal,
    "src/steps/load-cycle.ts": "step",
  });
  assert.equal(policy.roles["/candidate/src/steps/load-cycle.ts"], "step");
  assert.ok(policy.allowed["test"]?.includes("step"));
  assert.throws(
    () =>
      admittedModulePolicy(directory, files, {
        ...proposal,
        "src/admission.ts": "step",
      }),
    /mapping-requires-review/,
  );
});

await test("QG-19 the command line and broker may call pure modules and the command line may use broker discovery", () => {
  const policy = admittedModulePolicy(directory, files, {
    "src/admission.ts": "pure",
    "test/admission.test.ts": "test",
  });
  assert.deepEqual(
    [policy.allowed["cli"], policy.allowed["broker"]].map((roles) =>
      ["cli", "pure", "broker"].filter((role) => roles?.includes(role)),
    ),
    [
      ["cli", "pure", "broker"],
      ["pure", "broker"],
    ],
  );
  assert.ok(!policy.forbiddenReachability["pure"]?.includes("pure"));
  assert.deepEqual(
    ["storage", "harness", "step", "workflow"].filter((role) =>
      policy.forbiddenReachability["cli"]?.includes(role),
    ),
    ["storage", "harness", "step", "workflow"],
  );
});

await test("CLV-007 brokers compose brokers, storage composes storage, tests reach storage and the SQLite driver is a standard module", () => {
  const policy = admittedModulePolicy(directory, files, {
    "src/admission.ts": "pure",
    "test/admission.test.ts": "test",
  });
  assert.deepEqual(policy.allowed["broker"], [
    "broker",
    "storage",
    "harness",
    "stdlib",
    "pure",
  ]);
  assert.deepEqual(policy.allowed["storage"], ["storage", "stdlib"]);
  assert.ok(policy.allowed["test"]?.includes("storage"));
  assert.equal(policy.roles["node:sqlite"], "stdlib");
  assert.ok(policy.forbiddenReachability["cli"]?.includes("storage"));
});
