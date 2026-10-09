const digest = /^[0-9a-f]{64}$/;

export type ResolvedResources =
  | {
      readonly kind: "resolved";
      readonly resources: Readonly<Record<string, string>>;
    }
  | { readonly kind: "inaccessible"; readonly path: string };

export function resolveResources(
  declared: readonly string[],
  discovered: unknown,
): ResolvedResources {
  const available: Readonly<Record<string, unknown>> =
    discovered && typeof discovered === "object" && !Array.isArray(discovered)
      ? Object.fromEntries(Object.entries(discovered))
      : {};
  const entries: Array<[string, string]> = [];
  for (const path of declared) {
    const value = Object.hasOwn(available, path) ? available[path] : undefined;
    if (typeof value !== "string" || !digest.test(value))
      return { kind: "inaccessible", path };
    entries.push([path, value]);
  }
  return { kind: "resolved", resources: Object.fromEntries(entries) };
}
