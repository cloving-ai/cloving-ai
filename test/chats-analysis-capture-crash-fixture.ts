import filesystem from "node:fs/promises";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { captureAnalysisSnapshot } from "../src/daemon/chats-capture.ts";

const [directory, runId, importId, boundary] = process.argv.slice(2);
if (!directory || !runId || !importId || !boundary)
  throw new Error("missing-capture-crash-input");

const original = filesystem.open;
filesystem.open = async (path, flags) => {
  const handle = await original(path, flags, 0o600);
  if (
    basename(String(path)) === boundary &&
    typeof flags === "number" &&
    (flags & 1) === 1
  ) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (data, options) => {
      await write(data, options);
      process.send?.("capture-write-paused");
      await once(process, "message");
    };
  }
  return handle;
};
syncBuiltinESMExports();
await captureAnalysisSnapshot(directory, { runId, importId });
