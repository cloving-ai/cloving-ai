import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packedCommand as command } from "./packed-install-fixture.ts";
import { operatorRefusals, runOperator } from "./operator-startup-fixture.ts";
import { field } from "./self-host-fixture.ts";

interface PackedReloadFixture {
  readonly root: string;
  readonly repository: string;
  readonly runtimeDirectory: string;
}

async function reloadedWorkflowFiles(root: string): Promise<void> {
  const folder = join(root, "config/cloving/workflows");
  const source = await readFile(join(folder, "user's-workflow.ts"), "utf8");
  const declaration = await readFile(
    join(folder, "user's-workflow.declaration.json"),
    "utf8",
  );
  await writeFile(
    join(folder, "reloaded.ts"),
    source.replace("userWorkflow", "reloadedWorkflow"),
  );
  await writeFile(
    join(folder, "reloaded.declaration.json"),
    declaration.replace('"user-run"', '"reloaded-run"'),
  );
}

interface PackedCli {
  readonly root: string;
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
}

function asked(cli: PackedCli, operation: "reload" | "status"): unknown {
  return JSON.parse(
    command(cli.executable, {
      args: [operation, "--json"],
      cwd: cli.root,
      env: cli.env,
    }),
  );
}

export async function packedReload(
  fixture: PackedReloadFixture,
  settings: { readonly executable: string; readonly env: NodeJS.ProcessEnv },
): Promise<void> {
  const cli = { root: fixture.root, ...settings };
  const before = field(asked(cli, "status"), "bundleDigest");
  await reloadedWorkflowFiles(fixture.root);
  const reply = asked(cli, "reload");
  assert.equal(field(reply, "status"), "reloaded", JSON.stringify(reply));
  assert.equal(field(reply, "previousBundleDigest"), before);
  assert.match(String(field(reply, "bundleDigest")), /^[0-9a-f]{64}$/);
  assert.notEqual(field(reply, "bundleDigest"), before);
  assert.deepEqual(field(reply, "workflows"), [
    "decision-wait",
    "project-run",
    "approval",
    "user-run",
    "reloaded-run",
  ]);
  assert.deepEqual(field(reply, "workflowRefusals"), operatorRefusals);
  const status = asked(cli, "status");
  assert.equal(field(status, "bundleDigest"), field(reply, "bundleDigest"));
  await runOperator(fixture, "reloaded-run");
}
