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
  const policy = admittedModulePolicy(directory, {
    files,
    roles: { "src/admission.ts": "pure", "test/admission.test.ts": "test" },
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
      () => admittedModulePolicy(directory, { files, roles: proposal }),
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
  const policy = admittedModulePolicy(directory, {
    files: stepFiles,
    roles: { ...proposal, "src/steps/load-cycle.ts": "step" },
  });
  assert.equal(policy.roles["/candidate/src/steps/load-cycle.ts"], "step");
  assert.ok(policy.allowed["test"]?.includes("step"));
  assert.throws(
    () =>
      admittedModulePolicy(directory, {
        files,
        roles: { ...proposal, "src/admission.ts": "step" },
      }),
    /mapping-requires-review/,
  );
});

await test("QG-19 the command line and broker may call pure modules and the command line may use broker discovery", () => {
  const policy = admittedModulePolicy(directory, {
    files,
    roles: { "src/admission.ts": "pure", "test/admission.test.ts": "test" },
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

await test("CLV-007 brokers compose brokers, storage composes storage, tests reach storage and the SQLite driver is a storage module", () => {
  const policy = admittedModulePolicy(directory, {
    files,
    roles: { "src/admission.ts": "pure", "test/admission.test.ts": "test" },
  });
  assert.deepEqual(policy.allowed["broker"], [
    "broker",
    "storage",
    "harness",
    "stdlib",
    "pure",
    "actor-runtime",
  ]);
  assert.deepEqual(policy.allowed["storage"], ["storage", "stdlib"]);
  assert.ok(policy.allowed["test"]?.includes("storage"));
  assert.equal(policy.roles["node:sqlite"], "storage");
  assert.ok(policy.forbiddenReachability["cli"]?.includes("storage"));
});

await test("CLV-042 only brokers and tests reach the actor runtime, and pure, command line, workflow and step code cannot reach it", () => {
  const policy = admittedModulePolicy(directory, {
    files,
    roles: { "src/admission.ts": "pure", "test/admission.test.ts": "test" },
  });
  assert.deepEqual(
    [
      policy.roles["/candidate/node_modules/solid-objects/dist/index.d.ts"],
      policy.roles[
        "/candidate/node_modules/solid-objects/dist/database/sqlite.d.ts"
      ],
    ],
    ["actor-runtime", "actor-runtime"],
  );
  assert.deepEqual(
    Object.entries(policy.allowed)
      .filter(([, targets]) => targets.includes("actor-runtime"))
      .map(([role]) => role)
      .sort(),
    ["broker", "test"],
  );
  assert.deepEqual(policy.allowed["actor-runtime"], []);
  assert.deepEqual(
    ["pure", "cli", "workflow", "step"].filter((role) =>
      policy.forbiddenReachability[role]?.includes("actor-runtime"),
    ),
    ["pure", "cli", "workflow", "step"],
  );
});

await test("CLV-008 only service, command line and test code can import the socket module, only quality, build, daemon and test code can import the process module, and only the daemon and tests reach the service", () => {
  const policy = admittedModulePolicy(directory, {
    files,
    roles: { "src/admission.ts": "pure", "test/admission.test.ts": "test" },
  });
  const importers = (role: string): string[] =>
    Object.entries(policy.allowed)
      .filter(([, targets]) => targets.includes(role))
      .map(([name]) => name)
      .sort();
  assert.deepEqual(
    [policy.roles["node:net"], policy.roles["node:child_process"]],
    ["network", "process"],
  );
  assert.deepEqual(importers("network"), ["cli", "service", "test"]);
  assert.deepEqual(importers("process"), [
    "build",
    "daemon",
    "quality",
    "test",
  ]);
  assert.deepEqual(importers("service"), ["daemon", "service", "test"]);
  assert.deepEqual(
    [policy.allowed["network"], policy.allowed["process"]],
    [[], []],
  );
  for (const role of ["pure", "workflow", "step"])
    for (const target of ["service", "network", "process"])
      assert.ok(
        policy.forbiddenReachability[role]?.includes(target),
        `${role} ${target}`,
      );
  assert.ok(policy.forbiddenReachability["cli"]?.includes("service"));
  assert.ok(policy.forbiddenReachability["cli"]?.includes("process"));
});

await test("CLV-049 only quality code can import the inspector module, and service code cannot import package metadata", () => {
  const policy = admittedModulePolicy(directory, {
    files,
    roles: { "src/admission.ts": "pure", "test/admission.test.ts": "test" },
  });
  const importers = (role: string): string[] =>
    Object.entries(policy.allowed)
      .filter(([, targets]) => targets.includes(role))
      .map(([name]) => name)
      .sort();
  assert.equal(policy.roles["node:inspector"], "inspector");
  assert.deepEqual(importers("inspector"), ["quality"]);
  assert.deepEqual(policy.allowed["inspector"], []);
  assert.deepEqual(importers("metadata"), ["build", "cli", "quality"]);
});

await test("CLV-049 each role with a reachability list cannot reach the inspector role: these are the roles that cannot reach the process role or the network role", () => {
  const policy = admittedModulePolicy(directory, {
    files,
    roles: { "src/admission.ts": "pure", "test/admission.test.ts": "test" },
  });
  const lists = Object.entries(policy.forbiddenReachability);
  assert.deepEqual(
    lists
      .filter(
        ([, targets]) =>
          targets.includes("process") || targets.includes("network"),
      )
      .map(([role]) => role)
      .sort(),
    ["cli", "pure", "service", "step", "workflow"],
  );
  assert.deepEqual(
    lists
      .filter(([, targets]) => !targets.includes("inspector"))
      .map(([role]) => role),
    [],
  );
});
