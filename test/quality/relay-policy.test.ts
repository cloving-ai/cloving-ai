import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { checkDependencies } from "../../quality/dependency-policy.ts";
import { proposedModulePolicy } from "../../quality/module-policy.ts";

const policy = proposedModulePolicy(process.cwd());

function edge(from: string, target: string) {
  return { from, target, specifier: target, kind: "value" as const };
}

await test("CLV-187 a relay file may use the network and solid-objects", () => {
  const relay = resolve("src/relay/relay-store.ts");
  const solidObjects = resolve("node_modules/solid-objects/dist/index.d.ts");
  assert.equal(policy.roles[relay], "relay");
  checkDependencies(
    {
      files: [relay],
      edges: [edge(relay, "node:https"), edge(relay, solidObjects)],
    },
    policy,
  );
});

await test("CLV-187 daemon and command files may not import a relay file", () => {
  const relay = resolve("src/relay/relay-service.ts");
  for (const file of ["src/daemon/daemon.ts", "src/cli/main.ts"]) {
    const importer = resolve(file);
    assert.throws(() => {
      checkDependencies(
        { files: [importer], edges: [edge(importer, relay)] },
        policy,
      );
    }, /forbidden-dependency/);
  }
  assert.deepEqual(
    policy.forbiddenReachability["relay"],
    policy.forbiddenReachability["cli"]?.filter(
      (role) => role !== "actor-runtime",
    ),
  );
});
