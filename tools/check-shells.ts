import { spawnSync } from "node:child_process";
import { join } from "node:path";

const directory = process.argv[2] ?? "/bin";
for (const name of ["zsh", "bash"]) {
  const probe = spawnSync(join(directory, name), ["--version"], {
    stdio: "ignore",
    timeout: 10000,
  });
  if (probe.status !== 0) {
    console.error(
      `${name} is required for shell tests; see README: Development of Cloving. Install it at /bin/${name} before running checks.`,
    );
    process.exitCode = 1;
  }
}
