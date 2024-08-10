import React from 'react';
import Logo from '../images/icon.svg';
import SettingsIcon from './SettingsIcon';
import ToggleSwitch from '../components/ToggleSwitch';
import { useTabContext } from '../components/TabProvider';
import { Navbar } from 'react-bootstrap';
import { useAppContext } from '../components/AppProvider';

const Header = () => {
  const { tabData, setTabData } = useTabContext();
  const { settingsMode, setSettingsMode } = useAppContext();

  const handleIsEnabled = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTabData({
      ...tabData,
      enabled: event.target.checked,
    });
  };

  const handleSettingsToggle = () => {
    setSettingsMode(!settingsMode);
  };

  return (
    <>
      <Navbar
        style={{
          paddingTop: 0,
          paddingBottom: '.25em',
          borderBottom: '1px solid rgb(197 199 201 / 71%)',
        }}
      >
        <Navbar.Brand
          className="d-flex align-items-center"
          style={{ fontSize: '1.5em' }}
        >
          <img src={Logo} width="30" height="30" />
          <span
            style={{
              paddingLeft: '.25em',
              paddingBottom: '2px',
              lineHeight: '.8em',
            }}
          >
            AutoReload
          </span>
        </Navbar.Brand>
        <div
          className="d-flex ms-auto align-items-center"
          style={{ fontSize: '1.25em' }}
        >
          <ToggleSwitch
            enabled={tabData.enabled}
            onChange={handleIsEnabled}
            title={`${tabData.enabled ? 'Disable' : 'Enable'} AutoReload for the Current Tab`}
          />
          <div
            title="Toggle Settings"
            onClick={handleSettingsToggle}
            style={{ cursor: 'pointer' }}
          >
            <SettingsIcon />
          </div>
        </div>
      </Navbar>
    </>
  );
};

export default Header;
