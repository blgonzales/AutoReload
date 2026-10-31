import React, { useEffect, useRef, useState } from 'react';
import ToggleSwitch from '../components/ToggleSwitch';
import {
  Interval,
  convertIntervalToTimeoutInterval,
  getLogger,
} from '../common';
import IntervalNumberInput from '../components/IntervalNumberInput';
import { useTabContext } from '../components/TabProvider';
import { IntervalInputContext } from '../components/IntervalInputProvider';
import { useAppContext } from '../components/AppProvider';
import { Button, Col, Form, Row } from 'react-bootstrap';

const Main = () => {
  const { tabData: reloadData, setTabData } = useTabContext();
  const { appState, setAppState } = useAppContext();
  const [unSavedInterval, setUnSavedInterval] = useState<Interval>(
    {} as Interval
  );

  const hasUnsavedIntervals =
    unSavedInterval.hours !== undefined &&
    unSavedInterval.minutes !== undefined &&
    unSavedInterval.seconds !== undefined &&
    unSavedInterval.millis !== undefined;

  const handleGlobalEnabled = (event: React.ChangeEvent<HTMLInputElement>) => {
    setAppState({
      ...appState,
      enabled: event.target.checked,
    });

    setTabData({
      ...reloadData,
      enabled: event.target.checked,
    });
  };

  // submitting the form (Enter in an interval input or the Update button)
  const saveHandler = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    getLogger().verbose(`saveHandler`, unSavedInterval);

    if (convertIntervalToTimeoutInterval(unSavedInterval) < 5000) {
      alert(
        'You are insane attempting to auto reload less than 5 seconds. Not allowed.'
      );

      setUnSavedInterval({} as Interval);
      return;
    }

    setTabData({
      ...reloadData,
      interval: unSavedInterval,
    });

    setUnSavedInterval({} as Interval);
  };

  const resetHandler = () => {
    getLogger().verbose('resetHandler', appState.defaultSettings);

    setTabData({
      ...reloadData,
      interval: appState.defaultSettings.defaultInterval,
    });
  };

  return (
    <IntervalInputContext.Provider
      value={{
        reloadData: reloadData,
        unSavedIntervals: unSavedInterval,
        setUnSavedIntervals: setUnSavedInterval,
      }}
    >
      <Form noValidate onSubmit={saveHandler}>
        <div className="input-title">Set Interval</div>
        <div className="input-wrapper">
          <IntervalNumberInput name="hours" label="Hours" />
          <div className="time-separator">:</div>
          <IntervalNumberInput name="minutes" label="Minutes" />
          <div className="time-separator">:</div>
          <IntervalNumberInput name="seconds" label="Seconds" />
        </div>
        <Row>
          <Col className="d-flex align-items-center">
            <ToggleSwitch
              enabled={appState.enabled}
              onChange={handleGlobalEnabled}
              title={`${appState.enabled ? 'Disable' : 'Enable'} AutoReload for ${
                appState.numberOfTabs
              } Registered Tab${appState.numberOfTabs > 1 ? 's' : ''}`}
            />
          </Col>

          <Col className="d-flex ms-auto justify-content-end">
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={!hasUnsavedIntervals || !reloadData.enabled}
              style={{ marginRight: '.5em' }}
            >
              Update
            </Button>

            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={resetHandler}
              disabled={
                !reloadData.enabled ||
                (!reloadData.enabled && !hasUnsavedIntervals)
              }
            >
              Reset
            </Button>
          </Col>
        </Row>
      </Form>
    </IntervalInputContext.Provider>
  );
};

export default Main;
