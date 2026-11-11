export const runPageStyle = `
.banner-main { display: grid; gap: 2px; }
.run-identity { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0; font-size: 20px; line-height: 1.35; }
.run-identity .name-label { font: 600 14px/1.4 var(--font-ui); color: var(--color-muted); }
.name-edit { margin: 0; padding: 0 6px; font: 500 15px/1.4 var(--font-ui); color: var(--color-muted); background: none; clip-path: none; opacity: 0; }
.run-identity:hover .name-edit, .name-edit:focus { opacity: 1; }
.run-status { margin: 0; font: 600 13px/1.5 var(--font-ui); font-variant-numeric: tabular-nums; }
.banner-detail { margin: 0; font-size: 13px; color: var(--color-muted); }
.banner .rename-form { display: flex; flex-wrap: wrap; align-items: end; gap: 6px; }
.banner .rename-form label { display: grid; gap: 2px; font-size: 11px; color: var(--color-muted); }
.banner .rename-form label:first-of-type { flex: 1 1 18rem; }
.banner .rename-form label:nth-of-type(2) { order: -1; flex: 0 0 8rem; }
.banner .rename-form button { margin: 0; padding: 4px 12px; font: 500 13px/1.4 var(--font-ui); clip-path: none; border-radius: calc(var(--shape-radius) / 2); }
.banner .rename-form button[type="submit"] { color: var(--color-on-accent); background: var(--color-accent); }
.banner .rename-form button[type="button"] { color: var(--color-muted); background: none; }
.run-head-actions { display: flex; align-items: flex-start; gap: 6px; flex: 0 0 auto; }
.run-head-actions button { margin: 0; padding: 4px 10px; font: 500 13px/1.4 var(--font-ui); color: var(--color-ink); background: var(--color-panel); clip-path: none; border-radius: calc(var(--shape-radius) / 2); }
.run-head-actions button:hover { background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.run-more { position: relative; }
.run-more-menu { position: absolute; top: 100%; right: 0; z-index: 3; display: grid; gap: 2px; min-width: 200px; margin-top: 6px; padding: 6px; border-radius: calc(var(--shape-radius) / 2); background: var(--color-surface); box-shadow: var(--shadow), inset 0 0 0 var(--shape-border) var(--color-line); font: 500 13px/1.4 var(--font-ui); visibility: hidden; opacity: 0; transition: visibility 0s linear 200ms, opacity 120ms ease 200ms; }
.run-more-menu::before { content: ""; position: absolute; top: -8px; left: 0; right: 0; height: 8px; }
.run-more:hover .run-more-menu, .run-more:focus-within .run-more-menu { visibility: visible; opacity: 1; transition-delay: 0s; }
.run-more[data-hold] .run-more-menu { visibility: hidden; opacity: 0; transition: none; }
.run-more-menu button { width: 100%; text-align: left; background: none; }
.run-more-menu .run-command-drop { color: var(--color-state-failed); }
.run-more-split { width: 100%; margin: 4px 0; border: 0; border-top: var(--shape-border) solid var(--color-line); }
.run-facts { margin: 14px 0 0; font: 500 14px/1.5 var(--font-ui); font-variant-numeric: tabular-nums; color: var(--color-muted); }
.run-facts a { font-weight: 600; }
.run-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 12px 0; }
.run-details dt { color: var(--color-muted); }
.run-details dd { margin: 0; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) {
  .run-more-menu { transition: visibility 0s linear 200ms; }
}
@media (max-width: 720px) {
  .run-head-actions { grid-column: 1 / -1; flex-wrap: wrap; justify-content: flex-end; }
  .run-tabs { overflow-x: auto; }
  .run-tabs .run-tab { flex: none; padding: 8px 10px; white-space: nowrap; }
}
`;
