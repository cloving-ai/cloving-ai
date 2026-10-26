import { extname } from "node:path";
import packageMetadata from "#package" with { type: "json" };

export function workflowTestLoader(): string {
  const extension = extname(import.meta.filename);
  const root = new URL("../", import.meta.url);
  const modules = Object.fromEntries(
    Object.entries(packageMetadata.exports).map(([subpath, target]) => {
      const path = target.import
        .replace("./dist/", "./")
        .replace(/\.js$/, extension);
      return ["cloving" + subpath.slice(1), new URL(path, root).href];
    }),
  );
  const hook = `import { registerHooks } from "node:module";
const modules = ${JSON.stringify(modules)};
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(modules[specifier] ?? specifier, context);
  },
});`;
  return "data:text/javascript," + encodeURIComponent(hook);
}
