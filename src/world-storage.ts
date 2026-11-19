const sqliteWorld = { major: 5, minor: 4 };

function parsed(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function jsonWorldManifest(entry: unknown): boolean {
  const manifest = parsed(String(Reflect.get(Object(entry), "manifest")));
  if (Reflect.get(Object(manifest), "name") !== "@workflow/world-local")
    return false;
  const version = /^(\d+)\.(\d+)\./.exec(
    String(Reflect.get(Object(manifest), "version")),
  );
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return (
    major < sqliteWorld.major ||
    (major === sqliteWorld.major && minor < sqliteWorld.minor)
  );
}

export function recordsJsonWorld(dependencies: string): boolean {
  const packages: unknown = Reflect.get(
    Object(parsed(dependencies)),
    "packages",
  );
  return Array.isArray(packages) && packages.some(jsonWorldManifest);
}
