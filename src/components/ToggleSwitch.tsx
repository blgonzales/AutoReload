import React from 'react';
import { Form } from 'react-bootstrap';

type ToggleSwitchProps = {
  enabled?: boolean;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  title?: string;
};

function ToggleSwitch(props: ToggleSwitchProps) {
  const { enabled, title } = props;

  return (
    <div title={title}>
      <Form.Check type="switch" onChange={props.onChange} checked={enabled} />
    </div>
  );
}

ToggleSwitch.defaultProps = {
  enabled: false,
  checked: undefined,
};

export default ToggleSwitch;
