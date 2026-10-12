export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export function upsert(target: {
  readonly table: string;
  readonly names: readonly string[];
  readonly key: number;
}): string {
  const { table, names, key } = target;
  const updates = names
    .slice(key)
    .map((name) => `${name} = excluded.${name}`)
    .join(", ");
  return `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ON CONFLICT (${names.slice(0, key).join(", ")}) DO UPDATE SET ${updates}`;
}
