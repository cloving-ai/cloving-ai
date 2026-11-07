import type {
  CycleOutcome,
  ProtectedResult,
  PullRequest,
} from "cloving/workflows";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
import type { DevelopTask } from "./report.ts";

export interface DemoRequest {
  readonly input: DevelopTask;
  readonly round: number;
  readonly pull: PullRequest;
}

const video = "demo.mp4";

function demoPrompt(request: {
  readonly demo: DemoRequest;
  readonly failure: string | null;
}): string {
  const { input, pull } = request.demo;
  const prompt = [
    `Record a demo video of pull request #${String(pull.number)} at commit ${pull.commit}, the head of this work tree.`,
    "The variable CLOVING_DEMO_TOOL holds the absolute path of the demo tool. Read its instruction file first, for example SKILL.md in a folder, and follow its rules and procedure.",
    "When CLOVING_DEMO_TOOL is not set or you cannot read it, record nothing and give the reason.",
    `Remove an earlier "$CLOVING_ATTACHMENTS_DIRECTORY/${video}", then write the final video to "$CLOVING_ATTACHMENTS_DIRECTORY/${video}". Keep the scene script and the other files outside the work tree, for example in that folder.`,
    "Show what the change does in at most 60 seconds. For a change with no visible surface, record a terminal scene that runs the new or changed tests or commands of the change.",
    "Keep the video smaller than 10 MB. The video is public when the repository is public, so keep local paths and private data out of it.",
    "Read the contact sheet of the video, and record again until each frame shows what you intend.",
    "Do not change, commit or push tracked files, and do not publish anything.",
    "Report the length of the video. Finish with exactly one of these lines:",
    "Demo status: recorded",
    "Demo status: failed",
    "",
    "Task:",
    input.ticket,
  ].join("\n");
  if (request.failure === null) return prompt;
  return [prompt, "", "The earlier demo attempt failed:", request.failure].join(
    "\n",
  );
}

function demoScope(request: {
  readonly operation: string;
  readonly round: number;
  readonly attempt: number;
}) {
  return {
    phase: "demo",
    operation: request.operation,
    round: request.round,
    key: `attempt-${String(request.attempt)}`,
  };
}

export function demoFailure(result: ProtectedResult): string | null {
  if (result.kind !== "completed")
    return `The demo turn ended ${result.reason ?? result.kind}.`;
  const value: unknown = JSON.parse(result.result ?? "null");
  if (
    typeof value !== "object" ||
    value === null ||
    !("summary" in value) ||
    typeof value.summary !== "string"
  )
    return "The demo turn gave no report.";
  const last = value.summary.trimEnd().split("\n").at(-1);
  if (last?.trim() === "Demo status: recorded") return null;
  return value.summary;
}

export async function demoTurn(request: {
  readonly demo: DemoRequest;
  readonly attempt: number;
  readonly failure: string | null;
}): Promise<ProtectedResult> {
  const { demo } = request;
  return await protectedEffect({
    scope: demoScope({
      operation: "claude-turn",
      round: demo.round,
      attempt: request.attempt,
    }),
    capability: "claude",
    method: "run-turn",
    target: demo.input.cycleId,
    payload: demoPrompt({ demo: demo, failure: request.failure }),
    units: 1,
  });
}

export async function attachDemo(request: {
  readonly demo: DemoRequest;
  readonly attempt: number;
}): Promise<boolean> {
  const { demo } = request;
  const result = await protectedEffect({
    scope: demoScope({
      operation: "github-attach",
      round: demo.round,
      attempt: request.attempt,
    }),
    capability: "github",
    method: "attach-asset",
    target: demo.input.cycleId,
    payload: JSON.stringify({
      number: demo.pull.number,
      name: video,
      release: "pr-demos",
      comment: `Demo video of commit ${demo.pull.commit.slice(0, 7)}. A Cloving turn recorded it.`,
      place: "description",
    }),
    units: 1,
  });
  return result.kind === "completed";
}

export async function uploadDemo(demo: DemoRequest): Promise<boolean> {
  if (await attachDemo({ demo: demo, attempt: 1 })) return true;
  return await attachDemo({ demo: demo, attempt: 2 });
}

export async function retryDemo(request: {
  readonly demo: DemoRequest;
  readonly failure: string;
}): Promise<boolean> {
  const { demo } = request;
  const second = await demoTurn({
    demo: demo,
    attempt: 2,
    failure: request.failure,
  });
  if (demoFailure(second) !== null) return false;
  return await attachDemo({ demo: demo, attempt: 2 });
}

export async function recordDemo(
  demo: DemoRequest,
): Promise<CycleOutcome | null> {
  const first = await demoTurn({ demo: demo, attempt: 1, failure: null });
  const failure = demoFailure(first);
  const shown =
    failure === null
      ? await uploadDemo(demo)
      : await retryDemo({ demo: demo, failure: failure });
  if (shown) return null;
  return {
    kind: "blocked",
    cycleId: demo.input.cycleId,
    reason: "demo-failed",
    evidenceId: "demo",
  };
}
