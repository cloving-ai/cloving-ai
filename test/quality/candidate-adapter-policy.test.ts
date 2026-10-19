import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { proposedModulePolicy } from "../../quality/module-policy.ts";
import { checkDependencies } from "../../quality/dependency-policy.ts";

await test("CLV-121 only the scoped candidate adapter role gains TypeScript analysis access", () => {
  const policy = proposedModulePolicy(process.cwd());
  const adapter = resolve("tools/workflow-candidate-program.ts");
  const compiler = resolve("node_modules/typescript/lib/typescript.d.ts");
  assert.equal(policy.roles[adapter], "candidate-adapter");
  checkDependencies(
    {
      files: [adapter],
      edges: [
        {
          from: adapter,
          target: compiler,
          specifier: "typescript",
          kind: "value",
        },
      ],
    },
    policy,
  );
  const pure = resolve("src/workflow-candidate.ts");
  assert.throws(() => {
    checkDependencies(
      {
        files: [pure],
        edges: [
          {
            from: pure,
            target: compiler,
            specifier: "typescript",
            kind: "value",
          },
        ],
      },
      policy,
    );
  }, /forbidden-dependency/);
  assert.throws(() => {
    checkDependencies(
      {
        files: [pure],
        edges: [
          {
            from: pure,
            target: adapter,
            specifier: "typescript",
            kind: "value",
          },
        ],
      },
      policy,
    );
  }, /forbidden-dependency/);
  assert.deepEqual(policy.allowed["pure"], ["pure"]);
  assert.equal(policy.allowed["build"]?.includes("tooling"), false);
});
