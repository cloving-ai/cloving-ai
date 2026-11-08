import { pageTitle, type WatchModel } from "./watch-render.ts";

export interface WatchLocation {
  readonly workflowId: string | null;
  readonly runId: string | null;
  readonly turnId?: string | null;
}

export function watchLocation(hash: string): WatchLocation {
  const value = hash.replace(/^#/, "");
  if (value === "") return { workflowId: null, runId: null };
  if (/^(workflow|run)=/.test(value)) {
    const fields = new URLSearchParams(value);
    const turnId = fields.get("turn") || null;
    return {
      workflowId: fields.get("workflow") || null,
      runId: fields.get("run") || null,
      ...(turnId === null ? {} : { turnId }),
    };
  }
  try {
    return { workflowId: null, runId: decodeURIComponent(value) };
  } catch {
    return { workflowId: null, runId: value };
  }
}

export function watchHash(location: WatchLocation): string {
  const workflow =
    location.workflowId === null
      ? ""
      : `workflow=${encodeURIComponent(location.workflowId)}`;
  const run =
    location.runId === null ? "" : `run=${encodeURIComponent(location.runId)}`;
  const turn =
    location.turnId === undefined || location.turnId === null
      ? ""
      : `turn=${encodeURIComponent(location.turnId)}`;
  return `#${[workflow, run, turn].filter((part) => part !== "").join("&")}`;
}

export function boardWorkflow(
  model: WatchModel,
  workflowId: string | null,
): string | null {
  return model.workflows.some((workflow) => workflow.workflowId === workflowId)
    ? workflowId
    : null;
}

export function watchTitle(model: WatchModel, selected: string): string {
  const location = watchLocation(selected);
  if (location.runId !== null) return pageTitle(model, location.runId);
  const workflow = boardWorkflow(model, location.workflowId);
  const waiting = model.workflows.reduce(
    (total, item) => total + item.waitingCount,
    0,
  );
  const prefix = waiting === 0 ? "" : `(${String(waiting)}) `;
  return `${prefix}${workflow ?? "Floor"} · Cloving`;
}
