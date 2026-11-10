import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activeOwners,
  ownTurn,
  ownedProcesses,
} from "../src/daemon/turn-owners.ts";
import { signalTargets } from "../src/daemon/worktree-selection.ts";

const tree = "/work/tree";
const user = 501;

function row(
  processId: number,
  links: { readonly parent: number; readonly group: number },
) {
  return {
    processId,
    parent: links.parent,
    group: links.group,
    user,
    seconds: 10,
    command: "node",
    directory: tree,
  };
}

const turnB = { runId: "run-b", processId: 200 };

await test("CLV-346 when turn A ends, the selection keeps the leftovers of A and its orphan, and no process of the active turn B", () => {
  const entries = [
    row(300, { parent: 1, group: 300 }),
    row(301, { parent: 300, group: 300 }),
    row(200, { parent: 50, group: 50 }),
    row(201, { parent: 200, group: 50 }),
    row(202, { parent: 201, group: 50 }),
  ];
  const owned = ownedProcesses(entries, [turnB]);
  assert.deepEqual(
    [...owned].sort(([left], [right]) => left - right),
    [
      [200, "run-b"],
      [201, "run-b"],
      [202, "run-b"],
    ],
  );
  const { found, targets } = signalTargets(entries, {
    directory: tree,
    user,
    owned,
  });
  assert.deepEqual(
    found.map((entry) => entry.processId),
    [300, 301],
  );
  assert.deepEqual(targets, [-300]);
});

await test("CLV-346 a process group with a member of another active turn gets one signal for each other member and no group signal", () => {
  const entries = [
    row(200, { parent: 50, group: 50 }),
    row(501, { parent: 200, group: 500 }),
    row(502, { parent: 1, group: 500 }),
    row(601, { parent: 1, group: 600 }),
    row(602, { parent: 601, group: 600 }),
  ];
  const owned = ownedProcesses(entries, [turnB]);
  const { targets } = signalTargets(entries, {
    directory: tree,
    user,
    owned,
  });
  assert.deepEqual(targets, [502, -600]);
});

await test("CLV-346 a turn root that leads its own process group owns each member of the group", () => {
  const entries = [
    row(700, { parent: 50, group: 700 }),
    row(701, { parent: 1, group: 700 }),
    row(702, { parent: 1, group: 702 }),
  ];
  const owned = ownedProcesses(entries, [{ runId: "run-b", processId: 700 }]);
  assert.deepEqual(
    [...owned.keys()].sort((left, right) => left - right),
    [700, 701],
  );
});

await test("CLV-346 with no other active turn, the selection is the same as before", () => {
  const entries = [
    row(300, { parent: 1, group: 300 }),
    row(301, { parent: 300, group: 300 }),
    row(401, { parent: 1, group: 400 }),
    { ...row(402, { parent: 1, group: 400 }), directory: "/elsewhere" },
  ];
  const owned = ownedProcesses(entries, []);
  assert.equal(owned.size, 0);
  const { found, targets } = signalTargets(entries, {
    directory: tree,
    user,
    owned,
  });
  assert.deepEqual(
    found.map((entry) => entry.processId),
    [300, 301, 401],
  );
  assert.deepEqual(targets, [-300, 401]);
});

await test("CLV-346 a turn owns its work tree until it ends, also through a link to the work tree", async () => {
  const folder = await mkdtemp(join(tmpdir(), "clv-346-"));
  const work = join(folder, "work");
  const alias = join(folder, "alias");
  await mkdir(work);
  await symlink(work, alias);
  try {
    const ended = ownTurn(alias, turnB);
    assert.deepEqual(await activeOwners(work), [turnB]);
    assert.deepEqual(await activeOwners(join(folder, "other")), []);
    ended();
    assert.deepEqual(await activeOwners(work), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

await test("CLV-346 the README states that a turn end and a resume keep the processes of another active turn", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(
    readme,
    /When a turn ends, Cloving stops each process whose current folder is in the work tree of the run and that started after the start of the turn, except the processes of another active turn in the same work tree\./,
  );
  assert.match(
    readme,
    /A process belongs to an active turn when it is the root process of the turn, a descendant of that root by parent process ID, or a member of the process group that the root leads\./,
  );
  assert.match(
    readme,
    /`turn: stopped process <pid> \(<command>\) that run <run-id> left in the work tree <path>`.*`turn: kept process <pid> \(<command>\) of the active run <run-id> in the work tree <path>`/,
  );
  assert.match(
    readme,
    /Before a Claude resume after a daemon restart or a dead turn process, Cloving stops same-user processes whose working directories are in the turn work tree, except the processes of the other active turns of the daemon,/,
  );
});
