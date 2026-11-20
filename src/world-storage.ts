const sqliteWorld = { major: 5, minor: 4 };

function parsed(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, name);
}

function jsonWorldManifest(entry: unknown): boolean {
  const source = field(entry, "manifest");
  if (typeof source !== "string") return false;
  const manifest = parsed(source);
  if (field(manifest, "name") !== "@workflow/world-local") return false;
  const release = field(manifest, "version");
  if (typeof release !== "string") return false;
  const version = /^(\d+)\.(\d+)\./.exec(release);
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return (
    major < sqliteWorld.major ||
    (major === sqliteWorld.major && minor < sqliteWorld.minor)
  );
}

export function recordsJsonWorld(dependencies: string): boolean {
  const packages = field(parsed(dependencies), "packages");
  return Array.isArray(packages) && packages.some(jsonWorldManifest);
}
