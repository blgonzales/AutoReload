import React from 'react';
import { useIntervalInputContext } from './IntervalInputProvider';
import { Interval, getLogger } from '../common';
import { defaultInterval } from '../config';
import { Form } from 'react-bootstrap';

type IntervalNumberInputType = {
  name: string;
  label: string;
};

const IntervalNumberInput = (props: IntervalNumberInputType) => {
  const { reloadData, unSavedIntervals, setUnSavedIntervals } =
    useIntervalInputContext();

  // handle updating inputs so they are ready to be saved
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (props.name in defaultInterval === undefined) {
      getLogger().error(
        `Invalid interval name ${props.name} while changing interval input`
      );
      return;
    }

    setUnSavedIntervals((unSavedInterval) => ({
      ...reloadData.interval,
      ...unSavedInterval,
      [props.name]: Number(event.target.value),
    }));
  };

  // consider unsaved values otherwise use current data
  const currentValue =
    unSavedIntervals[props.name as keyof Interval] !== undefined
      ? unSavedIntervals[props.name as keyof Interval]
      : reloadData.interval[props.name as keyof Interval];

  return (
    <div className="input-div">
      <Form.Control
        type="number"
        size="sm"
        name={props.name}
        value={currentValue}
        onChange={handleChange}
        disabled={!reloadData.enabled}
        min={0}
        max={60}
      />
      <div className="input-desc">{props.label}</div>
    </div>
  );
};

export default IntervalNumberInput;
