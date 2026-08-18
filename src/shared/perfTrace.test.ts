import { describe, expect, it } from 'vitest';

import { formatPerfLine } from './perfTrace';

describe('formatPerfLine — unified-log perf line', () => {
    it('emits trace + phase only when nothing else is set', () => {
        expect(formatPerfLine({ trace: 'renderer', phase: 'first_paint' }))
            .toBe('[perf] trace=renderer phase=first_paint');
    });

    it('includes scalar fields in a stable fixed order', () => {
        expect(formatPerfLine({
            trace: 'renderer',
            phase: 'tab_data_ready',
            durationMs: 42,
            tabId: 'tab-1',
            status: 'ok',
        })).toBe('[perf] trace=renderer phase=tab_data_ready durationMs=42 status=ok tabId=tab-1');
    });

    it('omits undefined/null fields', () => {
        expect(formatPerfLine({ trace: 'renderer', phase: 'x', durationMs: undefined, tabId: undefined }))
            .toBe('[perf] trace=renderer phase=x');
    });

    it('keeps durationMs=0 (not dropped as falsy)', () => {
        expect(formatPerfLine({ trace: 'renderer', phase: 'x', durationMs: 0, count: 0 }))
            .toBe('[perf] trace=renderer phase=x durationMs=0 count=0');
    });

    it('appends detail keys sorted, skipping null/undefined values', () => {
        expect(formatPerfLine({
            trace: 'renderer',
            phase: 'new_tab_reveal',
            detail: { zeta: 1, alpha: 'hit', skip: undefined, gone: null },
        })).toBe('[perf] trace=renderer phase=new_tab_reveal alpha=hit zeta=1');
    });
});
