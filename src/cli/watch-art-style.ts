function backgroundArt(slot: string, host: string): string {
  return `.art-${slot} ${host} { position: relative; isolation: isolate; --art: var(--art-${slot}); --art-repeat: var(--art-${slot}-repeat); --art-rendering: var(--art-${slot}-rendering); }
.art-${slot} ${host}::after { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: var(--art) 0 0 / auto var(--art-repeat); image-rendering: var(--art-rendering); }
.art-${slot}-mask ${host}::after { background: var(--color-line); mask: var(--art) 0 0 / auto var(--art-repeat); }`;
}

export const artStyle = `
.theme-menu { display: inline-flex; align-items: center; gap: 6px; color: var(--color-muted); }
.theme-menu select { padding: 3px 6px; border: var(--shape-border) solid var(--color-line); border-radius: calc(var(--shape-radius) / 2); background: var(--color-panel); color: var(--color-ink); font: 500 13px/1.4 var(--font-ui); }
.theme-notice { flex-basis: 100%; margin: 0; color: var(--color-warn); font-size: 13px; }
${backgroundArt("floor", ".floor")}
${backgroundArt("header", "header")}
${backgroundArt("line-banner", ".line-name")}
.art-station .station:not(:last-child)::after { top: 15px; left: 16px; }
.art-station .station .lamp { width: 32px; height: 32px; margin: 0; transform: none; box-shadow: none; background: var(--art-station) center / contain var(--art-station-repeat); image-rendering: var(--art-station-rendering); }
.art-station-mask .station .lamp { background: var(--state, var(--color-muted)); mask: var(--art-station) center / contain var(--art-station-repeat); }
.art-station .station .lamp::after { content: ""; position: absolute; right: -4px; bottom: -4px; width: 10px; height: 10px; transform: rotate(45deg); background: var(--state, var(--color-surface)); box-shadow: inset 0 0 0 2px var(--color-muted); }
.art-station .station .lamp:is(.running, .waiting, .needs-you, .stopped)::after { box-shadow: 0 0 0 2px var(--color-panel); }
.art-run-token .token .token-worker { position: relative; min-width: 30px; color: transparent; }
.art-run-token .token .token-worker::before { content: ""; position: absolute; inset: 3px; background: var(--art-run-token) center / contain var(--art-run-token-repeat); image-rendering: var(--art-run-token-rendering); }
.art-run-token-mask .token .token-worker::before { background: var(--on-lamp); mask: var(--art-run-token) center / contain var(--art-run-token-repeat); }
.art-completed-badge .tile { position: relative; padding-right: 52px; }
.art-completed-badge .tile::after { content: ""; position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; background: var(--art-completed-badge) center / contain var(--art-completed-badge-repeat); image-rendering: var(--art-completed-badge-rendering); }
.art-completed-badge-mask .tile::after { background: var(--color-state-completed); mask: var(--art-completed-badge) center / contain var(--art-completed-badge-repeat); }
`;
