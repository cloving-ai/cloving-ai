import { mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { record } from "../src/protocol.ts";
import { preparedBundle } from "./self-host-project.ts";

const settings = record(JSON.parse(String(process.argv[2]))) ?? {};

function optional(name: string): string | undefined {
  const value = settings[name];
  return typeof value === "string" ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (value === undefined)
    throw new Error(`The reload program needs the start setting ${name}.`);
  return value;
}

const directory = required("directory");
const project = await mkdtemp(join(directory, "reload-"));
try {
  const prepared = await preparedBundle({
    product: resolve(import.meta.dirname, ".."),
    project,
    recordedProject: join(directory, "project"),
    repository: required("repository"),
    home: required("home"),
    xdgConfigHome: optional("xdgConfigHome"),
    userFolder: optional("userFolder"),
  });
  const bundle = join(directory, "workflow-bundles", prepared.bundleDigest);
  process.stdout.write(
    JSON.stringify({
      ...prepared,
      manifests: Object.fromEntries(
        Object.entries(prepared.manifests).map(([name, path]) => [
          name,
          join(bundle, basename(path)),
        ]),
      ),
    }),
  );
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error) }));
  process.exitCode = 1;
} finally {
  await rm(project, { recursive: true, force: true });
}
