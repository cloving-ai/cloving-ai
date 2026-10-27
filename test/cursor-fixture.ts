import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

export function cursorFixture(name: string): string {
  const events: unknown = JSON.parse(
    readFileSync(
      new URL(`./fixtures/cursor-agent/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
  if (!Array.isArray(events)) throw new Error("Invalid Cursor fixture");
  return events.map((event: unknown) => JSON.stringify(event)).join("\n");
}

export function fakeCursor(
  scene: Pick<Scene, "directory">,
  options: { readonly output: string; readonly exitCode?: number },
) {
  const path = join(scene.directory, "cursor-agent");
  const record = join(scene.directory, "cursor-invocations.jsonl");
  writeFileSync(
    path,
    `#!${process.execPath}
import { appendFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
appendFileSync(${JSON.stringify(record)}, JSON.stringify({arguments:process.argv.slice(2),directory:process.cwd(),environment:process.env,configuration:readdirSync(process.env.GH_CONFIG_DIR)}) + "\\n");
writeFileSync("change.txt", "updated");
execFileSync("git", ["add", "change.txt"]);
execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "commit", "-m", "Apply the change"]);
process.stdout.write(${JSON.stringify(options.output)});
process.exitCode = ${String(options.exitCode ?? 0)};
`,
    { mode: 0o700 },
  );
  return { name: "cursor-agent", path };
}
