import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThemeFolders } from "../src/cli/theme-folders.ts";
import type { Fields } from "../src/protocol.ts";
import { withTokens } from "./theme-check-fixture.ts";
import { writeTheme } from "./theme-scene-fixture.ts";

export const plainRunning = "#7A1FA2";

export function plainTheme(): Fields {
  return {
    color: {
      state: { running: { $type: "color", $value: plainRunning } },
    },
    $extensions: {
      "ai.cloving.theme": { name: "Plain", colorScheme: "dark" },
    },
  };
}

export async function themeScene(): Promise<
  ThemeFolders & AsyncDisposable & { readonly root: string }
> {
  const root = await mkdtemp(join(tmpdir(), "cloving-watch-themes-"));
  const folders = {
    project: join(root, "project"),
    user: join(root, "user"),
    builtIn: join(root, "built-in"),
  };
  await writeTheme(join(folders.project, "workshop"));
  await writeFile(
    join(folders.project, "workshop/assets/other.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>',
  );
  await writeTheme(join(folders.project, "plain"), plainTheme());
  await writeTheme(
    join(folders.user, "broken"),
    withTokens({ color: { page: { $type: "color", $value: "red" } } }),
  );
  return {
    ...folders,
    root,
    async [Symbol.asyncDispose]() {
      await chmod(folders.user, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}
