import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkoutCommands,
  updatedCheckout,
  type CheckoutUpdate,
} from "../tools/restart-update.ts";
import { eventually } from "./service-fixture.ts";
import { withUpdateRepository } from "./self-update-git-fixture.ts";

function rejecting(
  git: (argumentsList: readonly string[]) => string,
): (argumentsList: readonly string[]) => Promise<string> {
  return (argumentsList) =>
    new Promise((resolve) => {
      resolve(git(argumentsList));
    });
}

const running = new AbortController().signal;

function recordedNpm(
  calls: string[][],
  failing: readonly string[] = [],
): (argumentsList: readonly string[]) => Promise<string> {
  const failed = new Set<string>();
  return (argumentsList) => {
    calls.push([...argumentsList]);
    const line = argumentsList.join(" ");
    if (!failing.includes(line) || failed.has(line))
      return Promise.resolve(`${line} done\n`);
    failed.add(line);
    return Promise.reject(
      Object.assign(new Error(`npm ${line} failed`), {
        stdout: `${line} output\n`,
        stderr: "error TS2322: Type 'string' is not assignable\n",
      }),
    );
  };
}

await test("CLV-306 an update fast-forwards the default branch and builds with no install when the lock did not change", () =>
  withUpdateRepository(async ({ git, old, target }) => {
    const calls: string[][] = [];
    const outcome = await updatedCheckout({
      git: rejecting(git),
      npm: recordedNpm(calls),
      stopping: running,
    });
    assert.deepEqual(outcome, { kind: "updated", from: old, to: target });
    assert.equal(git(["rev-parse", "HEAD"]), target);
    assert.deepEqual(calls, [["run", "build"]]);
  }));

async function pushedLockChange(fixture: {
  readonly repository: string;
  readonly git: (argumentsList: readonly string[]) => string;
  readonly old: string;
  readonly target: string;
}): Promise<string> {
  const { git } = fixture;
  git(["reset", "-q", "--hard", fixture.target]);
  await writeFile(
    join(fixture.repository, "package-lock.json"),
    '{"packages":{"node_modules/a":{"version":"2.0.0"}}}\n',
  );
  git(["commit", "-qam", "Lock"]);
  const locked = git(["rev-parse", "HEAD"]);
  git(["push", "-q", "origin", "main"]);
  git(["reset", "-q", "--hard", fixture.old]);
  return locked;
}

await test("CLV-306 an update runs npm ci --ignore-scripts before the build when package-lock.json changed", () =>
  withUpdateRepository(async (fixture) => {
    const locked = await pushedLockChange(fixture);
    const calls: string[][] = [];
    const outcome = await updatedCheckout({
      git: rejecting(fixture.git),
      npm: recordedNpm(calls),
      stopping: running,
    });
    assert.deepEqual(outcome, {
      kind: "updated",
      from: fixture.old,
      to: locked,
    });
    assert.deepEqual(calls, [
      ["ci", "--ignore-scripts"],
      ["run", "build"],
    ]);
  }));

await test("CLV-320 an update skips a dirty tree before the fetch, prints the changed files and changes nothing", () =>
  withUpdateRepository(async ({ repository, git, old }) => {
    await writeFile(join(repository, "notes.txt"), "local work\n");
    const calls: string[][] = [];
    const commands: string[] = [];
    const outcome = await updatedCheckout({
      git: (argumentsList) => {
        commands.push(argumentsList[0] ?? "");
        return rejecting(git)(argumentsList);
      },
      npm: recordedNpm(calls),
      stopping: running,
    });
    assert.deepEqual(outcome, {
      kind: "skipped",
      step: "clean",
      output: "?? notes.txt",
    });
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.deepEqual(calls, []);
    assert.equal(commands.includes("fetch"), false);
  }));

await test("CLV-306 a failed build puts the checkout back on the old commit, installs and builds it again", () =>
  withUpdateRepository(async (fixture) => {
    await pushedLockChange(fixture);
    const calls: string[][] = [];
    const outcome = await updatedCheckout({
      git: rejecting(fixture.git),
      npm: recordedNpm(calls, ["run build"]),
      stopping: running,
    });
    assert.deepEqual(outcome, {
      kind: "failed",
      step: "build",
      output: "run build output\nerror TS2322: Type 'string' is not assignable",
    });
    assert.equal(fixture.git(["rev-parse", "HEAD"]), fixture.old);
    assert.deepEqual(calls, [
      ["ci", "--ignore-scripts"],
      ["run", "build"],
      ["ci", "--ignore-scripts"],
      ["run", "build"],
    ]);
  }));

