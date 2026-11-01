import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

interface BundleFile {
  readonly name: string;
  readonly bytes: Buffer;
}

interface BundleInput {
  readonly directory: string;
  readonly repository: string;
  readonly project: string;
}

interface BundleLookup {
  readonly directory: string;
  readonly repository: string;
  readonly id: string;
}

type BundleResult =
  | { readonly kind: "available"; readonly directory: string }
  | {
      readonly kind: "unavailable";
      readonly code: "pinned-workflow-unavailable";
    };

const unavailable: BundleResult = {
  kind: "unavailable",
  code: "pinned-workflow-unavailable",
};

export async function readRetainedWorkflowBundle(
  input: BundleLookup,
): Promise<BundleResult> {
  if (!/^[a-f0-9]{64}$/.test(input.id)) return unavailable;
  try {
    const directory = join(input.directory, input.id);
    if (!(await lstat(directory)).isDirectory()) return unavailable;
    const repository = await realpath(input.repository);
    const contents = bundleContents(repository, await projectFiles(directory));
    const stored = await regularFile(join(directory, "bundle.json"));
    if (digest(contents) !== input.id || stored.toString("utf8") !== contents)
      return unavailable;
    return { kind: "available", directory };
  } catch {
    return unavailable;
  }
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFile(path: string): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) throw new Error("invalid-bundle-file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function treeFiles(root: string, name: string): Promise<BundleFile[]> {
  const path = join(root, name);
  const entry = await lstat(path);
  if (entry.isFile()) return [{ name, bytes: await regularFile(path) }];
  if (!entry.isDirectory()) throw new Error("invalid-bundle-file");
  const files: BundleFile[] = [];
  for (const child of (await readdir(path)).sort())
    files.push(...(await treeFiles(root, `${name}/${child}`)));
  return files;
}

async function projectFiles(project: string): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  const names = (await readdir(project)).filter(
    (name) => name.endsWith(".json") && name !== "bundle.json",
  );
  for (const name of [...names, "artifacts", "workflows"].sort())
    files.push(...(await treeFiles(project, name)));
  const required = [
    "package.json",
    "declarations.json",
    "dependencies.json",
    ...[
      "client.mjs",
      "flow.mjs",
      "steps.mjs",
      "manifest.json",
      "flow.mjs.__wf_tmp.js.debug.json",
      "steps.mjs.debug.json",
    ].map((name) => `artifacts/${name}`),
  ];
  if (required.some((name) => !files.some((file) => file.name === name)))
    throw new Error("incomplete-workflow-bundle");
  return files;
}

function bundleContents(
  repository: string,
  files: readonly BundleFile[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository,
    files: Object.fromEntries(
      files.map(({ name, bytes }) => [name, digest(bytes)]),
    ),
  });
}

async function validatedId(input: BundleLookup): Promise<string> {
  if ((await readRetainedWorkflowBundle(input)).kind !== "available")
    throw new Error("pinned-workflow-unavailable");
  return input.id;
}

async function existingEntry(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
}

async function retainedBefore(
  input: BundleLookup,
  contents: string,
): Promise<boolean> {
  try {
    const history = join(input.directory, ".history");
    await mkdir(history, { recursive: true, mode: 0o700 });
    if (!(await lstat(history)).isDirectory())
      throw new Error("pinned-workflow-unavailable");
    const directory = join(history, input.id);
    const entry = await existingEntry(directory);
    if (entry === undefined) return false;
    if (!entry.isDirectory()) throw new Error("pinned-workflow-unavailable");
    const receipt = await regularFile(join(directory, "bundle.json"));
    if (receipt.toString("utf8") !== contents)
      throw new Error("pinned-workflow-unavailable");
    return true;
  } catch {
    throw new Error("pinned-workflow-unavailable");
  }
}

async function rememberBundle(
  input: BundleLookup,
  contents: string,
): Promise<void> {
  const history = join(input.directory, ".history");
  const temporary = await mkdtemp(join(history, ".pending-"));
  try {
    await writeFile(join(temporary, "bundle.json"), contents, {
      flag: "wx",
      mode: 0o600,
    });
    await publishDirectory(temporary, join(history, input.id));
    await retainedBefore(input, contents);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function publishDirectory(from: string, to: string): Promise<void> {
  await rename(from, to).catch((error: unknown) => {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOTEMPTY", "EEXIST"].includes(String(error.code))
    )
      return;
    throw error;
  });
}

export async function retainWorkflowBundle(
  input: BundleInput,
): Promise<string> {
  const repository = await realpath(input.repository);
  const files = await projectFiles(input.project);
  const contents = bundleContents(repository, files);
  const id = digest(contents);
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const destination = join(input.directory, id);
  const lookup = { ...input, id };
  if (await retainedBefore(lookup, contents)) return validatedId(lookup);
  if (await existingEntry(destination)) {
    await validatedId(lookup);
    await rememberBundle(lookup, contents);
    return id;
  }
  const temporary = await mkdtemp(join(input.directory, ".pending-"));
  try {
    await mkdir(join(temporary, "workflows"), { mode: 0o700 });
    for (const { name, bytes } of files) {
      const path = join(temporary, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(join(temporary, "bundle.json"), contents, {
      flag: "wx",
      mode: 0o600,
    });
    await publishDirectory(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await validatedId(lookup);
  await rememberBundle(lookup, contents);
  return id;
}
