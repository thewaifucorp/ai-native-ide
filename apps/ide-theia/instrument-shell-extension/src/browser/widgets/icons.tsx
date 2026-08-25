// Inline icon set ported verbatim from sketch 001. The symbol <defs> are mounted
// once (via <IconDefs/> rendered in the rail widget); every icon elsewhere is a
// tiny <svg class="i"><use href="#ic-…"/></svg> exactly like the sketch.

import * as React from 'react';

export type IconName =
    | 'overview' | 'build' | 'resources' | 'evidence' | 'ship'
    | 'session' | 'history' | 'gear' | 'plus' | 'refresh'
    | 'more' | 'check' | 'dot' | 'circle' | 'warn';

export const Icon: React.FC<{ name: IconName; style?: React.CSSProperties }> = ({ name, style }) => (
    <svg className="i" style={style}><use href={`#ic-${name}`} /></svg>
);

export const IconDefs: React.FC = () => (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
            <symbol id="ic-overview" viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></symbol>
            <symbol id="ic-build" viewBox="0 0 16 16"><path d="M8 1.5 9.5 6.5 14.5 8 9.5 9.5 8 14.5 6.5 9.5 1.5 8 6.5 6.5Z" /></symbol>
            <symbol id="ic-resources" viewBox="0 0 16 16"><path d="M2 5.5 8 2.5l6 3v5l-6 3-6-3Z" /><path d="M2 5.5 8 8.5l6-3M8 8.5v6" /></symbol>
            <symbol id="ic-evidence" viewBox="0 0 16 16"><path d="M8 1.8 13.5 4v4c0 3.2-2.3 5.4-5.5 6.2C4.8 13.4 2.5 11.2 2.5 8V4Z" /><path d="M5.8 8l1.6 1.6L10.6 6.4" /></symbol>
            <symbol id="ic-ship" viewBox="0 0 16 16"><path d="M4 12 12 4M6 4h6v6" /></symbol>
            <symbol id="ic-session" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></symbol>
            <symbol id="ic-history" viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 8V4.8M2.5 8h3.2" /></symbol>
            <symbol id="ic-gear" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" /></symbol>
            <symbol id="ic-plus" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" /></symbol>
            <symbol id="ic-refresh" viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 3.5v2.7h-2.7" /></symbol>
            <symbol id="ic-more" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r=".9" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" stroke="none" /></symbol>
            <symbol id="ic-check" viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></symbol>
            <symbol id="ic-dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" /></symbol>
            <symbol id="ic-circle" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" /></symbol>
            <symbol id="ic-warn" viewBox="0 0 16 16"><path d="M8 2.2 14.4 13.4H1.6Z" /><path d="M8 6.4v3.1M8 11.4v.1" /></symbol>
        </defs>
    </svg>
);