await test("CLV-306 a failed install puts the checkout back on the old commit and installs it again", () =>
  withUpdateRepository(async (fixture) => {
    await pushedLockChange(fixture);
    const calls: string[][] = [];
    const outcome = await updatedCheckout({
      git: rejecting(fixture.git),
      npm: recordedNpm(calls, ["ci --ignore-scripts"]),
      stopping: running,
    });
    assert.equal(outcome.kind === "failed" ? outcome.step : "", "install");
    assert.equal(fixture.git(["rev-parse", "HEAD"]), fixture.old);
    assert.deepEqual(calls, [
      ["ci", "--ignore-scripts"],
      ["ci", "--ignore-scripts"],
      ["run", "build"],
    ]);
  }));

function failure(outcome: CheckoutUpdate): readonly [string, string] {
  return outcome.kind === "failed" ? [outcome.step, outcome.output] : ["", ""];
}

function broken(outcome: CheckoutUpdate): readonly [string, string] {
  return outcome.kind === "broken" ? [outcome.step, outcome.output] : ["", ""];
}

await test("CLV-306 an update refuses another branch, a commit that cannot fast-forward and a failed fetch", () =>
  withUpdateRepository(async ({ repository, git, old }) => {
    const calls: string[][] = [];
    const commands = {
      git: rejecting(git),
      npm: recordedNpm(calls),
      stopping: running,
    };
    git(["switch", "-q", "-c", "other"]);
    assert.deepEqual(failure(await updatedCheckout(commands)), [
      "branch",
      "The checkout is on refs/heads/other. The update needs refs/heads/main.",
    ]);
    git(["switch", "-q", "--detach", "main"]);
    const [detached] = failure(await updatedCheckout(commands));
    assert.equal(detached, "branch");
    git(["switch", "-q", "main"]);
    await writeFile(join(repository, "local.txt"), "local\n");
    git(["add", "local.txt"]);
    git(["commit", "-qm", "Local"]);
    const [step] = failure(await updatedCheckout(commands));
    assert.equal(step, "fast-forward");
    git(["reset", "-q", "--hard", old]);
    git(["remote", "set-url", "origin", join(repository, "missing.git")]);
    const [fetchStep, fetchOutput] = failure(await updatedCheckout(commands));
    assert.equal(fetchStep, "fetch");
    assert.match(fetchOutput, /missing\.git/);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.deepEqual(calls, []);
  }));

await test("CLV-306 a merge that would overwrite an ignored file fails at the merge step with no build", () =>
  withUpdateRepository(async ({ repository, git, old }) => {
    await writeFile(join(repository, "collision.txt"), "local contents\n");
    const calls: string[][] = [];
    const [step, output] = failure(
      await updatedCheckout({
        git: rejecting(git),
        npm: recordedNpm(calls),
        stopping: running,
      }),
    );
    assert.equal(step, "merge");
    assert.match(output, /collision\.txt/);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.deepEqual(calls, []);
  }));

await test("CLV-320 a failed rollback is a broken update with the output of the build and the rollback", () =>
  withUpdateRepository(async ({ git, old }) => {
    const outcome = await updatedCheckout({
      git: rejecting(git),
      npm: () => Promise.reject(new Error("build broke")),
      stopping: running,
    });
    assert.deepEqual(broken(outcome), [
      "build",
      `Error: build broke\nThe rollback to ${old} failed: Error: build broke`,
    ]);
    assert.equal(git(["rev-parse", "HEAD"]), old);
  }));

function refusing(
  git: (argumentsList: readonly string[]) => string,
  command: string,
): (argumentsList: readonly string[]) => Promise<string> {
  return (argumentsList) =>
    argumentsList[0] === command
      ? Promise.reject(new Error(`${command} refused`))
      : rejecting(git)(argumentsList);
}

await test("CLV-320 a failed status check fails at the clean step, and a failed reset is a broken update with its output", () =>
  withUpdateRepository(async ({ git, old, target }) => {
    const calls: string[][] = [];
    const [step] = failure(
      await updatedCheckout({
        git: refusing(git, "status"),
        npm: recordedNpm(calls),
        stopping: running,
      }),
    );
    assert.equal(step, "clean");
    assert.equal(git(["rev-parse", "HEAD"]), old);
    const outcome = await updatedCheckout({
      git: refusing(git, "reset"),
      npm: recordedNpm(calls, ["run build"]),
      stopping: running,
    });
    assert.deepEqual(broken(outcome), [
      "build",
      `run build output\nerror TS2322: Type 'string' is not assignable\nThe rollback to ${old} failed: Error: reset refused`,
    ]);
    assert.equal(git(["rev-parse", "HEAD"]), target);
    assert.deepEqual(calls, [["run", "build"]]);
  }));

