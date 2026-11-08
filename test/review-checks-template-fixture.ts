import { fileURLToPath } from "node:url";
import { developFiles } from "./develop-template-flow-fixture.ts";

export const checksTemplate = fileURLToPath(
  new URL("../templates/review-checks", import.meta.url),
);

export async function checksFiles(): Promise<Record<string, string>> {
  return await developFiles(checksTemplate);
}
