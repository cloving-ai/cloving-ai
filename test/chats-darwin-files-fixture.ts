import { constants, lstatSync, type PathLike } from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function withoutLinks(path: PathLike): string {
  const text = path instanceof URL ? fileURLToPath(path) : String(path);
  let ancestor = resolve(text);
  for (;;) {
    try {
      if (lstatSync(ancestor).isSymbolicLink())
        throw Object.assign(new Error("ELOOP: simulated-darwin-link-refusal"), {
          code: "ELOOP",
        });
    } catch (error) {
      if (Reflect.get(Object(error), "code") !== "ENOENT") throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return text;
    ancestor = parent;
  }
}

function simulatedPath(path: PathLike): PathLike {
  const text = String(path);
  if (!text.startsWith("/.nofollow/")) return path;
  return withoutLinks(text.slice("/.nofollow".length));
}

function installDarwinFileSubstitutes(): void {
  const original = {
    lstat: filesystem.lstat,
    readdir: filesystem.readdir,
    open: filesystem.open,
  };
  Object.defineProperty(filesystem, "lstat", {
    value: (...[path, ...options]: Parameters<typeof filesystem.lstat>) =>
      original.lstat(simulatedPath(path), ...options),
  });
  Object.defineProperty(filesystem, "readdir", {
    value: (...[path, ...options]: Parameters<typeof filesystem.readdir>) =>
      original.readdir(simulatedPath(path), ...options),
  });
  filesystem.open = (path, flags) => {
    if (typeof flags !== "number" || (flags & 0x20000000) === 0)
      return original.open(path, flags, 0o600);
    return original.open(
      withoutLinks(path),
      (flags & ~0x20000000) | constants.O_NOFOLLOW,
      0o600,
    );
  };
  process.env["CLOVING_TEST_DARWIN_FILES"] = "1";
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  syncBuiltinESMExports();
}

if (process.platform === "linux") installDarwinFileSubstitutes();
