import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import type { Operation } from "../src/daemon/github-operation.ts";

const target = "task-0123456789ab";
const download =
  "https://github.com/acme/demo/releases/download/pr-demos/pr-12-demo.mp4";

interface Scene {
  readonly root: string;
  readonly attachments: string;
  readonly calls: (readonly string[])[];
}

function release(assets: readonly string[]): unknown {
  return {
    tag_name: "pr-demos",
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://github.com/acme/demo/releases/download/pr-demos/${name}`,
    })),
  };
}

function fakeGh(
  scene: Scene,
  state: { releases: unknown[]; readonly comments: unknown[] },
): (parts: readonly string[]) => Promise<string> {
  return (parts) => {
    scene.calls.push(parts);
    const joined = parts.join(" ");
    if (joined === "repo view --json nameWithOwner")
      return Promise.resolve(JSON.stringify({ nameWithOwner: "acme/demo" }));
    if (joined.includes("/releases?per_page=100"))
      return Promise.resolve(JSON.stringify([state.releases]));
    if (parts[0] === "release" && parts[1] === "create") {
      state.releases = [release([])];
      return Promise.resolve("");
    }
    if (parts[0] === "release" && parts[1] === "upload") {
      state.releases = [release(["pr-12-demo.mp4"])];
      return Promise.resolve("");
    }
    if (joined.includes("/issues/12/comments?per_page=100"))
      return Promise.resolve(JSON.stringify([state.comments]));
    return Promise.resolve(JSON.stringify({ id: 77 }));
  };
}

function operation(
  scene: Scene,
  request: {
    readonly payload: Readonly<Record<string, unknown>>;
    readonly gh: (parts: readonly string[]) => Promise<string>;
  },
): Operation {
  return {
    settings: {
      repository: join(scene.root, "repository"),
      worktrees: join(scene.root, "worktrees"),
      gh: ["gh"],
      environment: {},
      privateTexts: ["zapier"],
    },
    calls: {
      gh: request.gh,
      git: () => Promise.reject(new Error("unexpected git call")),
      run: () => Promise.reject(new Error("unexpected command")),
    },
    target,
    payload: request.payload,
    signal: new AbortController().signal,
    folder: join(scene.root, "operation"),
  };
}

async function withScene(work: (scene: Scene) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-attach-"));
  const attachments = join(root, "attachments", target);
  await mkdir(attachments, { recursive: true });
  await mkdir(join(root, "operation"), { recursive: true });
  await writeFile(join(attachments, "demo.mp4"), "video");
  try {
    await work({ root, attachments, calls: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const attach = methods.get("attach-asset");
const payload = {
  number: 12,
  name: "demo.mp4",
  release: "pr-demos",
  comment: "Demo of the change.",
};

await test("CLV-268 attach-asset creates the demo release, uploads the file and comments on the pull request", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const gh = fakeGh(scene, { releases: [], comments: [] });
    const result = await attach(operation(scene, { payload, gh }));
    assert.deepEqual(result, { number: 12, url: download });
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

await test("CLV-268 a second attach updates its comment and creates no release", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const gh = fakeGh(scene, {
      releases: [release(["pr-12-demo.mp4"])],
      comments: [
        { id: 5, body: "Old.\n\n<!-- cloving-attachment:12:demo.mp4 -->" },
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
    assert.equal(
      scene.calls.some((parts) => parts[0] === "release"),
      false,
    );
  }));

await test("CLV-268 attach-asset refuses a symbolic link and a file over 100 MB", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    await writeFile(join(scene.root, "secret.mp4"), "secret");
    await symlink(
      join(scene.root, "secret.mp4"),
      join(scene.attachments, "link.mp4"),
    );
    await writeFile(join(scene.attachments, "large.mp4"), "");
    await truncate(join(scene.attachments, "large.mp4"), 104_857_601);
    for (const [name, reason] of [
      ["link.mp4", /attachment-not-available/],
      ["large.mp4", /attachment-too-large/],
    ] as const) {
      const gh = fakeGh(scene, { releases: [], comments: [] });
      await assert.rejects(
        attach(operation(scene, { payload: { ...payload, name }, gh })),
        reason,
      );
    }
    assert.equal(
      scene.calls.some((parts) => parts[0] === "release"),
      false,
    );
  }));
