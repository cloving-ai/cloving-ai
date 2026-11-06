import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { restartMark, restartText } from "../src/restart-request.ts";
import { withUpdateHost } from "./restart-host-fixture.ts";
import { eventually } from "./service-fixture.ts";

function plainMark(commandId: string): string {
  return restartText({
    at: "gap",
    requestedAt: Date.now(),
    commandId,
    resumeQueue: false,
  });
}

async function trackedSource(
  git: (argumentsList: readonly string[]) => string,
  shift: number,
): Promise<string> {
  const repository = git(["rev-parse", "--show-toplevel"]);
  const source = join(repository, "src", "cli.ts");
  await mkdir(join(repository, "src"));
  await writeFile(source, "export {};\n");
  git(["add", "src/cli.ts"]);
  git(["commit", "-qm", "Source"]);
  const changed = new Date(Date.now() + shift);
  await utimes(source, changed, changed);
  return repository;
}

await test("CLV-320 a restart with a fresh dist builds nothing and ends with exit 75", () =>
  withUpdateHost(async ({ root, directory, git, hosted }) => {
    await trackedSource(git, 0);
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(join(directory, "pending-restart-one"), plainMark("fresh"));
    assert.equal(await hosting, 75);
    assert.equal(existsSync(join(root, "npm-calls")), false);
  }));

await test("CLV-320 a source file newer than dist makes the restart build before the stop", () =>
  withUpdateHost(async ({ root, directory, git, hosted }) => {
    await trackedSource(git, 120_000);
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(join(directory, "pending-restart-one"), plainMark("stale"));
    assert.equal(await hosting, 75);
    assert.equal(
      await readFile(join(root, "npm-calls"), "utf8"),
      "run build\n",
    );
    assert.equal(await readFile(join(root, "npm-daemon"), "utf8"), "running\n");
  }));

await test("CLV-320 a restart with no dist builds first, and a failed build starts nothing and keeps the daemon running", () =>
  withUpdateHost(async ({ root, directory, git, hosted }) => {
    const repository = await trackedSource(git, 0);
    await rm(join(repository, "dist"), { recursive: true });
    await writeFile(join(root, "build-fails"), "");
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    const request = plainMark("broken-build");
    await writeFile(join(directory, "pending-restart-one"), request);
    const failure = join(directory, "restart-failure");
    await eventually(() => (existsSync(failure) ? true : undefined));
    assert.deepEqual(JSON.parse(await readFile(failure, "utf8")), {
      commandId: "broken-build",
      requestedAt: restartMark(request)?.requestedAt,
      code: "restart-build-failed",
      step: "build",
      output:
        "> tsc --project tsconfig.build.json\nerror TS2322: Type 'string' is not assignable",
    });
    assert.equal(existsSync(join(directory, "claimed-restart")), false);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    await writeFile(join(directory, "pending-restart-two"), plainMark("again"));
    assert.equal(await hosting, 75);
    assert.equal(
      await readFile(join(root, "npm-calls"), "utf8"),
      "run build\nrun build\n",
    );
  }));
