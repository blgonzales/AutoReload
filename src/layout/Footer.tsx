import React from 'react';
import { isExtension } from '../common';

// opens (or focuses) the activity log page in a tab
const openActivityLog = async (event: React.MouseEvent) => {
  event.preventDefault();
  if (!isExtension()) {
    return;
  }
  const url = browser.runtime.getURL('activity.html');
  const [existing] = await browser.tabs.query({ url });
  if (existing && existing.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await browser.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await browser.tabs.create({ url });
  }
  window.close();
};

const Footer = () => {
  return (
    <div
      className="d-flex justify-content-between align-items-baseline"
      style={{
        fontSize: '8px',
        margin: '4px 0',
        marginTop: 'auto',
      }}
    >
      <span>&copy; AutoReload</span>
      <a
        href="activity.html"
        onClick={openActivityLog}
        title="See what AutoReload has done: reloads, timers and settings changes (kept in memory only)"
        style={{ fontSize: '11px' }}
      >
        Activity log
      </a>
    </div>
  );
};

export default Footer;
