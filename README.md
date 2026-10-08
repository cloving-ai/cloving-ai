# Cloving

TypeScript development scaffold for a local durable workflow service. Only `--help` and `--version` are available. Workflow execution, authority storage, helpers and autonomous development are not implemented.

The current pilot is Node 26.9.0, npm 11.19.1, macOS 27.0 on arm64. Other platforms and runtime versions are unqualified. This private pre-release package is not published.

The selected Workflow SDK and official builder are installed as development tooling. The shipped scaffold has no runtime dependencies because no workflow command or helper is implemented yet. Runtime SDK packaging still needs qualification before those features are admitted.

```sh
npm ci --ignore-scripts
npm run check:setup
npm run build
node dist/src/cli.js --help
npm pack --ignore-scripts
```

Install the resulting tarball into a separate project with `npm install --save-dev --ignore-scripts /absolute/path/to/cloving-0.4.0.tgz`, then run `npm exec -- cloving --version`. The package has no installation hooks. Importing `cloving/workflows` exposes no helpers yet and starts no service.

`npm run check` and `npm run test:concurrency` currently reject admission because the complete quality policy is not implemented. Setup checks are not product acceptance. State and retained releases will live outside the package installation; installing or updating the package does not activate a daemon or migrate state.

For trusted development fixtures, `npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY` runs the selected directive compiler. Its output directory must resolve the fixture's installed `workflow` dependency, normally beneath that fixture's project root. Generated handlers are development artifacts and do not grant authority to execute effects.
