import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import packageMetadata from "#package" with { type: "json" };
import { record } from "../src/protocol.ts";
import {
  isWorkflowDeclaration,
  type DeclaredWorkflow,
} from "../src/workflow-declaration.ts";
import {
  bundledWorkflowIds,
  type WorkflowReservation,
} from "../src/workflow-discovery.ts";
import type { WorkflowRefusal } from "../src/workflow-refusals.ts";
import {
  workflowDeclarations,
  workflowFiles,
  workflowManifests,
} from "./self-host-workflows.ts";
import {
  loadWorkflowFolders,
  type WorkflowFolderCandidate,
} from "./workflow-folders.ts";
import { isWorkflowManifest } from "./workflow-manifest.ts";
import { retainWorkflowBundle } from "./workflow-bundles.ts";
import {
  workflowBundleDependencies,
  workflowPackageRoot,
} from "./workflow-bundle-dependencies.ts";

interface ProjectSettings {
  readonly product: string;
  readonly project: string;
  readonly repository: string;
  readonly home: string;
  readonly xdgConfigHome?: string | undefined;
}

export interface RegisteredWorkflows {
  readonly repository: string;
  readonly bundleDigest: string;
  readonly manifests: Readonly<Record<string, string>>;
  readonly declarations: readonly DeclaredWorkflow[];
  readonly workflowRefusals: readonly WorkflowRefusal[];
}

async function initializeProject(
  settings: ProjectSettings,
): Promise<readonly string[]> {
  const { project, product } = settings;
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, "workflows"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(project, "package.json"),
    '{"name":"cloving-self-host","private":true,"type":"module"}',
  );
  const files = await workflowFiles(join(product, "workflows"));
  for (const file of files) await copyWorkflow(settings, file);
  const modules = join(project, "node_modules");
  await mkdir(join(modules, "cloving"), { recursive: true });
  for (const name of Object.keys(packageMetadata.dependencies)) {
    const location = findPackageJSON(name, join(product, "package.json"));
    if (location === undefined)
      throw new Error(`missing-runtime-dependency: ${name}`);
    await mkdir(dirname(join(modules, name)), { recursive: true });
    await symlink(dirname(location), join(modules, name));
  }
  await symlink(join(product, "src"), join(modules, "cloving", "src"));
  await writeFile(
    join(modules, "cloving", "package.json"),
    JSON.stringify({
      name: packageMetadata.name,
      version: packageMetadata.version,
      type: "module",
      exports: Object.fromEntries(
        Object.keys(packageMetadata.exports)
          .filter((subpath) => subpath.startsWith("./workflows"))
          .map((subpath) => [
            subpath,
            `./src/${subpath.slice("./workflows/".length) || "workflows"}${extname(import.meta.filename)}`,
          ]),
      ),
    }),
  );
  return files;
}

async function compile(settings: ProjectSettings) {
  const { product, project } = settings;
  await rm(join(project, "artifacts"), { recursive: true, force: true });
  await new Promise<void>((settle, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(
          product,
          `tools/compile-workflows${extname(import.meta.filename)}`,
        ),
        "workflows",
        "artifacts",
      ],
      { cwd: project, env: process.env, stdio: "ignore", timeout: 30000 },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) settle();
      else reject(new Error("The workflows did not compile."));
    });
  });
  const compiled: unknown = JSON.parse(
    await readFile(join(project, "artifacts/manifest.json"), "utf8"),
  );
  if (!isWorkflowManifest(compiled))
    throw new Error("The compiled workflow manifest is invalid.");
  return compiled;
}

function reservations(input: {
  readonly files: readonly string[];
  readonly manifests: ReturnType<typeof workflowManifests>;
  readonly declarations: readonly DeclaredWorkflow[];
}): readonly WorkflowReservation[] {
  const { files, manifests, declarations } = input;
  return [
    ...files.map((file) => ({
      baseName: basename(file, extname(file)),
    })),
    ...Object.entries(manifests).map(([functionName, manifest]) => ({
      baseName: manifest.name,
      workflowId: manifest.workflowId,
      functionName,
    })),
    ...[
      ...Object.values(bundledWorkflowIds),
      ...declarations.map((item) => item.workflowId),
    ].map((workflowId) => ({ workflowId })),
  ];
}

interface StagedCandidate {
  readonly candidate: WorkflowFolderCandidate;
  readonly file: string;
}

