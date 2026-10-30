import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { issueQueue } from "../src/daemon/issue-queue.ts";
import { listen, type Handle } from "../src/service/transport.ts";
import { selfUpdateActive } from "../tools/self-update-host.ts";
import { selfUpdater } from "../tools/self-update.ts";
import { lockCommand, withUpdate } from "./self-update-fixture.ts";
import { withHarness } from "./service-fixture.ts";

function heldSubmission(code = "no-ready-ticket") {
  const submitting = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const handle: Handle = async (request) => {
    if (request.operation === "status")
      return { kind: "result", result: { runs: [], next: null } };
    submitting.resolve(undefined);
    await release.promise;
    return {
      kind: "error",
      error: { code, detail: code },
    };
  };
  return { submitting, release, handle };
}

await test("CLV-138 update eligibility checks cannot hide a newly active run", async () => {
  await withUpdate(async (fixture) => {
    let marked = false;
    const updater = selfUpdater({
      ...fixture.settings,
      git: async (argumentsList) => {
        if (argumentsList.join(" ") === lockCommand) {
          marked = await readFile(
            join(fixture.directory, "pending-self-update"),
            "utf8",
          ).then(
            () => true,
            () => false,
          );
          fixture.worker.active = true;
        }
        return fixture.settings.git(argumentsList);
      },
    });
    assert.equal(await updater.check(), undefined);
    assert.equal(fixture.actions.includes("stop"), false);
    assert.equal(marked, true);
    assert.ok(
      Number(
        await readFile(join(fixture.directory, "pending-self-update"), "utf8"),
      ) > 0,
    );
  });
});

await test("CLV-138 an expired queue hold is renewed before the final idle check", async () => {
  await withUpdate(async (fixture) => {
    const mark = join(fixture.directory, "pending-self-update");
    const expired = Date.now() - 31 * 60 * 1000;
    await writeFile(mark, `${String(expired)}\n`);
    const observed: number[] = [];
    const updater = selfUpdater({
      ...fixture.settings,
      active: async () => {
        observed.push(Number(await readFile(mark, "utf8")));
        return false;
      },
    });
    assert.equal(await updater.check(), 75);
    assert.equal(observed[0], expired);
    assert.ok(Number(observed[1]) > expired + 30 * 60 * 1000);
  });
});

await test("CLV-138 an in-flight queue submission prevents updating before its run is visible", async () => {
  await withHarness(async ({ stateDirectory: directory, runtimeDirectory }) => {
    await withUpdate(async (fixture) => {
      const { submitting, release, handle } = heldSubmission();
      const listener = await listen({
        path: join(runtimeDirectory, "control.sock"),
        handle,
      });
      const queue = issueQueue({
        workflowId: "develop-issue",
        directory,
        runtimeDirectory,
        intervalMilliseconds: 5,
      });
      try {
        await submitting.promise;
        const updater = selfUpdater({
          ...fixture.settings,
          directory,
          active: () => selfUpdateActive({ directory, runtimeDirectory }),
        });
        assert.equal(await updater.check(), undefined);
        assert.equal(fixture.actions.includes("stop"), false);
        assert.ok(
          Number(
            await readFile(join(directory, "pending-self-update"), "utf8"),
          ) > 0,
        );
        release.resolve(undefined);
        await queue.stop();
        assert.equal(await updater.check(), 75);
      } finally {
        release.resolve(undefined);
        await queue.stop();
        await listener.close();
      }
    });
  });
});

await test("CLV-138 a failed queue submission releases its marker so updating can proceed", async () => {
  await withHarness(async ({ stateDirectory: directory, runtimeDirectory }) => {
    await withUpdate(async (fixture) => {
      const { submitting, release, handle } =
        heldSubmission("invalid-ticket-id");
      const listener = await listen({
        path: join(runtimeDirectory, "control.sock"),
        handle,
      });
      const queue = issueQueue({
        workflowId: "develop-issue",
        directory,
        runtimeDirectory,
        intervalMilliseconds: 5,
      });
      try {
        await submitting.promise;
        const updater = selfUpdater({
          ...fixture.settings,
          directory,
          active: () => selfUpdateActive({ directory, runtimeDirectory }),
        });
        assert.equal(await updater.check(), undefined);
        assert.equal(fixture.actions.includes("stop"), false);
        release.resolve(undefined);
        await queue.stop();
        await assert.rejects(readFile(join(directory, "queue-submission")), {
          code: "ENOENT",
        });
        assert.equal(await updater.check(), 75);
        assert.equal(fixture.actions.includes("stop"), true);
      } finally {
        release.resolve(undefined);
        await queue.stop();
        await listener.close();
      }
    });
  });
});
