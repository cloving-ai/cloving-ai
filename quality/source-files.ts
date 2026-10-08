import { resolve } from "node:path";
import { inspectInventory } from "./inventory.ts";

export interface SourceOptions {
  readonly generated?: Readonly<Record<string, string>>;
}

export async function sourceFiles(
  directory: string,
  options: SourceOptions = {},
): Promise<string[]> {
  const inventory = await inspectInventory(directory, options.generated ?? {});
  return inventory.sources.map((file) => resolve(directory, file));
}
