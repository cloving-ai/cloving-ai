import { extname } from "node:path";
import packageMetadata from "#package" with { type: "json" };
import { workflowTestHook } from "./workflow-test-hook.ts";

export function workflowTestLoader(): string {
  return workflowTestHook({
    root: new URL("../", import.meta.url).href,
    extension: extname(import.meta.filename),
    exports: packageMetadata.exports,
  });
}
