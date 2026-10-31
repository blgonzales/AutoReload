export type DiscardStatus = {
  // kept-loaded: AutoReload marked the tab "do not unload"
  // discarded: the tab was unloaded by Firefox or another add-on
  state: 'kept-loaded' | 'discarded';
  reason: string;
  // epoch milliseconds when this state was first noticed
  since: number;
};

export type KeepLoadedEvent =
  'kept-loaded' | 'released' | 'discarded-by-other' | 'reloaded-from-discarded';

export type KeepLoadedDeps = {
  // the "keep tabs loaded" setting; read every time it matters
  isEnabled: () => Promise<boolean>;
  getTab: (
    tabId: number
  ) => Promise<{ discarded?: boolean; autoDiscardable?: boolean }>;
  setAutoDiscardable: (tabId: number, value: boolean) => Promise<unknown>;
  reload: (tabId: number) => Promise<unknown>;
  // resolves true when the tab reports 'complete', false on timeout
  waitForComplete: (tabId: number, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  // optional hook, e.g. for an activity log
  onEvent?: (tabId: number, event: KeepLoadedEvent) => void;
};

export const KEPT_LOADED_REASON =
  'AutoReload keeps this tab loaded, so Firefox and add-ons such as Auto Tab Discard leave it alone';
export const DISCARDED_REASON =
  'Unloaded by Firefox or another add-on; AutoReload loads it again on the next reload';

const LOAD_TIMEOUT_MS = 15000;

/**
 * Keeps tabs that AutoReload is reloading from being unloaded ("discarded")
 * by Firefox or by other add-ons, and makes the reload of a tab that was
 * unloaded anyway fetch the page from the network.
 *
 * Why: tabs.reload() on a discarded tab only restores the page from session
 * history/cache. Nothing is requested from the server, so the tick is lost.
 *
 * The tab's autoDiscardable flag is the standard switch for this; Firefox's
 * own unloader and Auto Tab Discard both skip tabs where it is false. A tab
 * that was already marked not-discardable by someone else is left alone and
 * not restored afterwards.
 */
export default class KeepLoaded {
  private deps: KeepLoadedDeps;
  private reasons = new Map<number, Set<string>>();
  // tabs whose flag we flipped to false (and must flip back)
  private held = new Set<number>();
  private statuses = new Map<number, DiscardStatus>();
  private queue = new Map<number, Promise<void>>();

  constructor(deps: KeepLoadedDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Says whether a tab is kept loaded, found unloaded, or neither. */
  getDiscardStatus(tabId: number): DiscardStatus | null {
    return this.statuses.get(tabId) ?? null;
  }

  /** `reason` names who needs the tab loaded, e.g. 'reload' or 'retry'. */
  want(tabId: number, reason: string, wanted: boolean) {
    const set = this.reasons.get(tabId) ?? new Set<string>();
    if (wanted) {
      set.add(reason);
    } else {
      set.delete(reason);
    }
    if (set.size) {
      this.reasons.set(tabId, set);
    } else {
      this.reasons.delete(tabId);
    }
    return this.enqueue(tabId);
  }

  /** Re-applies the setting to every tab, e.g. after it was changed. */
  refresh() {
    const ids = new Set([...this.reasons.keys(), ...this.held]);
    return Promise.all([...ids].map((id) => this.enqueue(id)));
  }

  /** The tab is gone: drop what is known about it. */
  forget(tabId: number) {
    this.reasons.delete(tabId);
    this.held.delete(tabId);
    this.statuses.delete(tabId);
  }

  // call when tabs.onUpdated reports a change of the discarded flag
  noteDiscarded(tabId: number, discarded: boolean) {
    if (!this.reasons.has(tabId)) {
      return;
    }
    if (discarded) {
      this.statuses.set(tabId, {
        state: 'discarded',
        reason: DISCARDED_REASON,
        since: this.now(),
      });
      this.deps.onEvent?.(tabId, 'discarded-by-other');
    } else if (this.statuses.get(tabId)?.state === 'discarded') {
      this.statuses.delete(tabId);
      if (this.held.has(tabId)) {
        this.setKept(tabId);
      }
    }
  }

  /**
   * The scheduled reload. With the setting on, a tab found unloaded is loaded
   * first and then reloaded once more so the server is really asked.
   */
  async reload(tabId: number) {
    let discarded = false;
    try {
      discarded = !!(await this.deps.getTab(tabId)).discarded;
    } catch (error) {
      // fall through: tabs.reload reports the error for a closed tab
    }

    if (!discarded || !(await this.deps.isEnabled())) {
      await this.deps.reload(tabId);
      return;
    }

    this.noteDiscarded(tabId, true);
    await this.deps.reload(tabId);
    await this.deps.waitForComplete(tabId, LOAD_TIMEOUT_MS);
    this.deps.onEvent?.(tabId, 'reloaded-from-discarded');
    await this.deps.reload(tabId);
  }

  private setKept(tabId: number) {
    this.statuses.set(tabId, {
      state: 'kept-loaded',
      reason: KEPT_LOADED_REASON,
      since: this.now(),
    });
  }

  private enqueue(tabId: number) {
    const next = (this.queue.get(tabId) ?? Promise.resolve())
      .then(() => this.apply(tabId))
      .catch(() => undefined);
    this.queue.set(tabId, next);
    return next;
  }

  // brings the tab's flag in line with what is wanted right now
  private async apply(tabId: number) {
    const wanted = this.reasons.has(tabId) && (await this.deps.isEnabled());
    const held = this.held.has(tabId);

    if (wanted && !held) {
      const tab = await this.deps.getTab(tabId);
      if (tab.autoDiscardable === false) {
        return; // someone else already protects it; not ours to undo
      }
      await this.deps.setAutoDiscardable(tabId, false);
      this.held.add(tabId);
      if (!this.statuses.has(tabId)) {
        this.setKept(tabId);
      }
      this.deps.onEvent?.(tabId, 'kept-loaded');
    } else if (!wanted && held) {
      this.held.delete(tabId);
      this.statuses.delete(tabId);
      try {
        await this.deps.setAutoDiscardable(tabId, true);
        this.deps.onEvent?.(tabId, 'released');
      } catch (error) {
        // the tab was closed in the meantime
      }
    }
  }
}
