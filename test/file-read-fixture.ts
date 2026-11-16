import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

export interface ObservedReads<Value> {
  readonly value: Value;
  readonly peak: number;
  readonly files: number;
}

export async function observedReads<Value>(
  body: () => Promise<Value>,
  options: { readonly within?: string } = {},
): Promise<ObservedReads<Value>> {
  const read = filesystem.readFile;
  const files = new Set<string>();
  const reads = { active: 0, peak: 0 };
  const counted = (path: Parameters<typeof read>[0]): path is string =>
    typeof path === "string" &&
    (options.within === undefined || path.startsWith(options.within));
  Object.defineProperty(filesystem, "readFile", {
    value: async (
      ...arguments_: Parameters<typeof read>
    ): Promise<Buffer | string> => {
      const [path] = arguments_;
      if (!counted(path)) return await read(...arguments_);
      reads.active += 1;
      reads.peak = Math.max(reads.peak, reads.active);
      try {
        const bytes = await read(...arguments_);
        files.add(path);
        return bytes;
      } finally {
        reads.active -= 1;
      }
    },
  });
  syncBuiltinESMExports();
  try {
    const value = await body();
    return { value, peak: reads.peak, files: files.size };
  } finally {
    filesystem.readFile = read;
    syncBuiltinESMExports();
  }
}
