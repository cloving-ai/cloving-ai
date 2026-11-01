import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import {
  download,
  fakeGh,
  operation,
  payload,
  release,
  video,
  withScene,
  type GithubState,
} from "./github-attach-fixture.ts";

const attach = methods.get("attach-asset");

await test("CLV-268 attach-asset creates the demo release, uploads the file and comments on the pull request", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const state: GithubState = { releases: [], comments: [] };
    const gh = fakeGh(scene, state);
    const result = await attach(operation(scene, { payload, gh }));
    assert.deepEqual(result, { number: 12, url: download });
    assert.ok(state.uploaded?.equals(video));
    const create = scene.calls.find(
      (parts) => parts[0] === "release" && parts[1] === "create",
    );
    assert.ok(create);
    assert.deepEqual(create.slice(0, 3), ["release", "create", "pr-demos"]);
    assert.ok(create.includes("--prerelease"));
    assert.ok(create.includes("--latest=false"));
    const upload = scene.calls.find(
      (parts) => parts[0] === "release" && parts[1] === "upload",
    );
    assert.deepEqual(upload, [
      "release",
      "upload",
      "pr-demos",
      join(scene.root, "operation", "pr-12-demo.mp4"),
      "--clobber",
    ]);
    const comment = scene.calls.at(-1) ?? [];
    assert.ok(comment.includes("repos/{owner}/{repo}/issues/12/comments"));
    const body = comment.find((part) => part.startsWith("body=")) ?? "";
    assert.match(body, /^body=Demo of the change\./);
    assert.ok(body.includes(`[demo.mp4](${download})`));
    assert.ok(body.includes("<!-- cloving-attachment:12:demo.mp4 -->"));
    assert.equal(
      existsSync(join(scene.root, "operation", "pr-12-demo.mp4")),
      false,
    );
  }));

await test("CLV-268 a second attach updates its own comment and creates no release", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const gh = fakeGh(scene, {
      releases: [release(["pr-12-demo.mp4"])],
      comments: [
        {
          id: 5,
          body: "Old.\n\n<!-- cloving-attachment:12:demo.mp4 -->",
          user: { login: "cloving-bot" },
        },
      ],
    });
    await attach(operation(scene, { payload, gh }));
    assert.equal(
      scene.calls.some((parts) => parts[1] === "create"),
      false,
    );
    const update = scene.calls.at(-1) ?? [];
    assert.ok(update.includes("PATCH"));
    assert.ok(update.includes("repos/{owner}/{repo}/issues/comments/5"));
  }));

await test("CLV-268 a marked comment of another author gets no update, and the daemon posts its own", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const gh = fakeGh(scene, {
      releases: [release(["pr-12-demo.mp4"])],
      comments: [
        {
          id: 5,
          body: "<!-- cloving-attachment:12:demo.mp4 -->",
          user: { login: "someone" },
        },
      ],
    });
    await attach(operation(scene, { payload, gh }));
    assert.equal(
      scene.calls.some((parts) => parts.includes("PATCH")),
      false,
    );
    const posted = scene.calls.at(-1) ?? [];
    assert.ok(posted.includes("repos/{owner}/{repo}/issues/12/comments"));
  }));

await test("CLV-268 a release that another call creates at the same time is used", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const gh = fakeGh(scene, {
      releases: [],
      comments: [],
      create: "concurrent",
    });
    assert.deepEqual(await attach(operation(scene, { payload, gh })), {
      number: 12,
      url: download,
    });
  }));

await test("CLV-268 a refused release creation fails when no release exists", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const gh = fakeGh(scene, { releases: [], comments: [], create: "refused" });
    await assert.rejects(
      attach(operation(scene, { payload, gh })),
      /github-call-failed/,
    );
    assert.equal(
      scene.calls.some((parts) => parts[1] === "upload"),
      false,
    );
  }));
