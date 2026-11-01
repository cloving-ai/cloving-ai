import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import { field, removeWorktree } from "../src/daemon/github-operation.ts";
import {
  fakeGh,
  operation,
  payload,
  releaseCalls,
  video,
  withScene,
} from "./github-attach-fixture.ts";

const attach = methods.get("attach-asset");

await test("CLV-268 attach-asset refuses unsafe names, releases and texts before any GitHub call", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const cases: readonly [Readonly<Record<string, unknown>>, RegExp][] = [
      [{ ...payload, name: "../demo.mp4" }, /invalid-payload/],
      [{ ...payload, name: "clips/demo.mp4" }, /invalid-payload/],
      [{ ...payload, name: "demo.exe" }, /invalid-payload/],
      [{ ...payload, release: "v1.4.0" }, /invalid-payload/],
      [{ ...payload, release: "PR demos" }, /invalid-payload/],
      [{ ...payload, number: 0 }, /invalid-payload/],
      [{ ...payload, name: "missing.mp4" }, /attachment-not-available/],
      [
        { ...payload, comment: `See ${scene.root}/notes.` },
        /private-path-in-change/,
      ],
    ];
    for (const [given, reason] of cases) {
      const gh = fakeGh(scene, { releases: [], comments: [] });
      await assert.rejects(
        attach(operation(scene, { payload: given, gh })),
        reason,
      );
    }
    assert.equal(releaseCalls(scene), 0);
  }));

await test("CLV-268 attach-asset refuses links, a large file and a file that is not a video", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    await writeFile(join(scene.root, "secret.mp4"), video);
    await symlink(
      join(scene.root, "secret.mp4"),
      join(scene.attachments, "link.mp4"),
    );
    await link(
      join(scene.root, "secret.mp4"),
      join(scene.attachments, "hard.mp4"),
    );
    await writeFile(join(scene.attachments, "text.mp4"), "not a video file");
    await writeFile(join(scene.attachments, "large.mp4"), video);
    await truncate(join(scene.attachments, "large.mp4"), 104_857_601);
    for (const [name, reason] of [
      ["link.mp4", /attachment-not-available/],
      ["hard.mp4", /attachment-not-available/],
      ["text.mp4", /attachment-not-available/],
      ["large.mp4", /attachment-too-large/],
    ] as const) {
      const gh = fakeGh(scene, { releases: [], comments: [] });
      await assert.rejects(
        attach(operation(scene, { payload: { ...payload, name }, gh })),
        reason,
      );
    }
    assert.equal(releaseCalls(scene), 0);
  }));

await test("CLV-268 attach-asset refuses a run folder that is a symbolic link", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const outside = join(scene.root, "outside");
    await rename(scene.attachments, outside);
    await symlink(outside, scene.attachments);
    const gh = fakeGh(scene, { releases: [], comments: [] });
    await assert.rejects(
      attach(operation(scene, { payload, gh })),
      /attachment-not-available/,
    );
    assert.equal(releaseCalls(scene), 0);
  }));

await test("CLV-268 attach-asset accepts real WebM and PNG files", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const files = [
      ["demo.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0])],
      [
        "frame.png",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ],
    ] as const;
    for (const [name, bytes] of files) {
      await writeFile(join(scene.attachments, name), bytes);
      const gh = fakeGh(scene, { releases: [], comments: [] });
      const result = await attach(
        operation(scene, { payload: { ...payload, name }, gh }),
      );
      assert.equal(
        field(result, "url"),
        `https://github.com/acme/demo/releases/download/pr-demos/pr-12-${name}`,
      );
    }
  }));

await test("CLV-268 attach-asset refuses a run with no attachment folder", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    await rm(scene.attachments, { recursive: true, force: true });
    const gh = fakeGh(scene, { releases: [], comments: [] });
    await assert.rejects(
      attach(operation(scene, { payload, gh })),
      /attachment-not-available/,
    );
    assert.equal(releaseCalls(scene), 0);
  }));

await test("CLV-268 removing the work tree of a run also removes its attachment folder", () =>
  withScene(async (scene) => {
    const gh = fakeGh(scene, { releases: [], comments: [] });
    const place = {
      path: join(scene.root, "worktrees", "task-0123456789ab"),
      branch: "cloving/task-0123456789ab",
    };
    await mkdir(place.path, { recursive: true });
    await removeWorktree(operation(scene, { payload, gh }), place);
    assert.equal(existsSync(scene.attachments), false);
  }));
