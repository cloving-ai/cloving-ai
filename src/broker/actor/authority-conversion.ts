import {
  integer,
  latestSequence,
  loadBaseline,
} from "../../storage/domain-rows.ts";
import { adoptSchema, authorityIdentity } from "../../storage/domain-schema.ts";
import { restore } from "../authority-restore.ts";
import { upgradeDecisions } from "../decision-upgrade.ts";
import {
  ownedRuntime,
  recoverDeliveries,
  refused,
  type AuthorityOptions,
  type AuthorityRuntime,
  type OwnedRuntime,
  type Refusal,
} from "./authority-runtime.ts";

export interface ConversionOptions extends Pick<
  AuthorityOptions,
  "instrumentation" | "timing"
> {
  readonly progress?: (step: string) => void;
}

export type Conversion =
  | {
      readonly kind: "converted";
      readonly sequence: number;
      readonly staged: number;
    }
  | Refusal;

const adoptionKey = "cloving-adoption";

export async function convertAuthority(
  directory: string,
  options: ConversionOptions = {},
): Promise<Conversion> {
  const owned = await ownedRuntime(directory, {
    ...(options.instrumentation === undefined
      ? {}
      : { instrumentation: options.instrumentation }),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
  });
  if (owned.kind === "refused") return owned;
  let conversion: Conversion;
  try {
    conversion = await converted(owned, options);
  } catch (error) {
    conversion = refused("storage-failure", error);
  }
  await owned.parts.stop();
  return conversion;
}

async function converted(
  owned: OwnedRuntime,
  options: ConversionOptions,
): Promise<Conversion> {
  const { database, schema } = owned;
  const progress = options.progress ?? ((): void => undefined);
  if (schema.kind === "new")
    return { kind: "refused", reason: "nothing-to-convert", detail: "0" };
  const restored = restore(await database.connection(loadBaseline));
  if (restored.kind === "refused") return restored;
  progress("baseline-validated");
  if (schema.kind === "baseline") {
    await database.transaction((connection) =>
      adoptSchema(connection, restored.state.sequence),
    );
    progress("schema-adopted");
  }
  if (schema.kind !== "current") {
    await upgradeDecisions(database, restored.state);
    progress("schema-upgraded");
  }
  const identity = await database.connection(authorityIdentity);
  if (identity.pendingAdoption === null)
    return {
      kind: "converted",
      sequence: await database.connection(latestSequence),
      staged: 0,
    };
  return adopted({
    parts: owned.parts,
    actorId: identity.actorId,
    progress: options.progress,
  });
}

async function adopted(adoption: {
  readonly parts: AuthorityRuntime;
  readonly actorId: string;
  readonly progress: ((step: string) => void) | undefined;
}): Promise<Conversion> {
  const { parts, actorId, progress } = adoption;
  await parts.runtime.install();
  await parts.releaseEarlierOwners();
  progress?.("library-installed");
  const result = await parts.invoker(actorId, adoptionKey).adopt();
  return {
    kind: "converted",
    sequence: integer(result, "sequence"),
    staged: await recoverDeliveries(parts.invoker(actorId)),
  };
}
