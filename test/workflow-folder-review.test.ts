import assert from "node:assert/strict";
import filesystem, {
  mkdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput, operatorFiles } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { validCandidateSource } from "./workflow-candidate-fixtures.ts";

await test("CLV-124 a missing sidecar cannot hide a function conflict under a different base name", () =>
  withFiles(
    {
      ...operatorFiles("project", "first"),
      "config/cloving/workflows/second.ts": validCandidateSource.replaceAll(
        "candidate",
        "first",
      ),
    },
    async (directory) => {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals, [
        { scope: "project", label: "first.ts", codes: ["workflow-conflict"] },
        {
          scope: "user",
          label: "second.ts",
          codes: ["workflow-conflict", "workflow-read-failed"],
        },
      ]);
    },
  ));

for (const action of [
  "remove-before-realpath",
  "link-before-realpath",
  "replace-folder-with-file",
] as const) {
  await test(`CLV-124 capture classifies ${action} as a source change`, () =>
    withFiles(operatorFiles("project", "project"), async (directory) => {
      const open = filesystem.open;
      const realpath = filesystem.realpath;
      const descriptor = Object.getOwnPropertyDescriptor(
        filesystem,
        "realpath",
      );
      assert.ok(descriptor);
      const source = join(directory, "repo/.cloving/workflows/project.ts");
      Object.defineProperty(filesystem, "realpath", {
        configurable: true,
        value: async (...args: Parameters<typeof realpath>) => {
          if (action === "remove-before-realpath" && String(args[0]) === source)
            await unlink(source);
          if (action === "link-before-realpath" && String(args[0]) === source) {
            await unlink(source);
            await symlink(source, source);
          }
          return realpath(...args);
        },
      });
      filesystem.open = async (path, flags) => {
        if (
          action === "replace-folder-with-file" &&
          String(path).endsWith("/project.ts")
        ) {
          const folder = join(directory, "repo/.cloving/workflows");
          await rename(folder, folder + ".saved");
          await writeFile(folder, "replacement");
        }
        return open(path, flags);
      };
      syncBuiltinESMExports();
      try {
        const result = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(result.candidates, []);
        assert.deepEqual(result.refusals, [
          {
            scope: "project",
            label: "project.ts",
            codes: ["workflow-source-changed"],
          },
        ]);
      } finally {
        filesystem.open = open;
        Object.defineProperty(filesystem, "realpath", descriptor);
        syncBuiltinESMExports();
      }
    }));
}

function isFolderListing(path: string, folder: string): boolean {
  return path.endsWith(folder) || /^\/proc\/self\/fd\/\d+$/.test(path);
}

function removeDuringFolderAccess(location: {
  boundary: string;
  path: string;
}) {
  const realpath = filesystem.realpath;
  const readdir = filesystem.readdir;
  const realpathDescriptor = Object.getOwnPropertyDescriptor(
    filesystem,
    "realpath",
  );
  const readdirDescriptor = Object.getOwnPropertyDescriptor(
    filesystem,
    "readdir",
  );
  assert.ok(realpathDescriptor && readdirDescriptor);
  Object.defineProperty(filesystem, "realpath", {
    configurable: true,
    value: async (...args: Parameters<typeof realpath>) => {
      if (
        location.boundary === "realpath" &&
        isFolderListing(String(args[0]), location.path)
      )
        await rm(location.path, { recursive: true });
      return realpath(...args);
    },
  });
  Object.defineProperty(filesystem, "readdir", {
    configurable: true,
    value: async (...args: Parameters<typeof readdir>) => {
      if (
        location.boundary === "readdir" &&
        isFolderListing(String(args[0]), location.path)
      )
        await rm(location.path, { recursive: true });
      if (
        location.boundary === "readdir-empty-replacement" &&
        isFolderListing(String(args[0]), location.path)
      ) {
        await rename(location.path, location.path + ".saved");
        await mkdir(location.path);
      }
      return readdir(...args);
    },
  });
  syncBuiltinESMExports();
  return () => {
    Object.defineProperty(filesystem, "realpath", realpathDescriptor);
    Object.defineProperty(filesystem, "readdir", readdirDescriptor);
    syncBuiltinESMExports();
  };
}

