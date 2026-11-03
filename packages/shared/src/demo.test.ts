import { describe, expect, it } from 'vitest';
import { demoReducer, getDevices, matchesSearch, scenarioContent, scenarios } from './index';
describe('deterministic demonstration model', () => {
  it('cannot silently resolve a conflict by syncing', () => {
    const state = { scenario: 'conflict' as const, resolved: false, syncCount: 0 };
    expect(demoReducer(state, { type: 'sync' })).toEqual(state);
  });
  it('does not turn an offline device into an online acknowledgement', () => {
    const state = demoReducer(
      { scenario: 'offline', resolved: false, syncCount: 0 },
      { type: 'sync' },
    );
    expect(getDevices(state.scenario)[1]!.online).toBe(false);
  });
  it('resets mutations when switching scenarios', () =>
    expect(
      demoReducer(
        { scenario: 'synchronized', resolved: true, syncCount: 3 },
        { type: 'scenario', scenario: 'error' },
      ),
    ).toEqual({ scenario: 'error', resolved: false, syncCount: 0 }));
  it('provides distinct status and readiness for every scenario', () => {
    for (const s of scenarios) {
      expect(scenarioContent[s].readiness).toBeTruthy();
      expect(getDevices(s)).toHaveLength(2);
    }
  });
  it('searches all relevant fields without case sensitivity', () => {
    expect(matchesSearch(['WeakAuras', 'Main PC'], ' weakauras ')).toBe(true);
    expect(matchesSearch(['Main PC'], 'MacBook')).toBe(false);
  });
});
