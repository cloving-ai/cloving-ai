import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Fields } from "../src/protocol.ts";
import type { DoctorScene } from "./doctor-fixture.ts";
import { workshopTheme } from "./theme-check-fixture.ts";

const execute = promisify(execFile);
const entry = resolve("src/cli.ts");

export interface CommandOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const builtInThemes = [
  {
    name: "floor",
    place: "built-in",
    title: "Floor",
    colorScheme: "light",
    usable: true,
    codes: [],
    replaces: [],
  },
  {
    name: "floor-at-night",
    place: "built-in",
    title: "Floor at night",
    colorScheme: "dark",
    usable: true,
    codes: [],
    replaces: [],
  },
  {
    name: "workshop",
    place: "built-in",
    title: "Workshop",
    colorScheme: "light",
    usable: true,
    codes: [],
    replaces: [],
  },
];

export function projectThemes(scene: DoctorScene): string {
  return join(scene.repository, ".cloving/themes");
}

export function userThemes(scene: DoctorScene): string {
  return join(scene.root, "config/cloving/themes");
}

export async function writeTheme(
  folder: string,
  theme: Fields = workshopTheme(),
): Promise<void> {
  await mkdir(join(folder, "assets"), { recursive: true });
  await writeFile(join(folder, "theme.json"), JSON.stringify(theme));
  await writeFile(
    join(folder, "assets/bench.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  );
}

export function cloving(
  scene: DoctorScene,
  argumentsList: readonly string[],
): Promise<CommandOutput> {
  return execute(process.execPath, [entry, ...argumentsList], {
    cwd: scene.repository,
    env: scene.environment,
    timeout: 20000,
  }).then(
    (output) => ({ ...output, status: 0 }),
    (error: unknown) => {
      if (
        error instanceof Error &&
        "stdout" in error &&
        "stderr" in error &&
        "code" in error
      )
        return {
          stdout: String(error.stdout),
          stderr: String(error.stderr),
          status: Number(error.code),
        };
      throw error;
    },
  );
}
