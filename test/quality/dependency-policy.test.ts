import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDependencies } from "../../quality/dependency-policy.ts";
import { graphFixture } from "./graph-fixture.ts";
import { basename } from "node:path";

const sources = {
  "domain.ts":
    'import { value } from "./helper.js"; export const result = value;',
  "helper.ts": 'import { value } from "./storage.js"; export { value };',
  "storage.ts": "export const value = 1;",
};

await test("QG-19 rejects forbidden transitive paths even when each direct edge is permitted", async () => {
  const graph = await graphFixture(sources);
  const roles = Object.fromEntries(
    graph.files.map((file) => [file, basename(file, ".ts")]),
  );
  const policy = {
    roles,
    allowed: { domain: ["helper"], helper: ["storage"], storage: [] },
    forbiddenReachability: { domain: ["storage"] },
  };
  assert.throws(() => {
    checkDependencies(graph, policy);
  }, /forbidden-reachability.*domain\.ts.*storage\.ts/s);
});

await test("QG-19 rejects cycles through re-export edges", async () => {
  const graph = await graphFixture({
    "first.ts": 'export * from "./second.js";',
    "second.ts": 'export * from "./first.js";',
  });
  const roles = Object.fromEntries(graph.files.map((file) => [file, "pure"]));
  assert.throws(() => {
    checkDependencies(graph, {
      roles,
      allowed: { pure: ["pure"] },
      forbiddenReachability: {},
    });
  }, /dependency-cycle/);
});

await test("QG-19 rejects unmapped files, external edges and forbidden type-only edges", async () => {
  const graph = await graphFixture({
    "domain.ts":
      'import type { Stats } from "node:fs"; export type Value = Stats;',
  });
  const roles = Object.fromEntries(graph.files.map((file) => [file, "pure"]));
  const policy = { roles, allowed: { pure: [] }, forbiddenReachability: {} };
  assert.throws(() => {
    checkDependencies(graph, { ...policy, roles: {} });
  }, /empty-dependency-policy/);
  assert.throws(() => {
    checkDependencies(graph, policy);
  }, /unmapped-dependency/);
  assert.throws(() => {
    checkDependencies(graph, {
      ...policy,
      roles: { ...roles, "node:fs": "effect" },
    });
  }, /forbidden-dependency/);
});

await test("QG-19 accepts an explicit pure graph and rejects a newly unscanned module", async () => {
  const graph = await graphFixture(sources);
  const roles = Object.fromEntries(graph.files.map((file) => [file, "pure"]));
  const policy = {
    roles,
    allowed: { pure: ["pure"] },
    forbiddenReachability: {},
  };
  assert.doesNotThrow(() => {
    checkDependencies(graph, policy);
  });
  assert.throws(() => {
    checkDependencies(
      { ...graph, files: [...graph.files, "/new/module.ts"] },
      policy,
    );
  }, /unmapped-module/);
});
