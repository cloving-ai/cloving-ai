import assert from "node:assert/strict";
import { test } from "node:test";
import { checkNpmInputs } from "../../quality/npm-inputs.ts";
import { withFiles } from "./files-fixture.ts";

const manifest = {
  name: "fixture",
  version: "1.0.0",
  dependencies: { example: "1.0.0" },
};
const lock = {
  name: "fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: { "": manifest, "node_modules/example": { version: "1.0.0" } },
};
const installed = {
  "package.json": JSON.stringify(manifest),
  "package-lock.json": JSON.stringify(lock),
  "node_modules/example/package.json": '{"name":"example","version":"1.0.0"}',
};

await test("QG-20 accepts matching declarations and a complete installed npm graph", async () => {
  await withFiles(installed, async (directory) => {
    await assert.doesNotReject(checkNpmInputs(directory));
  });
});

for (const field of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
]) {
  await test(`QG-20 rejects manifest-lock mismatch for ${field}`, async () => {
    const changed = { ...manifest, [field]: { example: "2.0.0" } };
    await withFiles(
      { ...installed, "package.json": JSON.stringify(changed) },
      async (directory) => {
        await assert.rejects(
          checkNpmInputs(directory),
          /manifest-lock-mismatch|Check exit 1/,
        );
      },
    );
  });
}

await test("QG-20 rejects missing installed dependencies even when manifest and lock match", async () => {
  await withFiles(
    {
      "package.json": installed["package.json"],
      "package-lock.json": installed["package-lock.json"],
    },
    async (directory) => {
      await assert.rejects(checkNpmInputs(directory), /Check exit 1/);
    },
  );
});

await test("QG-20 rejects a resolved lock version that differs from the installed package", async () => {
  const changed = {
    ...lock,
    packages: {
      ...lock.packages,
      "node_modules/example": { version: "2.0.0" },
    },
  };
  await withFiles(
    { ...installed, "package-lock.json": JSON.stringify(changed) },
    async (directory) => {
      await assert.rejects(
        checkNpmInputs(directory),
        /installed-lock-mismatch/,
      );
    },
  );
});

await test("QG-20 project npm settings cannot omit required development packages", async () => {
  const development = {
    name: "fixture",
    version: "1.0.0",
    devDependencies: { example: "1.0.0" },
  };
  const changed = { ...lock, packages: { ...lock.packages, "": development } };
  await withFiles(
    {
      "package.json": JSON.stringify(development),
      "package-lock.json": JSON.stringify(changed),
      ".npmrc": "omit=dev\n",
    },
    async (directory) => {
      await assert.rejects(checkNpmInputs(directory), /Check exit 1/);
    },
  );
});
