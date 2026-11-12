export const piInputExtensionPath = import.meta.filename;

export type PiInputHandler = (event: {
  readonly text: string;
  readonly source: string;
}) =>
  | { readonly action: "transform"; readonly text: string }
  | { readonly action: "handled" }
  | undefined;

export default function installInput(extension: {
  readonly on: (event: "input", handler: PiInputHandler) => void;
}): void {
  let pending = true;
  extension.on("input", (event) => {
    if (!pending || event.source !== "interactive") return undefined;
    pending = false;
    try {
      const text: unknown = JSON.parse(event.text);
      if (typeof text === "string") return { action: "transform", text };
    } catch {
      return { action: "handled" };
    }
    return { action: "handled" };
  });
}
