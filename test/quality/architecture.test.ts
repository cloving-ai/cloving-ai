import assert from "node:assert/strict";
import { basename } from "node:path";
import { test } from "node:test";
import { checkArchitecture } from "../../quality/architecture.ts";
import { withProgram } from "./program-fixture.ts";

const allowed = {
  pure: ["pure"],
  storage: ["storage"],
  workflow: ["pure", "step"],
  step: ["broker"],
  broker: ["storage"],
};
const forbiddenReachability = { pure: ["storage", "broker", "step"] };

for (const effect of ["Date.now()", "Math.random()", "process.env.VALUE"]) {
  await test(`QG-06 checks ambient effects in every reachable pure helper: ${effect}`, async () => {
    await withProgram(
      {
        "main.ts":
          'import { value } from "./helper.js"; export const result = value;',
        "helper.ts": `export const value = ${effect};`,
      },
      (program) => {
        const roles = Object.fromEntries(
          program.getRootFileNames().map((file) => [file, "pure"]),
        );
        assert.throws(() => {
          checkArchitecture(program, {
            roles,
            allowed,
            forbiddenReachability,
          });
        }, /restricted-effect/);
      },
    );
  });
}

await test("QG-19 rejects direct, re-exported and transitive storage access", async () => {
  await withProgram(
    {
      "main.ts":
        'import { value } from "./barrel.js"; export const result = value;',
      "barrel.ts": 'export { value } from "./storage.js";',
      "storage.ts": "export const value = 1;",
    },
    (program) => {
      const roles = Object.fromEntries(
        program
          .getRootFileNames()
          .map((file) => [
            file,
            basename(file) === "storage.ts" ? "storage" : "pure",
          ]),
      );
      assert.throws(() => {
        checkArchitecture(program, { roles, allowed, forbiddenReachability });
      }, /forbidden-dependency/);
    },
  );
});

await test("QG-19 accepts a fully mapped pure graph and rejects an unmapped move", async () => {
  await withProgram(
    { "main.ts": "export const value = Math.max(1, 2);" },
    (program) => {
      const roles = Object.fromEntries(
        program.getRootFileNames().map((file) => [file, "pure"]),
      );
      assert.doesNotThrow(() => {
        checkArchitecture(program, { roles, allowed, forbiddenReachability });
      });
      assert.throws(() => {
        checkArchitecture(program, {
          roles: {},
          allowed,
          forbiddenReachability,
        });
      }, /empty-dependency-policy/);
    },
  );
});
