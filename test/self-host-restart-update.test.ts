import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { restartText, type RestartTime } from "../src/restart-request.ts";
import { hostedPrograms } from "../tools/self-host-processes.ts";
import { programs } from "./self-host-processes-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";
import { eventually } from "./service-fixture.ts";

async function fakeNpm(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "npm");
  await writeFile(
    executable,
    `#!${process.execPath}
import { appendFileSync, existsSync, rmSync } from "node:fs";
const line = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(join(root, "npm-calls"))}, line + "\\n");
const failing = ${JSON.stringify(join(root, "build-fails"))};
if (line === "run build" && existsSync(failing)) {
  rmSync(failing);
  process.stdout.write("> tsc --project tsconfig.build.json\\n");
  process.stderr.write("error TS2322: Type 'string' is not assignable\\n");
  process.exit(2);
}
`,
  );
  await chmod(executable, 0o755);
  return bin;
}

function updateMark(at: RestartTime, commandId: string): string {
  return restartText({
    at,
    requestedAt: Date.now(),
    commandId,
    resumeQueue: false,
    update: true,
  });
}

async function withUpdateHost(
  body: (scene: {
    readonly root: string;
    readonly directory: string;
    readonly git: (argumentsList: readonly string[]) => string;
    readonly old: string;
    readonly target: string;
    readonly hosted: () => Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  await withUpdateRepository(async ({ root, repository, git, old, target }) => {
    const paths = await programs(root);
    const bin = await fakeNpm(root);
    const directory = join(root, "host");
    await mkdir(directory, { recursive: true });
    await body({
      root,
      directory,
      git,
      old,
      target,
      hosted: () =>
        hostedPrograms({
          ...paths,
          environment: {
            ...process.env,
            PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          },
          repository: root,
          checkout: repository,
          runtime: join(directory, "run"),
          directory,
          watchPort: "off",
          phoneRelay: "off",
          updateMilliseconds: undefined,
          restartMilliseconds: 50,
        }),
    });
  });
}

await test("CLV-306 a restart with an update builds the new commit at the gap and then stops the programs with exit 75", () =>
  withUpdateHost(async ({ root, directory, git, target, hosted }) => {
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(directory, "pending-restart-one"),
      updateMark("gap", "restart-update"),
    );
    assert.equal(await hosting, 75);
    assert.equal(git(["rev-parse", "HEAD"]), target);
    assert.equal(
      await readFile(join(root, "npm-calls"), "utf8"),
      "run build\n",
    );
    assert.equal(
      await readFile(join(root, "daemon-signals"), "utf8"),
      "SIGTERM\n",
    );
  }));

await test("CLV-306 a failed build keeps the programs running on the old commit and records the step for the command", () =>
  withUpdateHost(async ({ root, directory, git, old, hosted }) => {
    await writeFile(join(root, "build-fails"), "");
    const hosting = hosted();
    await eventually(() =>
      existsSync(join(root, "daemon-ready")) ? true : undefined,
    );
    await writeFile(
      join(directory, "pending-restart-one"),
      updateMark("now", "restart-broken"),
    );
    const failure = join(directory, "restart-failure");
    await eventually(() => (existsSync(failure) ? true : undefined));
    assert.deepEqual(JSON.parse(await readFile(failure, "utf8")), {
      commandId: "restart-broken",
      step: "build",
      output:
        "> tsc --project tsconfig.build.json\nerror TS2322: Type 'string' is not assignable",
    });
    assert.equal(existsSync(join(directory, "claimed-restart")), false);
    assert.equal(existsSync(join(root, "daemon-signals")), false);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.equal(
      await readFile(join(root, "npm-calls"), "utf8"),
      "run build\nrun build\n",
    );
    await writeFile(
      join(directory, "pending-restart-two"),
      restartText({
        at: "now",
        requestedAt: Date.now(),
        commandId: "restart-plain",
        resumeQueue: false,
      }),
    );
    assert.equal(await hosting, 75);
    assert.equal(existsSync(failure), false);
  }));
