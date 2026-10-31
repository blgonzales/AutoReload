import React, { useCallback, useEffect, useState } from 'react';
import { Button, Form } from 'react-bootstrap';
import { getLogger, isExtension } from '../common';
import { offlineModePermissions } from '../config';
import { OfflineState, originOf, isEligibleUrl } from '../util/OfflineMode';

const hint = { fontSize: '.78em', lineHeight: 1.3 };

const modes = [
  {
    value: 'off',
    label: 'Off',
    help: 'Pages load as usual and nothing is saved.',
  },
  {
    value: 'networkFirst',
    label: 'Network first (recommended)',
    help: 'Always asks the site. Shows the last saved copy if it is down or returns an error (502/503/504).',
  },
  {
    value: 'staleWhileRevalidate',
    label: 'Stale while revalidate',
    help: 'Shows the saved copy at once, then updates it in the background.',
  },
  {
    value: 'cacheFirst',
    label: 'Cache first',
    help: 'Uses the saved copy whenever there is one.',
  },
];

const OfflineModeSettings = () => {
  const [origin, setOrigin] = useState<string>();
  const [mode, setMode] = useState('off');
  const [message, setMessage] = useState('');
  const [privateTab, setPrivateTab] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);

  const send = useCallback(
    (data: Record<string, string>): Promise<any> =>
      browser.runtime.sendMessage(data),
    []
  );

  useEffect(() => {
    if (!isExtension()) {
      return;
    }
    browser.permissions
      .contains(offlineModePermissions)
      .then(setHasPermission)
      .catch((error) => getLogger().error('Permission check failed', error));
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!tab || !isEligibleUrl(tab.url)) {
          return;
        }
        const tabOrigin = originOf(tab.url);
        setPrivateTab(tab.incognito);
        setOrigin(tabOrigin);
        const state: OfflineState | undefined = await send({
          type: 'offline:get',
          origin: tabOrigin as string,
        });
        if (state) {
          setMode(state.mode);
        }
      })
      .catch((error) => getLogger().error('Offline mode lookup failed', error));
  }, [send]);

  if (!isExtension()) {
    return null;
  }

  // Firefox only accepts permission requests made directly from a click
  // handler (not from a <select> change), hence the separate button.
  const handleAllow = () => {
    browser.permissions
      .request(offlineModePermissions)
      .then((granted) => {
        setHasPermission(granted);
        setMessage(
          granted ? '' : 'Permission was declined, offline mode stays off.'
        );
      })
      .catch((error) => {
        getLogger().error('Permission request failed', error);
        setMessage('Could not ask for permission.');
      });
  };

  const handleModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.currentTarget.value;
    if (!origin) {
      return;
    }
    setMode(next);
    setMessage('');

    send({ type: 'offline:set', origin, mode: next })
      .then((state: OfflineState) => {
        setMode(state.mode);
        setMessage(state.status ? `Status: ${state.status}` : '');
      })
      .catch((error) => {
        getLogger().error('Offline mode change failed', error);
        setMode('off');
      });
  };

  const handleClear = () => {
    if (!origin) {
      return;
    }
    send({ type: 'offline:clear', origin })
      .then((result) =>
        setMessage(
          result && result.cleared
            ? 'Saved copies removed.'
            : 'Nothing to remove, or this site is not open in a tab.'
        )
      )
      .catch((error) => getLogger().error('Clearing copies failed', error));
  };

  return (
    <Form.Group className="mb-3 mt-3">
      <Form.Label size="sm" htmlFor="offline-mode">
        {origin ? `Offline mode for ${origin}` : 'Offline mode'}
      </Form.Label>
      <Form.Select
        size="sm"
        id="offline-mode"
        name="offlineMode"
        value={mode}
        disabled={!origin || privateTab || !hasPermission}
        onChange={handleModeChange}
      >
        {modes.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Form.Select>
      <Form.Text
        className="d-block text-body-secondary mt-1"
        style={hint}
        id="offline-mode-help"
      >
        {!origin
          ? 'Open an https:// or localhost page in this window to use this.'
          : modes.find((option) => option.value === mode)?.help}
      </Form.Text>
      <Form.Text
        className="d-block text-body-secondary mt-1"
        style={hint}
        id="offline-mode-limits"
      >
        Limits: https and localhost only, not in private windows. Copies
        (including logged-in pages) are stored in this site&apos;s own browser
        storage. While a saved copy is on screen, the toolbar button shows OLD.
      </Form.Text>
      {privateTab && (
        <Form.Text className="d-block text-danger" style={hint}>
          Private windows can&apos;t use offline mode.
        </Form.Text>
      )}
      {origin && !privateTab && !hasPermission && (
        <Button
          className="mt-2 me-2"
          variant="primary"
          size="sm"
          id="offline-allow"
          onClick={handleAllow}
        >
          Allow offline mode…
        </Button>
      )}
      {origin && !privateTab && !hasPermission && (
        <Form.Text className="d-block text-body-secondary mt-1" style={hint}>
          Needs access to all sites. Firefox asks once; nothing is sent
          anywhere.
        </Form.Text>
      )}
      <Button
        className="mt-2"
        variant="secondary"
        size="sm"
        disabled={!origin || mode === 'off'}
        onClick={handleClear}
      >
        Clear saved copies for this site
      </Button>
      {message && (
        <Form.Text className="d-block mt-1" style={hint} role="status">
          {message}
        </Form.Text>
      )}
    </Form.Group>
  );
};

export default OfflineModeSettings;
