export function workflowTestHook(input: {
  readonly root: string;
  readonly extension: string;
  readonly exports: Readonly<Record<string, { readonly import: string }>>;
}): string {
  const modules = Object.fromEntries(
    Object.entries(input.exports).map(([subpath, target]) => {
      const path = target.import
        .replace("./dist/", "./")
        .replace(/\.js$/, input.extension);
      return ["cloving" + subpath.slice(1), new URL(path, input.root).href];
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
