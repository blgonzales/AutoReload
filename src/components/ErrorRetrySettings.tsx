import React, { useEffect, useState } from 'react';
import { Form } from 'react-bootstrap';
import {
  Interval,
  convertIntervalToTimeoutInterval,
  getLogger,
  getRetryDelaySettings,
  isExtension,
} from '../common';
import { useAppContext } from './AppProvider';
import {
  retryMaxAttemptsChoices,
  retryOnErrorPermissions,
  retryStatusCodePresets,
} from '../config';
import { parseStatusCodes } from '../util/ErrorRetry';

const retryDelays = getRetryDelaySettings();
// 0 = "No limit": the backoff keeps doubling (stops growing at one day)
const noLimit = { hours: 0, minutes: 0, seconds: 0, millis: 0, value: 0 };
const retryMaxDelays = [noLimit, ...retryDelays];
const hint = { fontSize: '.78em', lineHeight: 1.3 };
const presetCodes = retryStatusCodePresets.map((preset) => preset.code);

const formatDelay = (interval: Interval) =>
  [
    interval.hours ? `${interval.hours}h` : '',
    interval.minutes ? `${interval.minutes}min` : '',
    interval.seconds ? `${interval.seconds}sec` : '',
  ]
    .filter(Boolean)
    .join(' ');

const customCodesText = (codes: number[]) =>
  codes.filter((code) => !presetCodes.includes(code)).join(', ');

