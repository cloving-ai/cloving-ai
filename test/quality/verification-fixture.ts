import { join } from "node:path";
import { withFiles } from "./files-fixture.ts";
import type {
  VerificationInputs,
  VerificationPlan,
} from "../../quality/verification-types.ts";

export async function withVerification(
  source: string,
  inspect: (
    plan: VerificationPlan,
    inputs: VerificationInputs,
  ) => Promise<void>,
): Promise<void> {
  await withFiles({ "check.js": source }, async (directory) => {
    const file = join(directory, "check.js");
    await inspect(
      {
        requiredChecks: ["quality"],
        commands: [
          {
            id: "quality",
            executable: process.execPath,
            arguments: [file],
            directory,
            timeoutMilliseconds: 1000,
          },
        ],
      },
      {
        source: [file],
        tests: [file],
        dependencies: [file],
        tools: [process.execPath, file],
        policy: [file],
        exceptions: [],
      },
    );
  });
}
