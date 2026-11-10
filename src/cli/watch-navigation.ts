import { pageTitle, type WatchModel } from "./watch-render.ts";

export interface WatchLocation {
  readonly workflowId: string | null;
  readonly runId: string | null;
  readonly repository?: string | undefined;
  readonly turnId?: string | null;
  readonly decisionId?: string | null;
  readonly view?: "terminal";
}

export function locationOptions(
  fields: URLSearchParams,
): Pick<WatchLocation, "repository" | "turnId" | "decisionId" | "view"> {
  const repository = fields.get("repository");
  const turnId = fields.get("turn") || null;
  const decisionId = fields.get("decision") || null;
  return {
    ...(repository ? { repository } : {}),
    ...(turnId === null ? {} : { turnId }),
    ...(decisionId === null ? {} : { decisionId }),
    ...(fields.get("view") === "terminal" ? { view: "terminal" } : {}),
  };
}

export function watchLocation(hash: string): WatchLocation {
  const value = hash.replace(/^#/, "");
  if (value === "") return { workflowId: null, runId: null };
  if (/^(workflow|run)=/.test(value)) {
    const fields = new URLSearchParams(value);
    return {
      workflowId: fields.get("workflow") || null,
      runId: fields.get("run") || null,
      ...locationOptions(fields),
    };
  }
  try {
    return { workflowId: null, runId: decodeURIComponent(value) };
  } catch {
    return { workflowId: null, runId: value };
  }
}

export function watchHash(location: WatchLocation): string {
  const parts: readonly (readonly [string, string | null | undefined])[] = [
    ["workflow", location.workflowId],
    ["repository", location.repository],
    ["run", location.runId],
    ["turn", location.turnId],
    ["decision", location.decisionId],
    ["view", location.view],
  ];
  return `#${parts
    .flatMap(([name, value]) =>
      typeof value === "string" ? [`${name}=${encodeURIComponent(value)}`] : [],
    )
    .join("&")}`;
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
