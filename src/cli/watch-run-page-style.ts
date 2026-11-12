export const runPageStyle = `
.banner-main { display: grid; gap: 2px; }
.banner-main > * { min-width: 0; }
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
.run-head-actions > button, .run-head-actions .token-menu-open { margin: 0; padding: 4px 10px; font: 500 13px/1.4 var(--font-ui); color: var(--color-ink); background: var(--color-panel); clip-path: none; border-radius: calc(var(--shape-radius) / 2); }
.run-head-actions .token-menu { position: relative; width: auto; }
.run-head-actions .token-menu-open { position: static; width: auto; opacity: 1; }
.run-more-items { display: grid; gap: 2px; }
.run-head-actions > button:hover, .run-head-actions .token-menu-open:hover { background: var(--color-surface); box-shadow: inset 0 0 0 var(--shape-border) var(--color-line); }
.run-facts { margin: 14px 0 0; font: 500 14px/1.5 var(--font-ui); font-variant-numeric: tabular-nums; color: var(--color-muted); }
.run-facts a { font-weight: 600; }
.run-details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 12px 0; }
.run-details dt { color: var(--color-muted); }
.run-details dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .run-head-actions { grid-column: 1 / -1; flex-wrap: wrap; justify-content: flex-end; }
  .run-tabs { overflow-x: auto; }
  .run-tabs .run-tab { flex: none; padding: 8px 10px; white-space: nowrap; }
}
`;
