import type { WorkflowManifest } from "@workflow/builders";

export function isWorkflowManifest(value: unknown): value is WorkflowManifest {
  if (!isRecord(value)) return false;
  return (
    (!("workflows" in value) ||
      hasIdentities(value["workflows"], "workflowId")) &&
    (!("steps" in value) || hasIdentities(value["steps"], "stepId")) &&
    (!("classes" in value) || hasIdentities(value["classes"], "classId"))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIdentities(value: unknown, identifier: string): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entries) =>
      isRecord(entries) &&
      Object.values(entries).every(
        (entry) => isRecord(entry) && typeof entry[identifier] === "string",
      ),
  );
}

export function serializeManifest(manifest: WorkflowManifest): string {
  const categories = orderedEntries(manifest).map(([kind, files]) => [
    kind,
    Object.fromEntries(
      orderedEntries<Record<string, Record<string, string>>>(files).map(
        ([file, entries]) => [
          file,
          Object.fromEntries(orderedEntries(entries)),
        ],
      ),
    ),
  ]);
  return JSON.stringify(Object.fromEntries(categories), null, 2);
}

function orderedEntries<Value>(
  value: Readonly<Record<string, Value>>,
): Array<[string, Value]> {
  return Object.entries(value).sort(([first], [second]) => {
    if (first === second) return 0;
    return first < second ? -1 : 1;
  });
}
