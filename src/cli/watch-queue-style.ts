export const queueStyle = `
.line:has(.line-queue) { grid-template-columns: 180px minmax(0, 1fr) 320px; }
.line-queue, .global-queue { min-width: 0; gap: 6px; }
.board-page > .line-queue { width: min(320px, calc(100% - 40px)); align-self: flex-start; margin: 0 20px 12px; flex-shrink: 0; }
.board-title { margin: 0; padding: 0 20px 8px; font-size: 18px; }
.queue-row { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 6px; flex-wrap: wrap; }
.queue-counts { font-size: 12px; color: var(--color-muted); }
.queue-stepper { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.queue-stepper output { min-width: 2ch; text-align: center; font-variant-numeric: tabular-nums; }
.queue-drain, .queue-more summary, .queue-source button, .queue-message button { min-height: 28px; min-width: 24px; padding: 4px 6px; font: inherit; cursor: pointer; color: var(--color-ink); background: var(--color-panel); border: var(--shape-border) solid var(--color-line); border-radius: var(--shape-radius); }
.queue-more { font-size: 12px; } .queue-more summary { list-style: none; } .queue-more[open] { flex-basis: 100%; } .queue-details { padding: 8px 0; }
.global-queue { display: flex; flex-direction: column; padding: 12px 20px; } .global-queue h3, .global-queue p { margin: 0; } .global-queue > p { font-size: 13px; }
.lanes.queue-meter { display: flex; width: 100%; height: 7px; gap: 3px; flex-wrap: nowrap; }
.queue-meter .lane { flex: 1 1 0; min-width: 0; width: auto; height: 7px; clip-path: none; border-radius: var(--shape-radius); }
.queue-warning { color: var(--color-bad); font-size: 12px; }
@media (max-width: 720px) { .line:has(.line-queue) { grid-template-columns: minmax(0, 1fr); } }
`;
