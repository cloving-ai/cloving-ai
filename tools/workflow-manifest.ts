import type { WorkflowManifest } from "@workflow/builders";

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
