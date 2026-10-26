import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import filesystem, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimCoverageFolder,
  releaseCoverageFolder,
  removeStaleCoverageFolders,
} from "../../quality/coverage-folders.ts";
import { checkTests } from "../../quality/test-execution.ts";
import { withFiles } from "./files-fixture.ts";

const hour = 60 * 60 * 1000;
const now = Date.parse("2026-10-26T12:00:00Z");

function scene(): {
  readonly root: string;
  readonly folder: (
    name: string,
    options: { readonly ageHours: number; readonly owner?: number },
  ) => string;
  readonly warnings: string[];
  readonly clean: (running: readonly number[]) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "cloving-coverage-folders-"));
  const warnings: string[] = [];
  return {
    root,
    warnings,
    folder: (name, options) => {
      const folder = join(root, `cloving-test-coverage-${name}`);
      mkdirSync(folder);
      writeFileSync(join(folder, "coverage-1-1-0.json"), "{}");
      if (options.owner !== undefined)
        claimCoverageFolder(folder, options.owner);
      const time = new Date(now - options.ageHours * hour);
      utimesSync(folder, time, time);
      return folder;
    },
    clean: (running) => {
      removeStaleCoverageFolders({
        root,
        now: () => now,
        running: (pid) => running.includes(pid),
        warn: (text) => warnings.push(text),
      });
    },
  };
}

await test("CLV-230 a folder whose owner process does not exist is removed", () => {
  const place = scene();
  try {
    const folder = place.folder("dead", { ageHours: 1, owner: 4101 });
    place.clean([]);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(`${folder}.owner`), false);
    assert.deepEqual(place.warnings, []);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 the folder of a running owner process stays", () => {
  const place = scene();
  try {
    const folder = place.folder("live", { ageHours: 1, owner: 4102 });
    place.clean([4102]);
    assert.equal(existsSync(folder), true);
    assert.equal(existsSync(`${folder}.owner`), true);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 a folder older than 6 hours is removed, also when its owner process runs", () => {
  const place = scene();
  try {
    const folder = place.folder("old", { ageHours: 7, owner: 4103 });
    place.clean([4103]);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(`${folder}.owner`), false);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 a folder with no owner file stays when it is younger than 6 hours, and it is removed when it is older", () => {
  const place = scene();
  try {
    const young = place.folder("young", { ageHours: 5 });
    const old = place.folder("unowned-old", { ageHours: 7 });
    place.clean([]);
    assert.equal(existsSync(young), true);
    assert.equal(existsSync(old), false);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 a removal failure gives a warning, and the cleanup continues", () => {
  const place = scene();
  const blocked = place.folder("blocked", { ageHours: 8 });
  const next = place.folder("next", { ageHours: 8 });
  chmodSync(blocked, 0o500);
  try {
    place.clean([]);
    assert.equal(existsSync(blocked), true);
    assert.equal(existsSync(next), false);
    assert.equal(place.warnings.length, 1);
    assert.match(place.warnings[0] ?? "", /cloving-test-coverage-blocked/);
  } finally {
    chmodSync(blocked, 0o700);
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 other folders and owner files of removed folders are handled", () => {
  const place = scene();
  try {
    const other = join(place.root, "other-folder");
    mkdirSync(other);
    utimesSync(other, new Date(now - 9 * hour), new Date(now - 9 * hour));
    const leftover = join(place.root, "cloving-test-coverage-gone.owner");
    writeFileSync(leftover, "4104\n");
    place.clean([]);
    assert.equal(existsSync(other), true);
    assert.equal(existsSync(leftover), false);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 an owner entry that is not a regular file counts as no owner", () => {
  const place = scene();
  try {
    const folder = place.folder("pipe", { ageHours: 1 });
    const made = spawnSync("mkfifo", [`${folder}.owner`]);
    assert.equal(made.status, 0, String(made.stderr));
    place.clean([]);
    assert.equal(existsSync(folder), true);
    assert.deepEqual(place.warnings, []);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 a listing failure gives a warning, and the cleanup ends", () => {
  const warnings: string[] = [];
  removeStaleCoverageFolders({
    root: join(tmpdir(), "cloving-coverage-folders-missing-root"),
    now: () => now,
    running: () => false,
    warn: (text) => warnings.push(text),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /not listed/);
});

await test("CLV-230 a release ignores an owner file that another gate removed first", () => {
  const place = scene();
  const unlink = filesystem.unlinkSync;
  try {
    const folder = place.folder("raced", { ageHours: 0, owner: 4106 });
    filesystem.unlinkSync = (path) => {
      unlink(path);
      throw Object.assign(new Error("already removed"), { code: "ENOENT" });
    };
    syncBuiltinESMExports();
    releaseCoverageFolder(folder);
    assert.equal(existsSync(folder), false);
  } finally {
    filesystem.unlinkSync = unlink;
    syncBuiltinESMExports();
    rmSync(place.root, { recursive: true, force: true });
  }
});

await test("CLV-230 a released folder leaves no owner file", () => {
  const place = scene();
  try {
    const folder = place.folder("released", { ageHours: 0, owner: 4105 });
    releaseCoverageFolder(folder);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(`${folder}.owner`), false);
  } finally {
    rmSync(place.root, { recursive: true, force: true });
  }
});

function ownerText(path: string): string {
  try {
    return filesystem.readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

await test("CLV-230 the test check marks its coverage folder with its process ID and removes the mark", async () => {
  const owned = () =>
    filesystem
      .readdirSync(tmpdir())
      .filter(
        (name) =>
          name.startsWith("cloving-test-coverage-") &&
          name.endsWith(".owner") &&
          ownerText(join(tmpdir(), name)) === String(process.pid),
      );
  await withFiles(
    {
      "main.test.ts": [
        'import assert from "node:assert/strict";',
        'import { readdirSync, readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'import { test } from "node:test";',
        `const root = ${JSON.stringify(tmpdir())};`,
        "function ownerText(path) {",
        '  try { return readFileSync(path, "utf8").trim(); } catch { return ""; }',
        "}",
        'await test("sees the owner mark", () => {',
        "  const marks = readdirSync(root).filter((name) =>",
        '    name.startsWith("cloving-test-coverage-") && name.endsWith(".owner") &&',
        `    ownerText(join(root, name)) === "${String(process.pid)}");`,
        "  assert.equal(marks.length, 1);",
        "});",
      ].join("\n"),
    },
    async (directory) => {
      await checkTests(directory, {
        files: [join(directory, "main.test.ts")],
      });
    },
  );
  assert.deepEqual(owned(), []);
});
