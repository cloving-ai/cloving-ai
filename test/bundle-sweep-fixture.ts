import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  currentBundle,
  type BundleSweepSettings,
  type CurrentBundle,
} from "../src/daemon/bundle-sweep.ts";
import type { WorkflowReload } from "../src/service/workflow-reload.ts";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import { withFiles } from "./quality/files-fixture.ts";

export const day = 86_400_000;

interface BundleInput {
  readonly directory: string;
  readonly project: string;
  readonly repository: string;
}

export interface BundleScene {
  readonly root: string;
  readonly store: string;
  readonly now: number;
  readonly lines: string[];
  readonly project: (name: string) => BundleInput;
  readonly lookup: (id: string) => Omit<BundleInput, "project"> & {
    readonly id: string;
  };
  readonly aged: (path: string, days: number) => Promise<void>;
  readonly bundle: (name: string, daysAgo: number) => Promise<string>;
  readonly current: (digest: string | undefined) => CurrentBundle;
  readonly settings: (
    overrides?: Partial<BundleSweepSettings>,
  ) => BundleSweepSettings;
}

const sources: Readonly<Record<string, string>> = {
  "package.json": '{"name":"synthetic","type":"module"}',
  "declarations.json": "[]",
  "dependencies.json": "{}",
  "fixture.workflow.json": '{"artifacts":"artifacts"}',
  "artifacts/flow.mjs": "compiled flow",
  "artifacts/steps.mjs": "compiled steps",
  "artifacts/client.mjs": "compiled client",
  "artifacts/manifest.json": "{}",
  "artifacts/flow.mjs.__wf_tmp.js.debug.json": "{}",
  "artifacts/steps.mjs.debug.json": "{}",
};

export function reloadedTo(bundleDigest: string): WorkflowReload {
  return {
    kind: "reloaded",
    bundleDigest,
    workflows: [],
    workflowRefusals: [],
    reloadedFields: [],
    restartFields: [],
  };
}

async function written(project: string, name: string): Promise<void> {
  const files = {
    ...sources,
    "workflows/fixture.ts": `export const name = ${JSON.stringify(name)};`,
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), contents);
  }
}

function scene(root: string): BundleScene {
  const now = Date.now();
  const lines: string[] = [];
  const store = join(root, "workflow-bundles");
  const repository = join(root, "repo");
  const log = (line: string) => lines.push(line);
  const aged = async (path: string, days: number) => {
    const moment = new Date(now - days * day);
    await utimes(path, moment, moment);
  };
  const project = (name: string) => ({
    directory: store,
    project: join(root, "sources", name),
    repository,
  });
  const current = (digest: string | undefined) =>
    currentBundle({
      directory: root,
      bundleDigest: digest,
      now: () => now,
      log,
    });
  return {
    root,
    store,
    now,
    lines,
    project,
    lookup: (id) => ({ directory: store, repository, id }),
    aged,
    bundle: async (name, daysAgo) => {
      await written(project(name).project, name);
      const digest = await retainWorkflowBundle(project(name));
      await aged(join(store, digest), daysAgo);
      return digest;
    },
    current,
    settings: (overrides = {}) => ({
      directory: root,
      retention: { days: 30, action: "delete", archiveFolder: null },
      current: current(undefined),
      pinned: () => Promise.resolve([]),
      now: () => now,
      log,
      ...overrides,
    }),
  };
}

export function withBundles(
  body: (scene: BundleScene) => Promise<void>,
): Promise<void> {
  return withFiles({ "repo/marker": "" }, (root) => body(scene(root)));
}
