import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type WorkflowCaptureCode =
  | "unsafe-workflow-path"
  | "workflow-read-failed"
  | "workflow-source-changed"
  | "unsupported-source"
  | "invalid-declaration";

export interface WorkflowFolder {
  readonly path: string;
  readonly components: readonly {
    readonly path: string;
    readonly stats: BigIntStats;
  }[];
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)
  );
}

function safeComponent(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[/\\:]/.test(name) &&
    !name.startsWith("~")
  );
}

export async function inspectWorkflowFolder(
  root: string,
  parts: readonly string[],
): Promise<WorkflowFolder> {
  const canonical = await realpath(root);
  if (parts.some((part) => !safeComponent(part)))
    throw new Error("unsafe-workflow-path");
  const components: WorkflowFolder["components"][number][] = [];
  let path = canonical;
  for (const part of ["", ...parts]) {
    path = join(path, part);
    const stats = await lstat(path, { bigint: true }).catch(
      async (error: unknown) => {
        await verifyFolder({ path, components });
        throw error;
      },
    );
    if (stats.isSymbolicLink()) throw new Error("unsafe-workflow-path");
    if (!stats.isDirectory()) throw new Error("workflow-read-failed");
    components.push({ path, stats });
  }
  const resolved = await realpath(path).catch(changedPathError);
  const folder = { path, components };
  await verifyFolder(folder);
  if (!contained(canonical, resolved)) throw new Error("unsafe-workflow-path");
  return folder;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function verifyFolder(folder: WorkflowFolder): Promise<void> {
  for (const component of folder.components) {
    if (!sameSnapshot(component.stats, await capturedStats(component.path)))
      throw new Error("workflow-source-changed");
  }
}

function capturedStats(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true }).catch(changedPathError);
}

function changedPathError(error: unknown): never {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "ELOOP")
  )
    throw new Error("workflow-source-changed");
  throw error;
}

async function openSource(
  folder: WorkflowFolder,
  name: string,
): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK;
  if (process.platform === "darwin")
    return open(join(folder.path, name), flags | 0x20000000);
  if (process.platform !== "linux") throw new Error("workflow-read-failed");
  const handles: FileHandle[] = [];
  try {
    let path = folder.components[0]?.path;
    if (!path) throw new Error("workflow-read-failed");
    for (const component of folder.components) {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
      if (!sameIdentity(component.stats, await handle.stat({ bigint: true })))
        throw new Error("workflow-source-changed");
      const next = folder.components[handles.length];
      path = `/proc/self/fd/${String(handle.fd)}/${next ? relative(component.path, next.path) : name}`;
    }
    return await open(path, flags | constants.O_NOFOLLOW);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

async function inspectFile(folder: WorkflowFolder, name: string) {
  const path = join(folder.path, name);
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile()) throw new Error("unsafe-workflow-path");
  const resolved = await realpath(path).catch(changedPathError);
  if (!sameSnapshot(stats, await capturedStats(path)))
    throw new Error("workflow-source-changed");
  if (!contained(folder.path, resolved))
    throw new Error("unsafe-workflow-path");
  return { path, name, stats };
}

async function captureFile(
  folder: WorkflowFolder,
  file: Awaited<ReturnType<typeof inspectFile>>,
) {
  const { stats } = file;
  const handle = await openSource(folder, file.name).catch(changedPathError);
  try {
    if (!sameSnapshot(stats, await handle.stat({ bigint: true })))
      throw new Error("workflow-source-changed");
    const bytes = await handle.readFile();
    if (
      !sameSnapshot(stats, await handle.stat({ bigint: true })) ||
      BigInt(bytes.length) !== stats.size
    )
      throw new Error("workflow-source-changed");
    return { ...file, bytes };
  } finally {
    await handle.close();
  }
}

async function captureFiles(folder: WorkflowFolder, names: readonly string[]) {
  const inspected: Awaited<ReturnType<typeof inspectFile>>[] = [];
  const captured: Awaited<ReturnType<typeof captureFile>>[] = [];
  const codes: WorkflowCaptureCode[] = [];
  for (const name of names) {
    try {
      inspected.push(await inspectFile(folder, name));
    } catch (error) {
      codes.push(workflowCaptureFailure(error));
    }
  }
  for (const file of inspected) {
    try {
      captured.push(await captureFile(folder, file));
    } catch (error) {
      codes.push(workflowCaptureFailure(error));
    }
  }
  for (const file of captured) {
    if (!sameSnapshot(file.stats, await capturedStats(file.path)))
      throw new Error("workflow-source-changed");
  }
  return { captured, codes };
}

function decodedFile(
  input: {
    readonly bytes: Buffer | undefined;
    readonly code: WorkflowCaptureCode;
  },
  codes: WorkflowCaptureCode[],
): string | undefined {
  if (input.bytes === undefined) return undefined;
  const text = input.bytes.toString("utf8");
  if (input.bytes.equals(Buffer.from(text))) return text;
  codes.push(input.code);
  return undefined;
}

export async function captureWorkflowCandidate(
  folder: WorkflowFolder,
  name: string,
) {
  if (!safeComponent(name) || !name.endsWith(".ts") || name.endsWith(".d.ts"))
    throw new Error("unsafe-workflow-path");
  await verifyFolder(folder);
  const declarationName = name.slice(0, -3) + ".declaration.json";
  const { captured, codes } = await captureFiles(folder, [
    name,
    declarationName,
  ]);
  await verifyFolder(folder);
  const source = decodedFile(
    {
      bytes: captured.find((file) => file.name === name)?.bytes,
      code: "unsupported-source",
    },
    codes,
  );
  const declaration = decodedFile(
    {
      bytes: captured.find((file) => file.name === declarationName)?.bytes,
      code: "invalid-declaration",
    },
    codes,
  );
  return {
    source,
    declaration,
    codes: [
      ...new Set(
        codes.includes("unsafe-workflow-path")
          ? codes.filter((code) => code !== "workflow-read-failed")
          : codes,
      ),
    ].sort(),
  };
}

export function workflowCaptureFailure(error: unknown): WorkflowCaptureCode {
  const code: unknown =
    error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ELOOP") return "unsafe-workflow-path";
  const message = error instanceof Error ? error.message : "";
  if (
    message === "unsafe-workflow-path" ||
    message === "workflow-source-changed" ||
    message === "unsupported-source" ||
    message === "invalid-declaration"
  )
    return message;
  return "workflow-read-failed";
}

async function descriptorEntries(folder: WorkflowFolder): Promise<string[]> {
  const handle = await openSource(folder, ".").catch(changedPathError);
  try {
    const expected = folder.components.at(-1)?.stats;
    if (
      !expected ||
      !sameIdentity(expected, await handle.stat({ bigint: true }))
    )
      throw new Error("workflow-source-changed");
    return await readdir(`/proc/self/fd/${String(handle.fd)}`);
  } finally {
    await handle.close();
  }
}

export async function workflowFolderEntries(
  folder: WorkflowFolder,
): Promise<string[]> {
  const entries =
    process.platform === "darwin"
      ? await readdir(`/.nofollow${folder.path}`).catch(changedPathError)
      : await descriptorEntries(folder);
  await verifyFolder(folder);
  return entries;
}
