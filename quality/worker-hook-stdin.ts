import type { Readable } from "node:stream";

export async function readWorkerHookInput(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const deadline = setTimeout(() => {
    stream.destroy(new Error("worker-hook-input-timeout"));
  }, 1000);
  try {
    for await (const value of stream) {
      const chunk: unknown = value;
      if (!Buffer.isBuffer(chunk)) throw new Error("invalid-worker-hook-input");
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("worker-hook-input-limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(deadline);
  }
}
