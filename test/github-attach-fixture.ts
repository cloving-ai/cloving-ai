import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Operation } from "../src/daemon/github-operation.ts";

export const target = "task-0123456789ab";
export const download =
  "https://github.com/acme/demo/releases/download/pr-demos/pr-12-demo.mp4";
export const payload = {
  number: 12,
  name: "demo.mp4",
  release: "pr-demos",
  comment: "Demo of the change.",
};
export const video = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(12),
]);

export interface Scene {
  readonly root: string;
  readonly attachments: string;
  readonly calls: (readonly string[])[];
}

export interface GithubState {
  releases: unknown[];
  uploaded?: Buffer;
  readonly comments: unknown[];
  readonly create?: "concurrent" | "refused";
  readonly onReleases?: () => void;
}

export function release(assets: readonly string[]): unknown {
  return {
    tag_name: "pr-demos",
    assets: assets.map((name) => ({
      name,
      browser_download_url: `https://github.com/acme/demo/releases/download/pr-demos/${name}`,
    })),
  };
}

function releaseCall(
  parts: readonly string[],
  state: GithubState,
): Promise<string> {
  if (parts[1] === "upload") {
    state.uploaded = readFileSync(String(parts[3]));
    state.releases = [release([basename(String(parts[3]))])];
    return Promise.resolve("");
  }
  if (state.create === "refused")
    return Promise.reject(new Error("github-call-failed"));
  state.releases = [release([])];
  if (state.create === "concurrent")
    return Promise.reject(new Error("github-call-failed"));
  return Promise.resolve("");
}

function readCall(
  joined: string,
  state: GithubState,
): Promise<string> | undefined {
  if (joined === "repo view --json nameWithOwner")
    return Promise.resolve(JSON.stringify({ nameWithOwner: "acme/demo" }));
  if (joined === "api user")
    return Promise.resolve(JSON.stringify({ login: "cloving-bot" }));
  if (joined.includes("/releases?per_page=100")) {
    state.onReleases?.();
    return Promise.resolve(JSON.stringify([state.releases]));
  }
  if (joined.includes("/issues/12/comments?per_page=100"))
    return Promise.resolve(JSON.stringify([state.comments]));
  return undefined;
}

export function fakeGh(
  scene: Scene,
  state: GithubState,
): (parts: readonly string[]) => Promise<string> {
  return (parts) => {
    scene.calls.push(parts);
    if (parts[0] === "release") return releaseCall(parts, state);
    return (
      readCall(parts.join(" "), state) ??
      Promise.resolve(JSON.stringify({ id: 77 }))
    );
  };
}

export function operation(
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
      git: () => Promise.resolve(""),
      run: () => Promise.reject(new Error("unexpected command")),
    },
    target,
    payload: request.payload,
    signal: new AbortController().signal,
    folder: join(scene.root, "operation"),
  };
}

export async function withScene(
  work: (scene: Scene) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cloving-attach-"));
  const attachments = join(root, "attachments", target);
  await mkdir(attachments, { recursive: true });
  await mkdir(join(root, "operation"), { recursive: true });
  await writeFile(join(attachments, "demo.mp4"), video);
  try {
    await work({ root, attachments, calls: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function releaseCalls(scene: Scene): number {
  return scene.calls.filter((parts) => parts[0] === "release").length;
}
