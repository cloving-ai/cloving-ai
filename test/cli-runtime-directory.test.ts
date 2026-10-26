import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  clientCommand,
  runtimeDirectory,
} from "../src/cli/runtime-directory.ts";
import { socketAddress } from "../src/broker/socket-address.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-204 two repositories have distinct default runtime directories", () =>
  withFiles({ "project/file": "", "site/file": "" }, (root) => {
    const environment = { XDG_STATE_HOME: join(root, "state") };
    const project = runtimeDirectory(environment, join(root, "project"));
    const site = runtimeDirectory(environment, join(root, "site"));
    assert.notEqual(project, site);
  }));

await test("CLV-204 long repository runtime paths retain the socket byte limit", () =>
  withFiles({ "repository/file": "" }, (root) => {
    const runtime = runtimeDirectory(
      { XDG_RUNTIME_DIR: join(root, "界".repeat(120)) },
      join(root, "repository"),
    );
    assert.ok(runtime);
    const path = join(runtime, "control.sock");
    assert.ok(Buffer.byteLength(path) > 103);
    assert.ok(Buffer.byteLength(relative(process.cwd(), path)) > 103);
    const address = socketAddress(path);
    assert.equal(address.kind, "refused");
    assert.ok("reason" in address);
    assert.equal(address.reason, "runtime-path-too-long");
  }));

await test("CLV-204 guide command prefixes preserve repository and override shell arguments", () => {
  const repository = "/example/a project'with;$characters";
  const prefix = clientCommand({}, repository);
  const output = execFileSync(
    "sh",
    ["-c", `set -- ${prefix}; printf '%s\\n' "$@"`],
    { encoding: "utf8" },
  );
  assert.deepEqual(output.trimEnd().split("\n"), [
    "cloving",
    "--repository",
    repository,
  ]);
  assert.equal(prefix.includes("CLOVING_RUNTIME_DIR="), false);
  assert.equal(
    clientCommand({ CLOVING_RUNTIME_DIR: "/explicit/run" }, repository),
    "CLOVING_RUNTIME_DIR=/explicit/run cloving",
  );
});

await test("CLV-204 defaults use the canonical repository name, digest and root priority", () =>
  withFiles({ "A project!_with-a-very-long-name/file": "" }, async (root) => {
    const repository = join(root, "A project!_with-a-very-long-name");
    const id = createHash("sha256")
      .update(repository)
      .digest("hex")
      .slice(0, 8);
    const suffix = join("cloving", `Aproject_with-a-very-lon-${id}`, "run");
    const environment = {
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
      HOME: root,
    };
    assert.equal(
      runtimeDirectory(environment, repository),
      join(root, "runtime", suffix),
    );
    assert.equal(
      runtimeDirectory({ ...environment, XDG_RUNTIME_DIR: "" }, repository),
      join(root, "state", suffix),
    );
    assert.equal(
      runtimeDirectory({ HOME: root }, repository),
      join(root, ".local/state", suffix),
    );
    await symlink(repository, join(root, "alias"));
    assert.equal(
      runtimeDirectory(environment, join(root, "alias")),
      runtimeDirectory(environment, repository),
    );
    assert.equal(runtimeDirectory({}, repository), undefined);
    assert.equal(runtimeDirectory(environment), undefined);
    assert.equal(
      runtimeDirectory({ CLOVING_RUNTIME_DIR: "/explicit" }),
      "/explicit",
    );
  }));
