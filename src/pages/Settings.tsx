import React from 'react';
import { Button, Form } from 'react-bootstrap';
import {
  convertIntervalToTimeoutInterval,
  getDefaultIdleTimeoutSettings,
  getDefaultIntervalSettings,
} from '../common';
import { useAppContext } from '../components/AppProvider';
import { getAppDefaults } from '../config';

const defaultIntervals = getDefaultIntervalSettings();
const defaultIdleIntervals = getDefaultIdleTimeoutSettings();

// short always-visible explanation under a setting (tooltips are easy to miss)
const Help = (props: { children: React.ReactNode }) => (
  <Form.Text
    className="d-block text-body-secondary mt-1"
    style={{ fontSize: '.78em', lineHeight: 1.3 }}
  >
    {props.children}
  </Form.Text>
);

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
        <Form.Label size="sm" className="mb-1">
          Default interval
        </Form.Label>
        <Form.Select
          size="sm"
          value={convertIntervalToTimeoutInterval(
            appState.defaultSettings.defaultInterval
          )}
          onChange={handleChangeInterval}
          title="How often a tab reloads when you switch AutoReload on for it"
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
        <Help>
          How often a tab reloads when you switch AutoReload on for it (each
          tab can be changed on the main screen).
        </Help>
      </Form.Group>

      <Form.Group className="mb-3">
        <Form.Label size="sm" className="mb-1">
          Stop when I&apos;m away for (idle timeout)
        </Form.Label>
        <Form.Select
          size="sm"
          name="defaultIdleTimeout"
          value={convertIntervalToTimeoutInterval(
            appState.defaultSettings.defaultIdleTimeout
          )}
          onChange={handleChangeIdleTimeout}
          title="Switch AutoReload off on all tabs after this long without mouse or keyboard input"
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
        <Help>
          Not a reload interval: after this long with no mouse or keyboard
          input, AutoReload switches off on all tabs and stays off until you
          switch it on again.
        </Help>
      </Form.Group>
      <Form.Group className="mb-3">
        <Form.Check
          type="checkbox"
          id="default-enabled"
          label="Start reloading automatically (default enabled)"
          title="Switch AutoReload on for a tab as soon as you open this popup on it"
          onChange={handleDefaultChange}
          checked={appState.defaultSettings.defaultEnabled}
        />
        <Help>
          Opening this popup on a tab for the first time switches AutoReload on
          for it, with the default interval.
        </Help>
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
