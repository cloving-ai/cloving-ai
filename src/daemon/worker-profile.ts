import { turnHarness, type HarnessSettings } from "../harness-defaults.ts";
import type { TurnProfile, TurnProfiles } from "../turn-profile.ts";
import type { ProtectedIntent } from "../broker/actor/delivery-intents.ts";

export interface WorkerProfiles extends HarnessSettings {
  readonly profiles?: TurnProfiles;
  readonly workflowId?: (runId: string) => Promise<string | undefined>;
}

async function runWorkflow(
  settings: WorkerProfiles,
  runId: string,
): Promise<string | undefined> {
  try {
    return await settings.workflowId?.(runId);
  } catch {
    return undefined;
  }
}

function unsupportedProfile(
  profile: TurnProfile,
  harness: ReturnType<typeof turnHarness>,
): string | undefined {
  if (harness.output === "text" && profile.model !== undefined)
    return "profile-model-not-supported";
  if (harness.worker === "claude") return undefined;
  return [
    profile.allowedTools,
    profile.permissionMode,
    profile.maxBudgetUsd,
  ].some((value) => value !== undefined)
    ? "profile-needs-claude"
    : undefined;
}

export async function selectedProfile(
  settings: WorkerProfiles,
  intent: ProtectedIntent,
): Promise<TurnProfile | string> {
  if (intent.method === "run-turn") return {};
  const name = intent.method.slice("run-turn:".length);
  const profiles = settings.profiles ?? {};
  const profile = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (profile === undefined) return "unknown-profile";
  const unsupported = unsupportedProfile(
    profile,
    turnHarness(settings, profile),
  );
  if (unsupported !== undefined) return unsupported;
  if (profile.workflows === undefined) return profile;
  const workflowId = await runWorkflow(settings, intent.runId);
  if (workflowId === undefined || !profile.workflows.includes(workflowId))
    return "profile-not-allowed";
  return profile;
}
