import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { adoptionRecordPath } from "../src/cli/runtime-directory.ts";
import {
  liveWorkspace,
  type WorkspaceMember,
} from "../src/cli/workspace-record.ts";
import type { WorkspaceHost } from "../src/cli/workspace-start.ts";
import {
  alpha,
  pair,
  root,
  servedHost,
  started,
} from "./workspace-start-harness.ts";

const environment = { XDG_STATE_HOME: join(root, "state") };
const legacy = join(root, "legacy/run");

async function adopted(host: WorkspaceHost): Promise<void> {
  const record = String(adoptionRecordPath(environment, host.repository));
  await mkdir(join(record, ".."), { recursive: true });
  await writeFile(
    record,
    JSON.stringify({
      schemaVersion: 1,
      repository: host.repository,
      runtimeDirectory: legacy,
    }),
  );
}

function watchedUntil(watching: Promise<unknown>) {
  return async (host: WorkspaceHost): Promise<number> => {
    if (host.repository === alpha) await adopted(host);
    else await servedHost(host);
    await watching;
    return 0;
  };
}

await test("CLV-312 the supervisor record and the watch page get the runtime directory that each repository adopted at its start", async () => {
  const watching = Promise.withResolvers<undefined>();
  const seen: (readonly WorkspaceMember[] | undefined)[] = [];
  const result = await started({
    workspace: pair,
    hosted: watchedUntil(watching.promise),
    watched: () => {
      seen.push(liveWorkspace(environment)?.members);
      watching.resolve(undefined);
      return Promise.resolve(0);
    },
  });
  assert.equal(result.status, 0, result.refused);
  assert.deepEqual(
    seen.map((members) => members?.map((member) => member.runtime)),
    [[legacy, result.hosts[1]?.runtime]],
  );
  await rm(join(root, "state/cloving/adopted-runtime"), {
    recursive: true,
    force: true,
  });
});

function endedWatches(statuses: readonly number[]) {
  const ended = Promise.withResolvers<undefined>();
  const calls = { count: 0 };
  const watched = async (watch: { readonly signal: AbortSignal }) => {
    const status = statuses[calls.count];
    calls.count += 1;
    if (status !== undefined) return status;
    ended.resolve(undefined);
    await new Promise((settle) => {
      watch.signal.addEventListener("abort", settle);
    });
    return 0;
  };
  const hosted = async (host: WorkspaceHost): Promise<number> => {
    await servedHost(host);
    await ended.promise;
    return 0;
  };
  return { watched, hosted, ended, calls };
}

await test("CLV-312 the supervisor reports each end of the watch page with an error and starts it again", async () => {
  const watch = endedWatches([1, 1]);
  const result = await started({
    workspace: pair,
    hosted: watch.hosted,
    watched: watch.watched,
    watchRestart: { delayMilliseconds: 1, limit: 5 },
  });
  assert.equal(result.status, 0);
  assert.equal(watch.calls.count, 3);
  assert.equal(
    result.refused,
    "workspace-watch-ended: The watch page ended with status 1. Cloving starts it again.\n".repeat(
      2,
    ),
  );
});

await test("CLV-312 after the restart limit the supervisor stops the watch page, keeps the repositories and ends with status 1", async () => {
  const watch = endedWatches([1, 1, 1]);
  const result = await started({
    workspace: pair,
    hosted: async (host) => {
      await servedHost(host);
      while (watch.calls.count < 3)
        await new Promise((settle) => setTimeout(settle, 10));
      return 0;
    },
    watched: watch.watched,
    watchRestart: { delayMilliseconds: 1, limit: 2 },
  });
  assert.equal(result.status, 1);
  assert.equal(watch.calls.count, 3);
  assert.ok(result.hosts.every((host) => !host.signal.aborted));
  assert.match(
    result.refused,
    /workspace-watch-stopped: The watch page ended with status 1 3 times\. The repositories keep running with no watch page\.\n$/,
  );
});

await test("CLV-312 when the supervisor cannot update its record, it reports the failure, starts no watch page and ends with status 1", async () => {
  const folder = join(root, "state/cloving/workspace");
  await rm(join(root, "state/cloving"), { recursive: true, force: true });
  const result = await started({
    workspace: pair,
    hosted: async (host) => {
      if (host.repository === alpha) {
        await rm(folder, { recursive: true, force: true });
        await writeFile(folder, "");
      }
      await servedHost(host);
      await new Promise((settle) => setTimeout(settle, 500));
      return 0;
    },
  });
  await rm(folder, { force: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.watches, []);
  assert.match(result.refused, /^workspace-watch-failed: /);
});
