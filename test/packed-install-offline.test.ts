import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { installPacked, packedCommand } from "./packed-install-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const lifecycle = {
  install: "node -e \"require('node:fs').writeFileSync('install-ran', 'yes')\"",
};
const product = {
  name: "cloving",
  version: "1.0.0",
  dependencies: { "packed-runtime": "1.0.0" },
  devDependencies: { "packed-development": "1.0.0" },
  scripts: lifecycle,
};
const runtime = {
  name: "packed-runtime",
  version: "1.0.0",
  main: "index.js",
  scripts: lifecycle,
};
const fixtureFiles = {
  "source/package.json": JSON.stringify(product),
  "runtime/package.json": JSON.stringify(runtime),
  "runtime/index.js": 'module.exports = "locked-runtime";',
  "consumer/.npmrc": "",
};

async function install(directory: string): Promise<void> {
  const root = join(directory, "consumer");
  await installPacked(root, {
    archive: join(root, "cloving-1.0.0.tgz"),
    checkout: join(directory, "source"),
    env: {
      ...process.env,
      npm_config_cache: join(directory, "empty-cache"),
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:1",
    },
  });
}

async function archives(directory: string): Promise<void> {
  for (const folder of ["source", "runtime"])
    packedCommand("npm", {
      args: [
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        join(directory, "consumer"),
      ],
      cwd: join(directory, folder),
    });
  await writeFile(
    join(directory, "source/package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": product,
        "node_modules/packed-runtime": {
          version: "1.0.0",
          resolved: "file:packed-runtime-1.0.0.tgz",
          hasInstallScript: true,
        },
        "node_modules/packed-development": {
          version: "1.0.0",
          resolved: "file:unavailable-development-package.tgz",
          dev: true,
        },
      },
    }),
  );
}

await test("CLV-096 a packed consumer installs locked runtime tarballs without registry metadata or lifecycle scripts", async () => {
  await withFiles(fixtureFiles, async (directory) => {
    await archives(directory);
    await install(directory);
    const root = join(directory, "consumer");
    assert.equal(
      packedCommand(process.execPath, {
        args: ["-p", "require('packed-runtime')"],
        cwd: root,
      }).trim(),
      "locked-runtime",
    );
    packedCommand("npm", {
      args: ["ls", "--all", "--omit=dev", "--offline"],
      cwd: root,
    });
    for (const path of [
      "cloving/install-ran",
      "packed-runtime/install-ran",
      "packed-development/package.json",
    ])
      await assert.rejects(readFile(join(root, "node_modules", path)), {
        code: "ENOENT",
      });
  });
});

await test("CLV-096 a packed consumer refuses a runtime dependency that differs from its lock", async () => {
  await withFiles(
    {
      ...fixtureFiles,
      "source/package.json": JSON.stringify({
        ...product,
        dependencies: { "packed-runtime": "2.0.0" },
      }),
    },
    async (directory) => {
      await archives(directory);
      await assert.rejects(install(directory), /invalid.*packed-runtime/);
    },
  );
});
