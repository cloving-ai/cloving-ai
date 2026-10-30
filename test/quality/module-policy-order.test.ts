import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./files-fixture.ts";

const policy: unknown = JSON.parse(
  await readFile(
    new URL("../../quality/module-policy.json", import.meta.url),
    "utf8",
  ),
);
assert.ok(policy && typeof policy === "object");
const initialRoles: unknown = Reflect.get(policy, "roles");
assert.ok(
  initialRoles &&
    typeof initialRoles === "object" &&
    !Array.isArray(initialRoles),
);

function assertSortedKeys(name: string, map: object): void {
  let previous: string | undefined;
  for (const key of Object.keys(map)) {
    assert.ok(
      previous === undefined || previous < key,
      `${name}: "${key}" is out of order after "${previous ?? ""}"`,
    );
    previous = key;
  }
}

for (const name of [
  "roles",
  "allowed",
  "forbiddenReachability",
  "automaticPaths",
])
  await test(`CLV-257 module policy ${name} keys stay sorted`, async () => {
    const policy: unknown = JSON.parse(
      await readFile(
        new URL("../../quality/module-policy.json", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(policy && typeof policy === "object");
    const map: unknown = Reflect.get(policy, name);
    assert.ok(map && typeof map === "object" && !Array.isArray(map));
    assertSortedKeys(name, map);
  });

await test("CLV-257 order refusal names the first inverted key and its predecessor", () => {
  assert.throws(
    () => {
      assertSortedKeys("roles", {
        "src/alpha.ts": "pure",
        "src/zeta.ts": "pure",
        "src/beta.ts": "pure",
        "src/aardvark.ts": "pure",
      });
    },
    {
      message: 'roles: "src/beta.ts" is out of order after "src/zeta.ts"',
    },
  );
  for (const map of [{}, { alpha: "pure" }, { alpha: "pure", beta: "test" }])
    assert.doesNotThrow(() => {
      assertSortedKeys("roles", map);
    });
});

const withSortedRole = (file: string, role: string): string => {
  const roles: Readonly<Record<string, unknown>> = {
    ...initialRoles,
    [file]: role,
  };
  return (
    JSON.stringify(
      {
        ...policy,
        roles: Object.fromEntries(
          Object.keys(roles)
            .sort()
            .map((key) => [key, roles[key]]),
        ),
      },
      null,
      2,
    ) + "\n"
  );
};

await test("CLV-257 sorted additions in different folders merge without conflict", async () => {
  const file = "quality/module-policy.json";
  await withFiles(
    { [file]: JSON.stringify(policy, null, 2) + "\n" },
    async (directory) => {
      const git = (...argumentsList: string[]): string =>
        execFileSync("git", argumentsList, {
          cwd: directory,
          encoding: "utf8",
          timeout: 10000,
          stdio: "pipe",
        }).trim();
      git("init", "--quiet", "--initial-branch=main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      git("add", file);
      git("commit", "--quiet", "--no-gpg-sign", "-m", "Initial policy");
      git("checkout", "--quiet", "-b", "branch-a");
      await writeFile(
        join(directory, file),
        withSortedRole("src/cli/alpha.ts", "cli"),
      );
      git("add", file);
      git("commit", "--quiet", "--no-gpg-sign", "-m", "Add CLI entry");
      git("checkout", "--quiet", "-b", "branch-b", "main");
      await writeFile(
        join(directory, file),
        withSortedRole("test/zeta.test.ts", "test"),
      );
      git("add", file);
      git("commit", "--quiet", "--no-gpg-sign", "-m", "Add test entry");
      git("checkout", "--quiet", "main");
      git("merge", "--quiet", "--ff-only", "branch-a");
      git("checkout", "--quiet", "branch-b");
      git("merge", "--no-ff", "--no-edit", "--no-gpg-sign", "main");
      assert.equal(git("ls-files", "--unmerged"), "");
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(
        git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
        3,
      );
      const merged: unknown = JSON.parse(
        await readFile(join(directory, file), "utf8"),
      );
      assert.deepEqual(merged, {
        ...policy,
        roles: {
          ...initialRoles,
          "src/cli/alpha.ts": "cli",
          "test/zeta.test.ts": "test",
        },
      });
      assertSortedKeys("roles", merged.roles);
    },
  );
});