const ErrorRetrySettings = () => {
  const { appState, setAppState } = useAppContext();
  const settings = appState.defaultSettings;
  const [hasPermission, setHasPermission] = useState(!isExtension());
  const [customText, setCustomText] = useState(
    customCodesText(settings.retryStatusCodes)
  );
  const [invalidCodes, setInvalidCodes] = useState<string[]>([]);

  useEffect(() => {
    if (!isExtension()) {
      return;
    }
    browser.permissions
      .contains(retryOnErrorPermissions)
      .then(setHasPermission)
      .catch((error) => getLogger().error('Permission check failed', error));
  }, []);

  // settings arrive asynchronously from the background page
  useEffect(() => {
    setCustomText(customCodesText(settings.retryStatusCodes));
  }, [settings.retryStatusCodes]);

  const update = (changes: Partial<typeof settings>) => {
    setAppState({
      ...appState,
      defaultSettings: { ...settings, ...changes },
    });
  };

  const handleEnabledChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    const enabled = event.currentTarget.checked;

    if (!enabled || !isExtension()) {
      update({ retryOnError: enabled });
      return;
    }

    // must be requested synchronously from the user's click
    const permissionRequest = browser.permissions.request(
      retryOnErrorPermissions
    );
    update({ retryOnError: true });

    permissionRequest
      .then((granted) => {
        setHasPermission(granted);
        if (!granted) {
          update({ retryOnError: false });
        }
      })
      .catch((error) => {
        getLogger().error('Permission request failed', error);
        update({ retryOnError: false });
      });
  };

  const handlePresetChange = (code: number, checked: boolean) => {
    const codes = new Set(settings.retryStatusCodes);
    if (checked) {
      codes.add(code);
    } else {
      codes.delete(code);
    }
    update({ retryStatusCodes: Array.from(codes).sort((a, b) => a - b) });
  };

  const applyCustomCodes = () => {
    const { codes, invalid } = parseStatusCodes(customText);
    setInvalidCodes(invalid);

    const selectedPresets = settings.retryStatusCodes.filter((code) =>
      presetCodes.includes(code)
    );
    const merged = Array.from(new Set([...selectedPresets, ...codes])).sort(
      (a, b) => a - b
    );
    update({ retryStatusCodes: merged });
    setCustomText(customCodesText(merged));
  };

  const handleIntervalSelect =
    (key: 'retryDelay' | 'retryMaxDelay') =>
    (event: React.ChangeEvent<HTMLSelectElement>): void => {
      const value = Number(event.currentTarget.value);
      const choices = key === 'retryMaxDelay' ? retryMaxDelays : retryDelays;
      const interval = choices.find((delay) => delay.value === value);
      if (interval) {
        update({ [key]: interval });
      }
    };

  const active = settings.retryOnError && hasPermission;

  return (
    <Form.Group className="mb-3">
      <Form.Check
        type="checkbox"
        id="retry-on-error"
        label="Retry pages that fail with an HTTP error"
        title="Reload a tab after a delay when its page comes back with one of the selected HTTP status codes. Needs permission to read response status codes."
        onChange={handleEnabledChange}
        checked={active}
      />
      <Form.Text className="d-block text-body-secondary mt-1" style={hint}>
        When a page fails with one of the ticked HTTP status codes, AutoReload
        loads it again after the delay below. Hover a code for its name, e.g.
        504 = the site&apos;s server timed out. Normal page loads only, never
        form submissions. Firefox asks once for permission to read status codes.
      </Form.Text>
      <div className="mt-1" style={{ fontSize: '.85em' }}>
        {retryStatusCodePresets.map((preset) => (
          <Form.Check
            inline
            key={preset.code}
            type="checkbox"
            id={`retry-code-${preset.code}`}
            label={preset.code}
            title={preset.label}
            disabled={!active}
            checked={settings.retryStatusCodes.includes(preset.code)}
            onChange={(event) =>
              handlePresetChange(preset.code, event.currentTarget.checked)
            }
          />
        ))}
      </div>
      <Form.Control
        size="sm"
        type="text"
        name="retryCustomCodes"
        aria-label="Other status codes to retry"
        placeholder="Other codes, e.g. 418, 525-527"
        disabled={!active}
        value={customText}
        onChange={(event) => setCustomText(event.currentTarget.value)}
        onBlur={applyCustomCodes}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            applyCustomCodes();
          }
        }}
      />
      {invalidCodes.length > 0 && (
        <Form.Text className="text-danger">
          {`Ignored (use 400-599): ${invalidCodes.join(', ')}`}
        </Form.Text>
      )}
      <Form.Select
        size="sm"
        name="retryDelay"
        aria-label="Retry delay"
        className="mt-1"
        disabled={!active}
        value={convertIntervalToTimeoutInterval(settings.retryDelay)}
        onChange={handleIntervalSelect('retryDelay')}
      >
        {retryDelays.map((delay) => (
          <option key={delay.value} value={delay.value}>
            {`Retry after ${formatDelay(delay)}`}
          </option>
        ))}
      </Form.Select>
      <Form.Check
        type="checkbox"
        id="retry-backoff"
        className="mt-1"
        label="Back off: double the delay after each failed retry"
        title="1st retry after the delay above, then 2x, 4x, ... up to the limit. A Retry-After header from the server is honoured when it asks for longer."
        disabled={!active}
        checked={settings.retryBackoff}
        onChange={(event) =>
          update({ retryBackoff: event.currentTarget.checked })
        }
      />
      <Form.Text className="d-block text-body-secondary" style={hint}>
        Waits 1x, 2x, 4x... the delay between attempts, up to the limit below,
        so a site that stays down isn&apos;t hammered. A longer wait asked for
        by the site (Retry-After) is respected.
      </Form.Text>
      <Form.Select
        size="sm"
        name="retryMaxDelay"
        aria-label="Longest retry delay"
        disabled={!active || !settings.retryBackoff}
        value={convertIntervalToTimeoutInterval(settings.retryMaxDelay)}
        onChange={handleIntervalSelect('retryMaxDelay')}
      >
        {retryMaxDelays.map((delay) => (
          <option key={delay.value} value={delay.value}>
            {delay.value === 0
              ? 'Back off with no limit (max 24h)'
              : `Back off up to ${formatDelay(delay)}`}
          </option>
        ))}
      </Form.Select>
      <Form.Select
        size="sm"
        name="retryMaxAttempts"
        aria-label="Stop retrying after"
        className="mt-1"
        disabled={!active}
        value={settings.retryMaxAttempts ?? 0}
        onChange={(event) =>
          update({ retryMaxAttempts: Number(event.currentTarget.value) })
        }
      >
        {retryMaxAttemptsChoices.map((attempts) => (
          <option key={attempts} value={attempts}>
            {attempts === 0
              ? 'Keep retrying (unlimited)'
              : `Stop retrying after ${attempts} attempts`}
          </option>
        ))}
      </Form.Select>
    </Form.Group>
  );
};

export default ErrorRetrySettings;
