export type ReloadTabDeps = {
  getBypassCache: () => Promise<boolean>;
  reload: (
    tabId: number,
    reloadProperties?: { bypassCache?: boolean }
  ) => Promise<void>;
};

/**
 * Reloads a tab. The bypass-cache setting is read at call time, so changes
 * apply to the next reload. With the setting off, the call is identical to a
 * plain `tabs.reload(tabId)`.
 */
export const reloadTab = async (tabId: number, deps: ReloadTabDeps) => {
  if (await deps.getBypassCache()) {
    await deps.reload(tabId, { bypassCache: true });
  } else {
    await deps.reload(tabId);
  }
};
