import React from 'react';
import { Button, Form } from 'react-bootstrap';
import {
  convertIntervalToTimeoutInterval,
  getDefaultIdleTimeoutSettings,
  getDefaultIntervalSettings,
} from '../common';
import { useAppContext } from '../components/AppProvider';
import { getAppDefaults } from '../config';
import { forgetRememberedPages } from '../client';

const defaultIntervals = getDefaultIntervalSettings();
const defaultIdleIntervals = getDefaultIdleTimeoutSettings();

const Settings = () => {
  const { appState, setAppState } = useAppContext();

  const handleChangeInterval = (
    event: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    const value = Number(event.currentTarget.value);
    const interval = defaultIntervals.find(
      (interval) => interval.value === value
    );
    if (!interval) {
      return;
    }

    setAppState({
      ...appState,
      defaultSettings: {
        ...appState.defaultSettings,
        defaultInterval: interval,
      },
    });
  };

  const handleChangeIdleTimeout = (
    event: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    const value = Number(event.currentTarget.value);
    const interval = defaultIdleIntervals.find(
      (interval) => interval.value === value
    );
    if (!interval) {
      return;
    }

    setAppState({
      ...appState,
      defaultSettings: {
        ...appState.defaultSettings,
        defaultIdleTimeout: interval,
      },
    });
  };

  const handleDefaultChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    setAppState({
      ...appState,
      defaultSettings: {
        ...appState.defaultSettings,
        defaultEnabled: event.currentTarget.checked,
      },
    });
  };

  const handleRememberPagesChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ): void => {
    setAppState({
      ...appState,
      defaultSettings: {
        ...appState.defaultSettings,
        rememberPages: event.currentTarget.checked,
      },
    });
  };

  const handleResetToDefault = () => {
    setAppState({
      ...appState,
      defaultSettings: getAppDefaults(),
    });
  };

  return (
    <Form>
      <div style={{ marginBottom: '.5em' }}>Settings</div>
      <Form.Group className="mb-3">
        <Form.Label size="sm">Default Interval</Form.Label>
        <Form.Select
          size="sm"
          value={convertIntervalToTimeoutInterval(
            appState.defaultSettings.defaultInterval
          )}
          onChange={handleChangeInterval}
        >
          {defaultIntervals.map((interval) => {
            return (
              <option
                key={interval.value}
                value={interval.value}
              >{`${interval.hours}hrs, ${interval.minutes}min, ${interval.seconds}sec`}</option>
            );
          })}
        </Form.Select>
      </Form.Group>

      <Form.Group className="mb-3">
        <Form.Label size="sm">Default Idle Timeout</Form.Label>
        <Form.Select
          size="sm"
          name="defaultIdleTimeout"
          value={convertIntervalToTimeoutInterval(
            appState.defaultSettings.defaultIdleTimeout
          )}
          onChange={handleChangeIdleTimeout}
        >
          {defaultIdleIntervals.map((interval) => {
            return (
              <option
                key={interval.value}
                value={interval.value}
              >{`${interval.hours}hrs, ${interval.minutes}min`}</option>
            );
          })}
        </Form.Select>
      </Form.Group>
      <Form.Group className="mb-3">
        <Form.Check
          type="checkbox"
          id="default-enabled"
          label="Default enabled"
          title="Start AutoReload by default when opening"
          onChange={handleDefaultChange}
          checked={appState.defaultSettings.defaultEnabled}
        />
      </Form.Group>
      <Form.Group className="mb-3">
        <Form.Check
          type="checkbox"
          id="remember-pages"
          label="Remember reload settings per page"
          title="Resume reloading with the saved interval when a page you enabled AutoReload on is loaded again. Saved locally, by exact page URL (not the whole site)."
          onChange={handleRememberPagesChange}
          checked={appState.defaultSettings.rememberPages}
        />
        <div className="d-flex align-items-center mt-1">
          <small id="remembered-count" className="me-2">
            {appState.rememberedPageCount ?? 0} remembered page(s)
          </small>
          <Button
            id="forget-remembered"
            variant="secondary"
            size="sm"
            disabled={!appState.rememberedPageCount}
            onClick={forgetRememberedPages}
          >
            Forget all
          </Button>
        </div>
      </Form.Group>
      <Form.Group className="d-flex ms-auto justify-content-end">
        <Button variant="secondary" size="sm" onClick={handleResetToDefault}>
          Reset to Default
        </Button>
      </Form.Group>
    </Form>
  );
};

export default Settings;
