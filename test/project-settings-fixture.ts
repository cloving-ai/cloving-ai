import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export function settingsScene() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cloving-settings-")));
  const repository = join(root, "repository");
  mkdirSync(join(repository, ".cloving"), { recursive: true });
  const environment = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  const name = basename(repository);
  const id = createHash("sha256").update(repository).digest("hex").slice(0, 8);
  const project = join(repository, ".cloving/config.json");
  const privateFile = join(
    environment.XDG_CONFIG_HOME,
    "cloving/projects",
    `${name}-${id}.json`,
  );
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  return { root, repository, environment, project, privateFile, write };
}
