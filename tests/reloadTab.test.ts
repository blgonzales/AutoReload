import { reloadTab } from '../src/util/reloadTab';

describe('reloadTab', () => {
  test('passes no options when bypass cache is off', async () => {
    const reload = jest.fn().mockResolvedValue(undefined);
    await reloadTab(7, { getBypassCache: async () => false, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(7);
    expect(reload.mock.calls[0]).toHaveLength(1);
  });

  test('passes bypassCache: true when bypass cache is on', async () => {
    const reload = jest.fn().mockResolvedValue(undefined);
    await reloadTab(7, { getBypassCache: async () => true, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(7, { bypassCache: true });
  });

  test('reads the setting on every reload', async () => {
    const reload = jest.fn().mockResolvedValue(undefined);
    const getBypassCache = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await reloadTab(3, { getBypassCache, reload });
    await reloadTab(3, { getBypassCache, reload });
    expect(getBypassCache).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenNthCalledWith(1, 3);
    expect(reload).toHaveBeenNthCalledWith(2, 3, { bypassCache: true });
  });
});
