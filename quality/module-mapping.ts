export interface MappingPolicy {
  readonly accepted: Readonly<Record<string, string>>;
  readonly automaticRoles: readonly string[];
}

export function mapModules(
  files: readonly string[],
  proposal: Readonly<Record<string, string>>,
  policy: MappingPolicy,
): Readonly<Record<string, string>> {
  if (files.length === 0) throw new Error("empty-module-inventory");
  for (const file of Object.keys(proposal)) {
    if (!files.includes(file)) throw new Error(`unused-mapping: ${file}`);
  }
  return Object.fromEntries(
    [...files]
      .sort()
      .map((file) => [file, admittedRole(file, proposal, policy)]),
  );
}

function admittedRole(
  file: string,
  proposal: Readonly<Record<string, string>>,
  policy: MappingPolicy,
): string {
  const accepted = policy.accepted[file];
  const role = proposal[file] ?? accepted;
  if (!role) throw new Error(`unmapped-module: ${file}`);
  if (accepted && role !== accepted)
    throw new Error(`mapping-policy-change: ${file}`);
  if (!accepted && !policy.automaticRoles.includes(role))
    throw new Error(`mapping-requires-review: ${file}`);
  return role;
}
