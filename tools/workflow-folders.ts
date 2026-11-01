import { absoluteWorkflowFolder } from "../src/project-settings.ts";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import ts from "typescript";
import type { WorkflowDeclaration } from "../src/workflow-declaration.ts";
import {
  isCandidateDeclaration,
  type CandidateDeclaration,
  type WorkflowCandidateCode,
} from "../src/workflow-candidate.ts";
import { record } from "../src/protocol.ts";
import {
  workflowConflicts,
  type WorkflowConflictCode,
} from "../src/workflow-discovery.ts";
import { admitWorkflowCandidate } from "./admit-workflow.ts";
import type { CandidatePackageOptions } from "./workflow-candidate-program.ts";
import {
  captureWorkflowCandidate,
  inspectWorkflowFolder,
  workflowCaptureFailure,
  workflowFolderEntries,
  type WorkflowCaptureCode,
  type WorkflowFolder,
} from "./workflow-folder-capture.ts";

export interface WorkflowFolderInput {
  readonly repository: string;
  readonly home: string;
  readonly xdgConfigHome?: string | undefined;
  readonly userFolder?: string | undefined;
}

interface WorkflowLabel {
  readonly scope: "project" | "user";
  readonly label: string;
}

interface WorkflowSnapshot extends WorkflowLabel {
  readonly baseName: string;
  readonly source: string;
  readonly declaration: string;
  readonly helpers: Readonly<Record<string, string>>;
}

type DiscoveredWorkflow =
  | { readonly kind: "captured"; readonly snapshot: WorkflowSnapshot }
  | {
      readonly kind: "refused";
      readonly scope: WorkflowLabel["scope"];
      readonly label: string;
      readonly baseName: string;
      readonly codes: readonly WorkflowCaptureCode[];
      readonly source: string | undefined;
      readonly declaration: string | undefined;
    };

export interface WorkflowFolderCandidate extends WorkflowSnapshot {
  readonly repository: string;
  readonly artifactDigest: string;
}

export interface WorkflowFolderRefusal extends WorkflowLabel {
  readonly codes: readonly (
    | WorkflowCandidateCode
    | WorkflowCaptureCode
    | WorkflowConflictCode
    | "compile-failed"
  )[];
}

export interface WorkflowListing {
  readonly scope: "project" | "user";
  readonly workflowId: string | null;
  readonly file: string;
  readonly admitted: boolean;
  readonly codes: readonly string[];
  readonly declaration?: CandidateDeclaration | WorkflowDeclaration;
}

export interface WorkflowFolderResult {
  readonly workflows: readonly WorkflowListing[];
  readonly repository: string;
  readonly candidates: readonly WorkflowFolderCandidate[];
  readonly refusals: readonly WorkflowFolderRefusal[];
}

function fileLabel(name: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ts$/.test(name)
    ? name
    : "file-" + createHash("sha256").update(name).digest("hex").slice(0, 16);
}

function parsedDeclaration(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function identity(entry: DiscoveredWorkflow) {
  const snapshot = entry.kind === "captured" ? entry.snapshot : entry;
  const source = ts.createSourceFile(
    "candidate.ts",
    snapshot.source ?? "",
    ts.ScriptTarget.Latest,
    true,
  );
  const parsed = parsedDeclaration(snapshot.declaration ?? "");
  const declaration = record(record(parsed)?.["workflow"]);
  const workflowId = declaration?.["workflowId"];
  return {
    queue: isCandidateDeclaration(parsed) && parsed.workflow.queue === true,
    baseName: snapshot.baseName,
    workflowId: typeof workflowId === "string" ? workflowId : undefined,
    functionNames: source.statements
      .filter(ts.isFunctionDeclaration)
      .filter(
        (node) =>
          (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0,
      )
      .flatMap((node) => (node.name ? [node.name.text] : [])),
  };
}

function compareLabels(left: WorkflowLabel, right: WorkflowLabel): number {
  const a = `${left.scope}\0${left.label}`;
  const b = `${right.scope}\0${right.label}`;
  return a < b ? -1 : Number(a > b);
}

async function scanFolder(
  location: {
    readonly scope: WorkflowLabel["scope"];
    readonly root: string;
    readonly parts: readonly string[];
  },
  refusals: WorkflowFolderRefusal[],
): Promise<DiscoveredWorkflow[]> {
  let folder;
  let entries: string[];
  try {
    folder = await inspectWorkflowFolder(location.root, location.parts);
    entries = await workflowFolderEntries(folder);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      refusals.push({
        scope: location.scope,
        label: "workflows/",
        codes: [workflowCaptureFailure(error)],
      });
    return [];
  }
  const snapshots: DiscoveredWorkflow[] = [];
  for (const name of entries
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".d.ts") &&
        !name.endsWith(".test.ts"),
    )
    .sort()) {
    snapshots.push(
      await captureEntry(folder, {
        scope: location.scope,
        label: fileLabel(name),
        name,
      }),
    );
  }
  return snapshots;
}

