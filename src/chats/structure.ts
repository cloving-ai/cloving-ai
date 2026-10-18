import type { MessageRecord } from "./normalize.ts";

export interface OccurrenceReference {
  readonly recordIndex: number;
  readonly sourceId: string;
}

export interface Occurrence extends OccurrenceReference {
  readonly uuid: string | null;
  readonly sessionId: string | null;
  readonly isSidechain: boolean | null;
  readonly parentUuid?: string | null;
  readonly copyOf?: OccurrenceReference;
}

interface ConflictGroup {
  readonly uuid: string;
  readonly variants: readonly (readonly OccurrenceReference[])[];
}

interface ParentLink {
  readonly childUuid: string | null;
  readonly parentUuid: string | null;
  readonly occurrences: readonly OccurrenceReference[];
  readonly status: "root" | "resolved" | "missing" | "ambiguous";
}

interface SessionNode {
  readonly uuid: string | null;
  readonly occurrences: readonly OccurrenceReference[];
}

interface SessionStructure {
  readonly sessionId: string;
  readonly nodes: readonly SessionNode[];
  readonly links: readonly ParentLink[];
  readonly forkPoints: readonly {
    parentUuid: string;
    childUuids: readonly string[];
  }[];
  readonly unknownParents: readonly OccurrenceReference[];
  readonly missingParentTargets: readonly string[];
  readonly cycles: readonly (readonly string[])[];
}

export interface StructureCounts {
  readonly records: number;
  readonly knownSessions: number;
  readonly forks: number;
  readonly copies: number;
  readonly conflictGroups: number;
  readonly unknownIdentities: number;
  readonly missingParentTargets: number;
}

export interface ImportStructure {
  readonly historyCompleteness: "unknown";
  readonly counts: StructureCounts;
  readonly occurrences: readonly Occurrence[];
  readonly conflictGroups: readonly ConflictGroup[];
  readonly sessions: readonly SessionStructure[];
  readonly unknownSessions: readonly OccurrenceReference[];
}

function reference(occurrence: OccurrenceReference): OccurrenceReference {
  return { recordIndex: occurrence.recordIndex, sourceId: occurrence.sourceId };
}

function rawJsonApi(
  value: object,
): value is { isRawJSON: (input: unknown) => boolean } {
  return "isRawJSON" in value && typeof value.isRawJSON === "function";
}