async function stageCandidates(
  project: string,
  candidates: readonly WorkflowFolderCandidate[],
): Promise<readonly StagedCandidate[]> {
  if (candidates.length === 0) return [];
  const directory = join(project, "workflows", "operators");
  await mkdir(directory, { mode: 0o700 });
  const staged: StagedCandidate[] = [];
  for (const candidate of candidates) {
    const name = createHash("sha256")
      .update(
        JSON.stringify([
          candidate.scope,
          candidate.baseName,
          candidate.source,
          candidate.declaration,
          Object.entries(candidate.helpers).sort(([left], [right]) =>
            left < right ? -1 : Number(left > right),
          ),
        ]),
      )
      .digest("hex");
    const root =
      Object.keys(candidate.helpers).length > 0
        ? join(directory, name)
        : directory;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = join(root, `${name}.ts`);
    await writeFile(file, candidate.source);
    await writeFile(
      join(root, `${name}.declaration.json`),
      candidate.declaration,
    );
    for (const [path, source] of Object.entries(candidate.helpers)) {
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, source);
    }
    staged.push({ candidate, file });
  }
  return staged;
}

function operatorDeclaration(
  staged: StagedCandidate & { readonly project: string },
  compiled: Awaited<ReturnType<typeof compile>>,
): DeclaredWorkflow {
  const { candidate, project } = staged;
  const declaration = record(JSON.parse(candidate.declaration))?.["workflow"];
  const entries = Object.entries(compiled.workflows ?? {}).filter(
    ([file]) => resolve(project, file) === staged.file,
  );
  const functions = entries.flatMap(([, functions]) =>
    Object.values(functions),
  );
  const [workflow] = functions;
  if (
    !isWorkflowDeclaration(declaration) ||
    functions.length !== 1 ||
    workflow === undefined
  )
    throw new Error(
      "The admitted workflow is missing from the compiled bundle.",
    );
  return {
    ...declaration,
    capabilities: [...new Set(declaration.capabilities)],
    functionName: workflow.workflowId.slice(
      workflow.workflowId.lastIndexOf("//") + 2,
    ),
  };
}

async function copyWorkflow(
  settings: ProjectSettings,
  file: string,
): Promise<void> {
  const { product, project } = settings;
  await copyFile(
    join(product, "workflows", file),
    join(project, "workflows", file),
  );
  const sidecar = `${basename(file, extname(file))}.declaration.json`;
  const declaration = await readFile(join(product, "workflows", sidecar)).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    },
  );
  if (declaration !== undefined)
    await writeFile(join(project, "workflows", sidecar), declaration);
}

export async function preparedProject(
  settings: ProjectSettings,
): Promise<RegisteredWorkflows> {
  const { product, project } = settings;
  const files = await initializeProject(settings);
  let compiled = await compile(settings);
  const bundled = workflowManifests(compiled);
  const declarations = await workflowDeclarations(
    join(project, "workflows"),
    bundled,
  );
  const folders = await loadWorkflowFolders(
    {
      ...settings,
      bundled: reservations({ files, manifests: bundled, declarations }),
    },
    { packageRoot: await workflowPackageRoot(product) },
  );
  const staged = await stageCandidates(project, folders.candidates);
  if (staged.length > 0) compiled = await compile(settings);
  const combined = [
    ...declarations,
    ...staged.map((candidate) =>
      operatorDeclaration({ ...candidate, project }, compiled),
    ),
  ];
  const manifests: Record<string, string> = {};
  for (const [functionName, manifest] of Object.entries(
    workflowManifests(compiled, combined),
  )) {
    const path = join(project, `${manifest.name}.workflow.json`);
    await writeFile(path, JSON.stringify(manifest));
    Object.defineProperty(manifests, functionName, {
      value: path,
      enumerable: true,
    });
  }
  await writeFile(join(project, "declarations.json"), JSON.stringify(combined));
  await writeFile(
    join(project, "dependencies.json"),
    await workflowBundleDependencies({
      product,
      packages: Object.keys(packageMetadata.dependencies),
    }),
  );
  const bundleDigest = await retainWorkflowBundle({
    project,
    repository: folders.repository,
    directory: join(dirname(project), "workflow-bundles"),
  });
  return {
    repository: folders.repository,
    bundleDigest,
    manifests,
    declarations: combined,
    workflowRefusals: folders.refusals,
  };
}
