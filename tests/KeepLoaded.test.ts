import KeepLoaded, {
  DISCARDED_REASON,
  KEPT_LOADED_REASON,
  KeepLoadedDeps,
  KeepLoadedEvent,
} from '../src/util/KeepLoaded';

type FakeTab = { discarded: boolean; autoDiscardable: boolean };

const setup = (
  tabs: Record<number, FakeTab>,
  enabled = true,
  completes = true
) => {
  const calls: string[] = [];
  const events: [number, KeepLoadedEvent][] = [];
  let clock = 1000;
  const deps: KeepLoadedDeps = {
    isEnabled: async () => enabled,
    getTab: async (id) => {
      if (!tabs[id]) throw new Error('No tab with id ' + id);
      return { ...tabs[id] };
    },
    setAutoDiscardable: async (id, value) => {
      calls.push(`auto:${id}:${value}`);
      if (!tabs[id]) throw new Error('No tab with id ' + id);
      tabs[id].autoDiscardable = value;
    },
    reload: async (id) => {
      calls.push(`reload:${id}`);
      tabs[id].discarded = false;
    },
    waitForComplete: async (id) => {
      calls.push(`wait:${id}`);
      return completes;
    },
    now: () => clock++,
    onEvent: (id, event) => events.push([id, event]),
  };
  return { keep: new KeepLoaded(deps), calls, events, tabs };
};

const live = (): FakeTab => ({ discarded: false, autoDiscardable: true });

describe('KeepLoaded protection', () => {
  test('marks a tab not-discardable while it is reloaded and restores it afterwards', async () => {
    const { keep, tabs, events } = setup({ 1: live() });
    await keep.want(1, 'reload', true);
    expect(tabs[1].autoDiscardable).toBe(false);
    expect(keep.getDiscardStatus(1)).toEqual({
      state: 'kept-loaded',
      reason: KEPT_LOADED_REASON,
      since: 1000,
    });

    await keep.want(1, 'reload', false);
    expect(tabs[1].autoDiscardable).toBe(true);
    expect(keep.getDiscardStatus(1)).toBeNull();
    expect(events).toEqual([
      [1, 'kept-loaded'],
      [1, 'released'],
    ]);
  });

  test('leaves a tab alone that someone else already protected', async () => {
    const { keep, tabs, calls } = setup({
      1: { discarded: false, autoDiscardable: false },
    });
    await keep.want(1, 'reload', true);
    await keep.want(1, 'reload', false);
    expect(calls).toEqual([]);
    expect(tabs[1].autoDiscardable).toBe(false);
  });

  test('does nothing when the setting is off', async () => {
    const { keep, tabs, calls } = setup({ 1: live() }, false);
    await keep.want(1, 'reload', true);
    expect(calls).toEqual([]);
    expect(tabs[1].autoDiscardable).toBe(true);
    expect(keep.getDiscardStatus(1)).toBeNull();
  });

  test('stays protected until every reason is gone', async () => {
    const { keep, tabs } = setup({ 1: live() });
    await keep.want(1, 'reload', true);
    await keep.want(1, 'retry', true);
    await keep.want(1, 'reload', false);
    expect(tabs[1].autoDiscardable).toBe(false);
    await keep.want(1, 'retry', false);
    expect(tabs[1].autoDiscardable).toBe(true);
  });

  test('a quick off/on (timer restart) causes no flapping', async () => {
    const { keep, calls } = setup({ 1: live() });
    await keep.want(1, 'reload', true);
    calls.length = 0;
    keep.want(1, 'reload', false);
    await keep.want(1, 'reload', true);
    expect(calls).toEqual([]);
  });

  test('refresh applies a changed setting to running tabs', async () => {
    const tabs: Record<number, FakeTab> = { 1: live() };
    let enabled = false;
    const base = setup(tabs);
    const keep = new KeepLoaded({
      isEnabled: async () => enabled,
      getTab: async (id) => ({ ...tabs[id] }),
      setAutoDiscardable: async (id, v) => {
        tabs[id].autoDiscardable = v;
      },
      reload: async () => undefined,
      waitForComplete: async () => true,
    });
    await keep.want(1, 'reload', true);
    expect(tabs[1].autoDiscardable).toBe(true);
    enabled = true;
    await keep.refresh();
    expect(tabs[1].autoDiscardable).toBe(false);
    enabled = false;
    await keep.refresh();
    expect(tabs[1].autoDiscardable).toBe(true);
    expect(base.calls).toEqual([]);
  });

  test('releasing a closed tab does not throw', async () => {
    const { keep, tabs } = setup({ 1: live() });
    await keep.want(1, 'reload', true);
    delete tabs[1];
    await expect(keep.want(1, 'reload', false)).resolves.toBeUndefined();
  });
});

describe('KeepLoaded discarded tabs', () => {
  test('a live tab is reloaded once', async () => {
    const { keep, calls } = setup({ 1: live() });
    await keep.reload(1);
    expect(calls).toEqual(['reload:1']);
  });

  test('a discarded tab is loaded, then reloaded again so the server is asked', async () => {
    const { keep, calls, events } = setup({
      1: { discarded: true, autoDiscardable: true },
    });
    await keep.want(1, 'reload', true);
    calls.length = 0;
    await keep.reload(1);
    expect(calls).toEqual(['reload:1', 'wait:1', 'reload:1']);
    expect(events.map((e) => e[1])).toContain('reloaded-from-discarded');
  });

  test('with the setting off a discarded tab gets the single reload as before', async () => {
    const { keep, calls } = setup(
      { 1: { discarded: true, autoDiscardable: true } },
      false
    );
    await keep.reload(1);
    expect(calls).toEqual(['reload:1']);
  });

  test('reports who unloaded the tab, and clears it once loaded again', async () => {
    const { keep, events } = setup({ 1: live() });
    await keep.want(1, 'reload', true);
    keep.noteDiscarded(1, true);
    expect(keep.getDiscardStatus(1)).toMatchObject({
      state: 'discarded',
      reason: DISCARDED_REASON,
    });
    expect(events.map((e) => e[1])).toContain('discarded-by-other');
    keep.noteDiscarded(1, false);
    expect(keep.getDiscardStatus(1)).toMatchObject({ state: 'kept-loaded' });
  });

  test('ignores discard notices for tabs AutoReload does not manage', () => {
    const { keep } = setup({ 5: live() });
    keep.noteDiscarded(5, true);
    expect(keep.getDiscardStatus(5)).toBeNull();
  });

  test('a closed tab still gets its reload attempted so the error surfaces', async () => {
    const { keep, tabs } = setup({ 1: live() });
    delete tabs[1];
    await expect(keep.reload(1)).rejects.toThrow();
  });

  test('forget drops everything known about a tab', async () => {
    const { keep } = setup({ 1: live() });
    await keep.want(1, 'reload', true);
    keep.forget(1);
    expect(keep.getDiscardStatus(1)).toBeNull();
  });
});