function canonical(value: unknown): string {
  if (rawJsonApi(JSON) && JSON.isRawJSON(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
    .join(",")}}`;
}

type Variants = Map<string, Map<string, OccurrenceReference[]>>;

function occurrence(
  record: MessageRecord,
  context: { readonly recordIndex: number; readonly identities: Variants },
): Occurrence {
  const { recordIndex, identities } = context;
  const metadata =
    record.schemaVersion === 2
      ? {
          uuid: record.uuid,
          isSidechain: record.isSidechain,
          ...(Object.hasOwn(record, "parentUuid")
            ? { parentUuid: record.parentUuid }
            : {}),
        }
      : { uuid: null, isSidechain: null };
  const current = {
    ...reference({ recordIndex, sourceId: record.sourceId }),
    sessionId: record.sessionId,
    ...metadata,
  };
  if (current.uuid === null) return current;
  const variants =
    identities.get(current.uuid) ?? new Map<string, OccurrenceReference[]>();
  identities.set(current.uuid, variants);
  const content = canonical([record.role, record.text, record.blocks]);
  const matches = variants.get(content) ?? [];
  variants.set(content, matches);
  const first = matches[0];
  matches.push(reference(current));
  return first === undefined ? current : { ...current, copyOf: { ...first } };
}

function groupNodes(occurrences: readonly Occurrence[]): Occurrence[][] {
  const groups = new Map<string | number, Occurrence[]>();
  for (const item of occurrences) {
    const key = item.uuid ?? item.recordIndex;
    const group = groups.get(key) ?? [];
    groups.set(key, group);
    group.push(item);
  }
  return [...groups.values()];
}

function parentLinks(
  group: readonly Occurrence[],
  known: ReadonlySet<string>,
): ParentLink[] {
  const parents = new Map<string | null, OccurrenceReference[]>();
  for (const item of group) {
    if (item.parentUuid === undefined) continue;
    const references = parents.get(item.parentUuid) ?? [];
    parents.set(item.parentUuid, references);
    references.push(reference(item));
  }
  const childUuid = group[0]?.uuid ?? null;
  return [...parents].map(([parentUuid, occurrences]) => {
    let status: ParentLink["status"] = "resolved";
    if (parentUuid === null) status = "root";
    if (parentUuid !== null && !known.has(parentUuid)) status = "missing";
    if (childUuid === null || parents.size > 1) status = "ambiguous";
    return { childUuid, parentUuid, occurrences, status };
  });
}

function forkPoints(links: readonly ParentLink[]) {
  const children = new Map<string, Set<string>>();
  for (const link of links) {
    if (
      link.status === "ambiguous" ||
      link.parentUuid === null ||
      link.childUuid === null
    )
      continue;
    const ids = children.get(link.parentUuid) ?? new Set<string>();
    children.set(link.parentUuid, ids);
    ids.add(link.childUuid);
  }
  return [...children]
    .filter(([, ids]) => ids.size > 1)
    .map(([parentUuid, ids]) => ({ parentUuid, childUuids: [...ids] }));
}

type Graph = ReadonlyMap<string, readonly string[]>;

function finishFrom(
  graph: Graph,
  state: { start: string; visited: Set<string>; order: string[] },
): void {
  const { visited, order } = state;
  const stack = [{ id: state.start, expanded: false }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (item.expanded) {
      order.push(item.id);
      continue;
    }
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    stack.push({ id: item.id, expanded: true });
    for (const id of graph.get(item.id) ?? [])
      stack.push({ id, expanded: false });
  }
}

function finishOrder(graph: Graph): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of graph.keys())
    finishFrom(graph, { start, visited, order });
  return order;
}

function observedGraph(
  known: ReadonlySet<string>,
  links: readonly ParentLink[],
) {
  const graph = new Map<string, string[]>([...known].map((id) => [id, []]));
  const reverse = new Map<string, string[]>([...known].map((id) => [id, []]));
  for (const link of links) {
    if (
      link.childUuid === null ||
      link.parentUuid === null ||
      !known.has(link.parentUuid)
    )
      continue;
    graph.get(link.childUuid)?.push(link.parentUuid);
    reverse.get(link.parentUuid)?.push(link.childUuid);
  }
  return { graph, reverse };
}

function componentFrom(
  graph: Graph,
  state: { start: string; visited: Set<string> },
): string[] {
  const component: string[] = [];
  const stack = [state.start];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || state.visited.has(id)) continue;
    state.visited.add(id);
    component.push(id);
    for (const parent of graph.get(id) ?? []) stack.push(parent);
  }
  return component;
}

function cycleGroups(
  known: ReadonlySet<string>,
  links: readonly ParentLink[],
): string[][] {
  const { graph, reverse } = observedGraph(known, links);
  const rank = new Map([...known].map((id, index) => [id, index]));
  const visited = new Set<string>();
  const cycles: string[][] = [];
  for (const start of finishOrder(graph).reverse()) {
    if (visited.has(start)) continue;
    const component = componentFrom(reverse, { start, visited });
    if (component.length > 1 || graph.get(start)?.includes(start))
      cycles.push(
        component.sort(
          (left, right) => Number(rank.get(left)) - Number(rank.get(right)),
        ),
      );
  }
  return cycles.sort(
    (left, right) =>
      Number(rank.get(String(left[0]))) - Number(rank.get(String(right[0]))),
  );
}

function sessionStructure(
  sessionId: string,
  occurrences: readonly Occurrence[],
): SessionStructure {
  const groups = groupNodes(occurrences);
  const known = new Set(
    occurrences.flatMap((item) => (item.uuid === null ? [] : [item.uuid])),
  );
  const links = groups.flatMap((group) => parentLinks(group, known));
  return {
    sessionId,
    nodes: groups.map((group) => ({
      uuid: group[0]?.uuid ?? null,
      occurrences: group.map(reference),
    })),
    links,
    forkPoints: forkPoints(links),
    unknownParents: occurrences
      .filter((item) => !Object.hasOwn(item, "parentUuid"))
      .map(reference),
    missingParentTargets: [
      ...new Set(
        links.flatMap((link) =>
          link.parentUuid !== null && !known.has(link.parentUuid)
            ? [link.parentUuid]
            : [],
        ),
      ),
    ],
    cycles: cycleGroups(known, links),
  };
}

export function structureImport(
  records: readonly MessageRecord[],
): ImportStructure {
  const identities: Variants = new Map();
  const occurrences = records.map((record, index) =>
    occurrence(record, { recordIndex: index, identities }),
  );
  const grouped = new Map<string, Occurrence[]>();
  for (const item of occurrences) {
    if (item.sessionId === null || item.sessionId === "") continue;
    const group = grouped.get(item.sessionId) ?? [];
    grouped.set(item.sessionId, group);
    group.push(item);
  }
  const sessions = [...grouped].map(([id, group]) =>
    sessionStructure(id, group),
  );
  const conflictGroups = [...identities]
    .filter(([, variants]) => variants.size > 1)
    .map(([uuid, variants]) => ({ uuid, variants: [...variants.values()] }));
  return {
    historyCompleteness: "unknown",
    counts: {
      records: records.length,
      knownSessions: sessions.length,
      forks: sessions.reduce(
        (sum, session) => sum + session.forkPoints.length,
        0,
      ),
      copies: occurrences.filter((item) => item.copyOf !== undefined).length,
      conflictGroups: conflictGroups.length,
      unknownIdentities: occurrences.filter((item) => item.uuid === null)
        .length,
      missingParentTargets: sessions.reduce(
        (sum, session) => sum + session.missingParentTargets.length,
        0,
      ),
    },
    occurrences,
    conflictGroups,
    sessions,
    unknownSessions: occurrences
      .filter((item) => item.sessionId === null || item.sessionId === "")
      .map(reference),
  };
}
