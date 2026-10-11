import { join } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;

function given(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function runtimeDirectory(environment: Environment): string | undefined {
  const explicit = environment["CLOVING_RUNTIME_DIR"];
  if (given(explicit)) return explicit;
  const runtime = environment["XDG_RUNTIME_DIR"];
  if (given(runtime)) return join(runtime, "cloving");
  const state = environment["XDG_STATE_HOME"];
  if (given(state)) return join(state, "cloving", "run");
  const home = environment["HOME"];
  return given(home)
    ? join(home, ".local", "state", "cloving", "run")
    : undefined;
}
