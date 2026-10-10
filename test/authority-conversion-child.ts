import { convertAuthority } from "../src/broker/actor/authority-conversion.ts";
import { fastTiming } from "./authority-actor-fixture.ts";

const [directory = "", barrier = ""] = process.argv.slice(2);

function stop(step: string): void {
  if (step === barrier) process.kill(process.pid, "SIGKILL");
}

function stall(): void {
  const until = performance.now() + 400;
  while (performance.now() < until);
}

const conversion = await convertAuthority(directory, {
  timing: fastTiming,
  progress: stop,
  instrumentation: (event) => {
    if (event.name === "solid_objects.commit_action.started")
      stop("adoption-commit");
    if (
      barrier === "adoption-stranded" &&
      event.name === "solid_objects.activation.lost"
    )
      setTimeout(() => {
        stop("adoption-stranded");
      }, 100);
    if (
      barrier === "adoption-stranded" &&
      event.name === "solid_objects.message.started"
    )
      stall();
  },
});
process.stdout.write(`${JSON.stringify(conversion)}\n`);
