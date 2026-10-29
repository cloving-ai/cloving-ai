# Cloving development

Work only in this application repository. Read the external implementation prompt, the ticket workflow, the dependency policy and the quality policy. These four documents are outside this repository.

Keep plans, ticket exports, development journals, credentials, runtime state and accepted bundles outside this repository and npm artifact. Preserve existing edits. Claim one eligible live ticket under the standing grant before work.

Use TypeScript on Node. The selected durable engine is Workflow SDK with bundled Local World; directives require its compiler, not only TypeScript emission. Keep pure authority logic separate from storage, broker effects, workflow hosting and adapters. Add modules only when implemented behavior requires them. Public helpers accept serializable data; they never grant authority.

Write and observe the intended failing test before each behavior, then implement the minimum, verify green and refactor. Record exact revisions and evidence externally. Independent read-only review precedes acceptance. No source comments, implicit authority, hidden model calls or skipped checks.

Setup commands: `npm ci --ignore-scripts`, `npm run check:setup`, `npm run build`, `npm pack --ignore-scripts`. The full `npm run check` and `npm run test:concurrency` fail closed on purpose. They are the admission gate of the operator, not work of a ticket. A ticket passes with `npm run check:quality`. Never list the fail-closed gate as remaining work. Repository policy copies are proposals; accepted verification policy lives outside candidate write access.

Pin and justify every dependency. Inspect the installed packed artifact with scripts disabled. Stage explicit owned paths only. Never add AI attribution, bypass hooks, overwrite unrelated work, push, publish or deploy without scope in the grant.
