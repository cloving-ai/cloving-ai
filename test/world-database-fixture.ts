import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function worldRows(
  world: string,
  sql: string,
): readonly Readonly<Record<string, unknown>>[] {
  const path = join(world, "world.db");
  if (!existsSync(path)) return [];
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

export function worldDocument(doc: unknown): unknown {
  return JSON.parse(String(doc), (_key, value: unknown): unknown =>
    Reflect.get(Object(value), "__type") === "Date"
      ? Reflect.get(Object(value), "value")
      : value,
  );
}
