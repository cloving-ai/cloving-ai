import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  inspectScanSource,
  noFollowPath,
  refuseRepositoryRoot,
  sourceFailure,
  verifyScanSource,
  verifyScanAncestor,
  type ScanSource,
} from "./source.ts";

export interface SelectionRequest {
  readonly paths: readonly string[];
  readonly roots?: readonly string[];
  readonly excludeProjects?: readonly string[];
  readonly workingDirectory: string;
}

export interface SelectionOutcome {
  readonly status: "unreadable" | "unsupported" | "excluded" | "pending";
  readonly reason: string;
}

export interface SourceSelection {
  readonly kind: "file" | "subtree";
  readonly path: string;
  readonly selection: {
    readonly kind: "file" | "root";
    readonly index: number;
  };
  readonly outcome?: SelectionOutcome;
  readonly inspection?: ScanSource;
}

function outcome(reason: string): SelectionOutcome {
  return {
    status: reason === "source-unreadable" ? "unreadable" : "unsupported",
    reason,
  };
}

async function scanEntry(
  entry: SourceSelection,
  context: { readonly exclusions: readonly string[]; readonly depth: number },
): Promise<SourceSelection[]> {
  try {
    const { exclusions, depth } = context;
    const root = entry.inspection?.root ?? entry.path;
    const inspection = await inspectScanSource(entry.path, root);
    if (entry.inspection !== undefined)
      verifyScanAncestor(entry.inspection, inspection);
    const inspected = { ...entry, kind: inspection.kind, inspection };
    const disposition = entryDisposition(inspected, context);
    if (disposition !== undefined)
      return [{ ...inspected, outcome: disposition }];
    if (inspection.kind === "file") return [inspected];
    const entries: SourceSelection[] = [];
    const children = await readdir(noFollowPath(entry.path), {
      withFileTypes: true,
    });
    await verifyScanSource(inspection);
    for (const child of children) {
      const scanned = await scanEntry(
        {
          ...inspected,
          kind: child.isDirectory() ? "subtree" : "file",
          path: join(entry.path, child.name),
        },
        { exclusions, depth: depth + 1 },
      );
      for (const selected of scanned) entries.push(selected);
    }
    return entries;
  } catch (error) {
    return [{ ...entry, outcome: outcome(sourceFailure(error)) }];
  }
}

function entryDisposition(
  entry: SourceSelection,
  context: { readonly exclusions: readonly string[]; readonly depth: number },
): SelectionOutcome | undefined {
  if (entry.kind === "file")
    return entry.path.endsWith(".jsonl")
      ? undefined
      : outcome("unsupported-extension");
  if (context.depth === 1 && context.exclusions.includes(basename(entry.path)))
    return { status: "excluded", reason: "project-excluded" };
  if (context.depth === 4) return { status: "pending", reason: "depth-limit" };
  return;
}

async function prepareRoot(path: string): Promise<SourceSelection> {
  const entry: SourceSelection = {
    path,
    kind: "subtree",
    selection: { kind: "root", index: 0 },
  };
  try {
    const inspection = await inspectScanSource(path, path);
    if (inspection.kind !== "subtree") throw new Error("non-directory-root");
    await refuseRepositoryRoot(inspection.root);
    return { ...entry, path: inspection.root, inspection };
  } catch (error) {
    return { ...entry, outcome: outcome(sourceFailure(error)) };
  }
}

export async function selectChatSources(request: SelectionRequest): Promise<{
  roots: string[];
  entries: SourceSelection[];
}> {
  const entries: SourceSelection[] = request.paths.map((path, index) => ({
    path: resolve(request.workingDirectory, path),
    kind: "file",
    selection: { kind: "file", index },
  }));
  const selectedRoots: SourceSelection[] = [];
  for (const value of request.roots ?? [])
    selectedRoots.push(
      await prepareRoot(resolve(request.workingDirectory, value)),
    );
  selectedRoots.sort((left, right) => stringOrder(left.path, right.path));
  const roots = selectedRoots.map((root) => root.path);
  for (const [index, root] of selectedRoots.entries()) {
    const selected = { ...root, selection: { kind: "root" as const, index } };
    const scanned =
      root.outcome === undefined
        ? await scanEntry(selected, {
            exclusions: request.excludeProjects ?? [],
            depth: 0,
          })
        : [selected];
    scanned.sort((left, right) =>
      stringOrder(
        relative(root.path, left.path),
        relative(root.path, right.path),
      ),
    );
    for (const entry of scanned) entries.push(entry);
  }
  let attempts = 0;
  return {
    roots,
    entries: entries.map((entry) => {
      if (entry.selection.kind === "file" || entry.outcome !== undefined)
        return entry;
      attempts++;
      return attempts <= 100
        ? entry
        : { ...entry, outcome: { status: "pending", reason: "file-limit" } };
    }),
  };
}

function stringOrder(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}