async function captureEntry(
  folder: WorkflowFolder,
  file: WorkflowLabel & { readonly name: string },
): Promise<DiscoveredWorkflow> {
  const label = {
    scope: file.scope,
    label: file.label,
    baseName: file.name.slice(0, -3),
  };
  try {
    const capture = await captureWorkflowCandidate(folder, file.name);
    if (
      capture.source === undefined ||
      capture.declaration === undefined ||
      capture.codes.length > 0
    )
      return { kind: "refused", ...label, ...capture };
    return {
      kind: "captured",
      snapshot: {
        ...label,
        source: capture.source,
        declaration: capture.declaration,
        helpers: capture.helpers,
      },
    };
  } catch (error) {
    return {
      kind: "refused",
      ...label,
      codes: [workflowCaptureFailure(error)],
      source: undefined,
      declaration: undefined,
    };
  }
}

export function userLocation(
  input: Pick<WorkflowFolderInput, "home" | "xdgConfigHome" | "userFolder">,
): {
  readonly root: string;
  readonly parts: readonly string[];
} {
  const folder = absoluteWorkflowFolder(input.userFolder);
  if (folder !== undefined)
    return { root: dirname(folder), parts: [basename(folder)] };
  const configuration =
    input.xdgConfigHome && isAbsolute(input.xdgConfigHome)
      ? input.xdgConfigHome
      : join(input.home, ".config");
  return { root: configuration, parts: ["cloving", "workflows"] };
}

async function scanFolders(
  input: WorkflowFolderInput,
  refusals: WorkflowFolderRefusal[],
) {
  const repository = await realpath(input.repository);
  const snapshots = [
    ...(await scanFolder(
      { scope: "project", root: repository, parts: [".cloving", "workflows"] },
      refusals,
    )),
    ...(await scanFolder({ scope: "user", ...userLocation(input) }, refusals)),
  ];
  return { repository, snapshots };
}

function workflowFolder(
  input: WorkflowFolderInput,
  scope: "project" | "user",
): string {
  if (scope === "project")
    return join(input.repository, ".cloving", "workflows");
  const { root, parts } = userLocation(input);
  return join(root, ...parts);
}

function folderListings(
  input: WorkflowFolderInput,
  found: {
    readonly repository: string;
    readonly snapshots: readonly DiscoveredWorkflow[];
    readonly refusals: readonly WorkflowFolderRefusal[];
  },
): WorkflowListing[] {
  const { repository, snapshots, refusals } = found;
  const workflows = snapshots.map((entry): WorkflowListing => {
    const snapshot = entry.kind === "captured" ? entry.snapshot : entry;
    const declaration = parsedDeclaration(snapshot.declaration ?? "");
    const refusal = refusals.find(
      (item) => item.scope === snapshot.scope && item.label === snapshot.label,
    );
    const folder = workflowFolder({ ...input, repository }, snapshot.scope);
    return {
      scope: snapshot.scope,
      workflowId: isCandidateDeclaration(declaration)
        ? declaration.workflow.workflowId
        : null,
      file: join(folder, snapshot.baseName + ".ts"),
      admitted: refusal === undefined,
      codes: refusal?.codes ?? [],
      ...(isCandidateDeclaration(declaration) ? { declaration } : {}),
    };
  });
  return [
    ...workflows,
    ...refusals
      .filter((refusal) => refusal.label === "workflows/")
      .map((refusal) => ({
        scope: refusal.scope,
        workflowId: null,
        file: workflowFolder({ ...input, repository }, refusal.scope),
        admitted: false,
        codes: refusal.codes,
      })),
  ];
}

export async function loadWorkflowFolders(
  input: WorkflowFolderInput,
  installed: CandidatePackageOptions = {},
): Promise<WorkflowFolderResult> {
  const candidates: WorkflowFolderCandidate[] = [];
  const refusals: WorkflowFolderRefusal[] = [];
  const { repository, snapshots } = await scanFolders(input, refusals);
  const conflicts = workflowConflicts(snapshots.map(identity));
  for (const [index, entry] of snapshots.entries()) {
    const label = entry.kind === "captured" ? entry.snapshot : entry;
    const codes = [
      ...new Set([
        ...(entry.kind === "refused" ? entry.codes : []),
        ...(conflicts[index] ?? []),
      ]),
    ].sort();
    if (entry.kind === "refused" || codes.length > 0) {
      refusals.push({ scope: label.scope, label: label.label, codes });
      continue;
    }
    const { snapshot } = entry;
    const result = await admitWorkflowCandidate(
      {
        source: snapshot.source,
        declaration: parsedDeclaration(snapshot.declaration),
        helpers: snapshot.helpers,
      },
      installed,
    );
    if (result.kind === "refused")
      refusals.push({
        scope: snapshot.scope,
        label: snapshot.label,
        codes: result.codes,
      });
    else
      candidates.push({
        ...snapshot,
        repository,
        artifactDigest: result.artifactDigest,
      });
  }
  return {
    workflows: folderListings(input, { repository, snapshots, refusals }),
    repository,
    candidates: candidates.sort(compareLabels),
    refusals: refusals.sort(compareLabels),
  };
}