async function blockingNpm(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "npm"),
    `#!/bin/sh\ntouch ${JSON.stringify(join(root, "npm-started"))}\nexec sleep 15\n`,
  );
  await chmod(join(bin, "npm"), 0o755);
  return bin;
}

await test("CLV-306 a stop ends a running update command, and a merge or a reset runs to its end", () =>
  withUpdateRepository(async ({ root, repository, git, old, target }) => {
    const bin = await blockingNpm(root);
    const stopping = new AbortController();
    const commands = checkoutCommands({
      checkout: repository,
      environment: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
      stopping: stopping.signal,
    });
    const build = commands.npm(["run", "build"]).then(
      () => "finished",
      () => "stopped",
    );
    await eventually(() =>
      existsSync(join(root, "npm-started")) ? true : undefined,
    );
    stopping.abort();
    assert.equal(
      await Promise.race([build, delay(5000, "running")]),
      "stopped",
    );
    await assert.rejects(commands.git(["rev-parse", "HEAD"]));
    await commands.git(["merge", "--ff-only", target]);
    assert.equal(git(["rev-parse", "HEAD"]), target);
    await commands.git(["reset", "--keep", old]);
    assert.equal(git(["rev-parse", "HEAD"]), old);
  }));

function npmStoppedAt(
  calls: string[][],
  stop: { readonly controller: AbortController; readonly call: number },
): (argumentsList: readonly string[]) => Promise<string> {
  return (argumentsList) => {
    calls.push([...argumentsList]);
    if (calls.length === stop.call) stop.controller.abort();
    return Promise.reject(new Error(`npm ${argumentsList.join(" ")} ended`));
  };
}

function stoppedNote(old: string, commands: string): string {
  return `The service stopped during the update. The checkout is back on ${old}. Run ${commands} in the checkout before the next start.`;
}

await test("CLV-306 a stop during the build puts the checkout back on the old commit and builds nothing again", () =>
  withUpdateRepository(async ({ git, old }) => {
    const calls: string[][] = [];
    const controller = new AbortController();
    const outcome = await updatedCheckout({
      git: rejecting(git),
      npm: npmStoppedAt(calls, { controller, call: 1 }),
      stopping: controller.signal,
    });
    assert.deepEqual(failure(outcome), [
      "build",
      `Error: npm run build ended\n${stoppedNote(old, "npm run build")}`,
    ]);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.deepEqual(calls, [["run", "build"]]);
  }));

await test("CLV-306 a stop during the install asks for an install and a build by hand", () =>
  withUpdateRepository(async (fixture) => {
    await pushedLockChange(fixture);
    const calls: string[][] = [];
    const controller = new AbortController();
    const outcome = await updatedCheckout({
      git: rejecting(fixture.git),
      npm: npmStoppedAt(calls, { controller, call: 1 }),
      stopping: controller.signal,
    });
    assert.deepEqual(failure(outcome), [
      "install",
      `Error: npm ci --ignore-scripts ended\n${stoppedNote(fixture.old, "npm ci --ignore-scripts and npm run build")}`,
    ]);
    assert.equal(fixture.git(["rev-parse", "HEAD"]), fixture.old);
    assert.deepEqual(calls, [["ci", "--ignore-scripts"]]);
  }));

await test("CLV-306 a stop during the build of the rollback gives the same note", () =>
  withUpdateRepository(async ({ git, old }) => {
    const calls: string[][] = [];
    const controller = new AbortController();
    const outcome = await updatedCheckout({
      git: rejecting(git),
      npm: npmStoppedAt(calls, { controller, call: 2 }),
      stopping: controller.signal,
    });
    assert.deepEqual(failure(outcome), [
      "build",
      `Error: npm run build ended\n${stoppedNote(old, "npm run build")}`,
    ]);
    assert.equal(git(["rev-parse", "HEAD"]), old);
    assert.deepEqual(calls, [
      ["run", "build"],
      ["run", "build"],
    ]);
  }));
