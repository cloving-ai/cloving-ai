import { admitCompiled } from "../cli/validate.ts";
import { declaredManifest } from "../execution-pin.ts";
import type { FeedRegistration } from "../service/registry.ts";
import type { WorkflowDeclaration } from "../workflow-declaration.ts";

type DeclaredFeed = Pick<FeedRegistration, "functionName" | "effectLimit">;

export function declaredFeed(declaration: WorkflowDeclaration): {
  readonly feedDefinition?: DeclaredFeed;
} {
  const { queue } = declaration;
  if (typeof queue !== "object" || queue.feed === undefined) return {};
  return {
    feedDefinition: {
      functionName: queue.feed,
      effectLimit: queue.feedEffectLimit ?? declaration.effectLimit,
    },
  };
}

export async function admitFeed(
  manifests: Readonly<Record<string, string | undefined>>,
  declaration: {
    readonly workflowId: string;
    readonly feedDefinition: DeclaredFeed | undefined;
    readonly capabilities: readonly string[];
    readonly commands?: readonly string[];
    readonly bundleDigest?: string | undefined;
  },
): Promise<
  | { readonly kind: "admitted"; readonly feed?: FeedRegistration }
  | { readonly kind: "rejected"; readonly detail: string }
> {
  const feed = declaration.feedDefinition;
  if (feed === undefined) return { kind: "admitted" };
  const missing = {
    kind: "rejected" as const,
    detail: `queue-feed-missing: ${declaration.workflowId} -> ${feed.functionName}`,
  };
  const path = manifests[feed.functionName];
  if (path === undefined) return missing;
  const admission = await admitCompiled(path, {
    file: path,
    capabilities: declaration.capabilities,
  });
  if (admission.kind === "rejected")
    return {
      kind: "rejected",
      detail: `${admission.error.code}: ${admission.error.detail}`,
    };
  if (!admission.manifest.workflowId.endsWith(`//${feed.functionName}`))
    return missing;
  return {
    kind: "admitted",
    feed: {
      ...feed,
      manifest: declaredManifest(admission.manifest, {
        ...(declaration.commands === undefined
          ? {}
          : { commands: declaration.commands }),
        bundleDigest: declaration.bundleDigest,
      }),
    },
  };
}