for (const boundary of [
  "realpath",
  "readdir",
  "readdir-empty-replacement",
] as const) {
  await test(`CLV-124 folder disappearance during ${boundary} is visible`, () =>
    withFiles(operatorFiles("project", "project"), async (directory) => {
      const restore = removeDuringFolderAccess({
        boundary,
        path: join(directory, "repo/.cloving/workflows"),
      });
      try {
        const result = await loadWorkflowFolders(folderInput(directory));
        assert.deepEqual(result.candidates, []);
        assert.deepEqual(result.refusals, [
          {
            scope: "project",
            label: "workflows/",
            codes: ["workflow-source-changed"],
          },
        ]);
      } finally {
        restore();
      }
    }));
}

function swapDuringListing(location: {
  path: string;
  outside: string;
  replacement: string;
}) {
  const original = filesystem.readdir;
  const descriptor = Object.getOwnPropertyDescriptor(filesystem, "readdir");
  assert.ok(descriptor);
  let swapped = false;
  Object.defineProperty(filesystem, "readdir", {
    configurable: true,
    value: async (...args: Parameters<typeof original>) => {
      const active = isFolderListing(String(args[0]), location.path);
      if (active) {
        swapped = true;
        await rename(location.path, location.path + ".saved");
        if (location.replacement === "link")
          await symlink(location.outside, location.path);
        else await rename(location.outside, location.path);
      }
      try {
        return await original(...args);
      } finally {
        if (active) {
          if (location.replacement === "link") await unlink(location.path);
          else await rename(location.path, location.outside);
          await rename(location.path + ".saved", location.path);
        }
      }
    },
  });
  syncBuiltinESMExports();
  return {
    get swapped() {
      return swapped;
    },
    restore: () => {
      Object.defineProperty(filesystem, "readdir", descriptor);
      syncBuiltinESMExports();
    },
  };
}

for (const replacement of ["link", "directory"] as const) {
  await test(`CLV-124 listing refuses a temporary outside ${replacement} even when the folder is restored`, () =>
    withFiles(
      {
        ...operatorFiles("project", "project"),
        "outside/outside-sentinel.ts": "outside",
      },
      async (directory) => {
        const listing = swapDuringListing({
          path: join(directory, "repo/.cloving/workflows"),
          outside: join(directory, "outside"),
          replacement,
        });
        try {
          const result = await loadWorkflowFolders(folderInput(directory));
          assert.equal(listing.swapped, true);
          assert.deepEqual(result.candidates, []);
          assert.deepEqual(result.refusals, [
            {
              scope: "project",
              label: "workflows/",
              codes: ["workflow-source-changed"],
            },
          ]);
          assert.equal(
            JSON.stringify(result.refusals).includes("outside-sentinel"),
            false,
          );
        } finally {
          listing.restore();
        }
      },
    ));
}

await test("CLV-124 an observed ancestor disappearing before its child inspection is visible", () =>
  withFiles(operatorFiles("project", "project"), async (directory) => {
    const original = filesystem.lstat;
    const descriptor = Object.getOwnPropertyDescriptor(filesystem, "lstat");
    assert.ok(descriptor);
    const parent = join(directory, "repo/.cloving");
    Object.defineProperty(filesystem, "lstat", {
      configurable: true,
      value: async (...args: Parameters<typeof original>) => {
        if (String(args[0]) === join(parent, "workflows"))
          await rm(parent, { recursive: true, force: true });
        return original(...args);
      },
    });
    syncBuiltinESMExports();
    try {
      const result = await loadWorkflowFolders(folderInput(directory));
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(result.refusals, [
        {
          scope: "project",
          label: "workflows/",
          codes: ["workflow-source-changed"],
        },
      ]);
    } finally {
      Object.defineProperty(filesystem, "lstat", descriptor);
      syncBuiltinESMExports();
    }
  }));
