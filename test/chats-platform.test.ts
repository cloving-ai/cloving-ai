import assert from "node:assert/strict";
import fs from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { redactImport } from "../src/chats/redact-import.ts";
import {
  importDirectory,
  createPrivateFile,
  validateDestination,
} from "../src/chats/destination.ts";
import { openInput } from "../src/chats/input-file.ts";
import { readPreviousImport } from "../src/chats/previous-import.ts";
import { noFollowPath, inspectScanSource } from "../src/chats/source.ts";
import { main } from "../src/cli/main.ts";
import { importChats } from "../src/chats/import.ts";

async function withoutChatFileAccess(inspect: () => Promise<void>) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  const attempts: string[] = [];
  const methods = [filesystem, fs].flatMap((target) =>
    Object.entries<unknown>(target).flatMap(([name, value]) =>
      typeof value === "function" ? [{ target, name, value }] : [],
    ),
  );
  for (const { target, name } of methods)
    Object.defineProperty(target, name, {
      configurable: true,
      value: () => {
        attempts.push(name);
        throw new Error("unexpected-file-access");
      },
    });
  syncBuiltinESMExports();
  try {
    for (const value of ["linux", "win32", "freebsd"]) {
      Object.defineProperty(process, "platform", { value, configurable: true });
      await inspect();
    }
    assert.deepEqual(attempts, []);
  } finally {
    Object.defineProperty(process, "platform", platform);
    for (const { target, name, value } of methods)
      Object.defineProperty(target, name, { value, configurable: true });
    syncBuiltinESMExports();
  }
}

await test("CLV-136 import refuses unsupported platforms before any file access", async () => {
  await withoutChatFileAccess(async () => {
    for (const runtimeDirectory of [undefined, "runtime"])
      for (const previousImportId of [undefined, "invalid"]) {
        const result = await importChats({
          paths: ["private-source"],
          roots: ["private-root"],
          workingDirectory: "/synthetic",
          runtimeDirectory,
          ...(previousImportId === undefined ? {} : { previousImportId }),
        });
        assert.equal(result.code, "platform-unsupported");
        assert.equal(result.importId, null);
        assert.doesNotMatch(JSON.stringify(result), /private-|synthetic/);
      }
  });
});

await test("CLV-136 redaction refuses unsupported platforms before any file access", async () => {
  await withoutChatFileAccess(async () => {
    for (const runtimeDirectory of [undefined, "runtime"])
      for (const importId of [
        "invalid",
        "01234567-89ab-4cde-8fab-0123456789ab",
      ]) {
        const result = await redactImport({
          importId,
          workingDirectory: "/synthetic",
          runtimeDirectory,
          settings: { home: null, privateTexts: [] },
        });
        assert.equal(result.code, "platform-unsupported");
        assert.equal(result.totalCount, 0);
      }
  });
});

for (const [name, operation] of [
  ["destination validation", () => validateDestination("/synthetic")],
  ["file creation", () => createPrivateFile("/synthetic/output")],
  ["input open", () => openInput("/synthetic/input")],
  ["import destination", () => importDirectory("/synthetic", "invalid")],
  ["previous import", () => readPreviousImport("/synthetic", "invalid")],
  ["source inspection", () => inspectScanSource("/synthetic", "/synthetic")],
] as const)
  await test(`CLV-136 ${name} refuses unsupported platforms before any file access`, async () => {
    await withoutChatFileAccess(async () => {
      await assert.rejects(operation, /^Error: platform-unsupported$/);
    });
  });

await test("CLV-136 no-follow paths refuse unsupported platforms", async () => {
  await withoutChatFileAccess(() => {
    assert.throws(
      () => noFollowPath("relative"),
      /^Error: platform-unsupported$/,
    );
    return Promise.resolve();
  });
});

for (const argumentsList of [
  ["chats", "import", "private-source"],
  ["chats", "redact", "01234567-89ab-4cde-8fab-0123456789ab"],
])
  await test(`CLV-136 CLI ${String(argumentsList[1])} names macOS on unsupported platforms`, async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const writeOutput = process.stdout.write.bind(process.stdout);
    const writeError = process.stderr.write.bind(process.stderr);
    process.stdout.write = (text) => {
      output.push(String(text));
      return true;
    };
    process.stderr.write = (text) => {
      errors.push(String(text));
      return true;
    };
    const exitCode = process.exitCode;
    const privateTexts = process.env["CLOVING_PRIVATE_TEXTS"];
    process.env["CLOVING_PRIVATE_TEXTS"] = "invalid";
    try {
      await withoutChatFileAccess(async () => {
        await main(argumentsList);
        assert.equal(process.exitCode, 1);
      });
      assert.deepEqual(
        output,
        Array<string>(3).fill('{"code":"platform-unsupported"}\n'),
      );
      assert.deepEqual(
        errors,
        Array<string>(3).fill(
          "platform-unsupported: Chat commands require macOS.\n",
        ),
      );
    } finally {
      process.stdout.write = writeOutput;
      process.stderr.write = writeError;
      process.exitCode = exitCode;
      if (privateTexts === undefined)
        delete process.env["CLOVING_PRIVATE_TEXTS"];
      else process.env["CLOVING_PRIVATE_TEXTS"] = privateTexts;
    }
  });
