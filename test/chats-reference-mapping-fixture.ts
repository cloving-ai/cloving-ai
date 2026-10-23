import { compareEvidence, type EvidenceSource } from "../src/chats/revision.ts";
import type { EvidenceMappingSnapshot } from "../src/chats/reference-mapping.ts";

export const previousImportId = "11111111-1111-4111-8111-111111111111";
export const currentImportId = "22222222-2222-4222-8222-222222222222";
export const firstDigest = `sha256:${"a".repeat(64)}`;
export const secondDigest = `sha256:${"b".repeat(64)}`;
export const thirdDigest = `sha256:${"c".repeat(64)}`;

export interface MappingSelection extends EvidenceSource {
  readonly offsets: readonly number[];
}

export function selection(
  path: string,
  options: Partial<MappingSelection> = {},
): MappingSelection {
  return {
    path,
    root: null,
    status: "included",
    digest: firstDigest,
    byteSize: 100,
    offsets: [0],
    ...options,
  };
}

function mappingEntries(
  selections: readonly MappingSelection[],
  roots: readonly string[] | undefined,
) {
  return selections.map((item, index) => ({
    path: item.path,
    status: item.status,
    reason: item.status === "included" ? "supported" : "source-unreadable",
    digest: item.digest,
    ...(item.byteSize === undefined ? {} : { byteSize: item.byteSize }),
    recordCount: item.offsets.length,
    omissions: { metadataRecords: 0, thinkingBlocks: 0 },
    ...(roots === undefined
      ? {}
      : {
          kind: "file",
          selection:
            item.root === null
              ? { kind: "file", index }
              : { kind: "root", index: roots.indexOf(item.root) },
        }),
  }));
}

export function mappingSnapshot(
  importId: string,
  data: {
    readonly selections: readonly MappingSelection[];
    readonly roots?: readonly string[];
  },
): EvidenceMappingSnapshot {
  const { selections, roots } = data;
  const entries = mappingEntries(selections, roots);
  return {
    importId,
    coverage: JSON.stringify(
      roots === undefined
        ? {
            schemaVersion: 1,
            importId,
            files: entries,
          }
        : {
            schemaVersion: 2,
            importId,
            roots,
            exclusions: [],
            limits: {
              depth: 4,
              files: 100,
              sourceBytes: 10_485_760,
              corpusBytes: 52_428_800,
            },
            entries,
          },
    ),
    corpus: selections
      .flatMap((item) =>
        item.offsets.map(
          (offset) =>
            JSON.stringify({
              schemaVersion: 2,
              sourceId: `${item.digest ?? firstDigest}:${String(offset)}`,
              role: "user",
              timestamp: null,
              sessionId: null,
              text: "synthetic repeated text",
              blocks: [],
              uuid: "repeated-identity",
              isSidechain: null,
            }) + "\n",
        ),
      )
      .join(""),
  };
}

export function mappingInput(
  previous: readonly MappingSelection[],
  current: readonly MappingSelection[],
) {
  return {
    previous: mappingSnapshot(previousImportId, { selections: previous }),
    current: mappingSnapshot(currentImportId, { selections: current }),
    revision: compareEvidence({ previous, current }).entries,
  };
}

export function mapped(
  previousIndex: number,
  options: {
    currentIndex: number;
    before?: string;
    after?: string;
    offset?: number;
  },
) {
  const offset = String(options.offset ?? 0);
  return {
    previous: {
      recordIndex: previousIndex,
      sourceId: `${options.before ?? firstDigest}:${offset}`,
    },
    current: {
      recordIndex: options.currentIndex,
      sourceId: `${options.after ?? options.before ?? firstDigest}:${offset}`,
    },
  };
}
