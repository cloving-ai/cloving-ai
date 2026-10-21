import filesystem, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

export function observeAnalysisCorpus(chunkSize = 65_536) {
  const original = filesystem.open;
  const observations = {
    bytes: 0,
    reads: [] as number[],
    writes: 0,
    handles: [] as FileHandle[],
  };
  filesystem.open = async (path, flags) => {
    const handle = await original(path, flags, 0o600);
    observations.handles.push(handle);
    if (basename(String(path)) !== "redacted.jsonl") return handle;
    if (typeof flags === "number" && (flags & 1) === 1) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (data, options) => {
        observations.writes++;
        return write(data, options);
      };
      return handle;
    }
    const read = handle.read.bind(handle);
    Object.defineProperty(handle, "read", {
      value: async (options: { buffer: Buffer; length: number }) => {
        observations.reads.push(observations.writes);
        const result = await read({
          ...options,
          length: Math.min(options.length, chunkSize),
        });
        observations.bytes += result.bytesRead;
        return result;
      },
    });
    handle.readFile = () => Promise.reject(new Error("unbounded-read"));
    return handle;
  };
  syncBuiltinESMExports();
  return {
    observations,
    restore: () => {
      filesystem.open = original;
      syncBuiltinESMExports();
    },
  };
}
