import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactDOM from 'react-dom/client';
import { Badge, Button, Container, Form, Table } from 'react-bootstrap';
import {
  ActivityEntry,
  ActivitySnapshot,
  describeIdle,
  entryTabLabel,
  formatInterval,
  formatMs,
  formatSnapshotText,
  formatTime,
  kindLabel,
} from './util/ActivityLog';
import { ACTIVITY_PORT_NAME } from './util/ActivityPort';

import 'bootstrap/dist/css/bootstrap.min.css';

const KIND_VARIANT: Record<string, string> = {
  reload: 'primary',
  'timer-started': 'success',
  'timer-stopped': 'secondary',
  global: 'info',
  idle: 'warning',
  settings: 'info',
  error: 'danger',
  startup: 'light',
};

const useDarkTheme = () => {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.setAttribute(
        'data-bs-theme',
        mq.matches ? 'dark' : 'light'
      );
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
};

// Receives live snapshots from the background page; reconnects if it drops.
const useSnapshot = () => {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const portRef = useRef<browser.runtime.Port | null>(null);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const port = browser.runtime.connect({ name: ACTIVITY_PORT_NAME });
      portRef.current = port;
      setConnected(true);
      port.onMessage.addListener((m) => setSnapshot(m as ActivitySnapshot));
      port.onDisconnect.addListener(() => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 1000);
      });
    };
    connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      portRef.current?.disconnect();
    };
  }, []);

  const clear = useCallback(
    () => portRef.current?.postMessage({ type: 'clear' }),
    []
  );
  return { snapshot, connected, clear };
};

const tabKey = (e: ActivityEntry) =>
  e.tabId === undefined ? 'none' : String(e.tabId);

const Summary = ({
  snap,
  fullUrls,
}: {
  snap: ActivitySnapshot;
  fullUrls: boolean;
}) => {
  const s = snap.summary;
  const now = Date.now();
  return (
    <div className="mb-4" id="summary">
      <h2 className="h5">Currently running</h2>
      <ul className="list-unstyled mb-2">
        <li id="summary-global">
          <strong>Tabs reloading:</strong> {s.enabledTabs} of {s.trackedTabs}{' '}
          tracked
          {s.trackedTabs > 0 &&
            (s.globalEnabled
              ? ' (all-tabs switch on)'
              : ' (all-tabs switch off)')}
        </li>
        <li id="summary-idle">
          <strong>Browser:</strong> {describeIdle(s.idle, now)}
        </li>
        <li>
          <strong>Defaults:</strong> interval{' '}
          {formatInterval(s.defaultInterval)}, idle timeout{' '}
          {formatInterval(s.defaultIdleTimeout)}, enabled by default:{' '}
          {s.defaultEnabled ? 'yes' : 'no'}
        </li>
      </ul>
      {s.tabs.length === 0 ? (
        <p className="text-body-secondary mb-0">
          No tab is being reloaded right now. Open the AutoReload popup on a tab
          and switch it on.
        </p>
      ) : (
        <Table size="sm" className="mb-0" id="summary-tabs">
          <thead>
            <tr>
              <th>Tab</th>
              <th>Interval</th>
              <th>Next reload</th>
            </tr>
          </thead>
          <tbody>
            {s.tabs.map((t) => (
              <tr key={t.tabId}>
                <td>
                  {t.title || `Tab ${t.tabId}`}{' '}
                  <span className="text-body-secondary">
                    {fullUrls ? (t.url ?? t.host) : t.host}
                  </span>
                </td>
                <td>{formatMs(t.intervalMs)}</td>
                <td>
                  {t.nextReloadAt === null
                    ? '-'
                    : `in ${formatMs(Math.max(0, t.nextReloadAt - now))}`}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
};

const ActivityPage = () => {
  useDarkTheme();
  const { snapshot, connected, clear } = useSnapshot();
  const [tabFilter, setTabFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [fullUrls, setFullUrls] = useState(false);
  const [notice, setNotice] = useState('');

  const entries = snapshot?.entries ?? [];

  const tabOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) {
      if (e.tabId !== undefined) {
        // later entries carry the latest title
        m.set(String(e.tabId), entryTabLabel(e, false));
      }
    }
    return Array.from(m.entries());
  }, [entries]);

  const kinds = useMemo(
    () => Array.from(new Set(entries.map((e) => e.kind))),
    [entries]
  );

  const shown = entries
    .filter((e) => tabFilter === 'all' || tabKey(e) === tabFilter)
    .filter((e) => kindFilter === 'all' || e.kind === kindFilter)
    .reverse();

  const text = () =>
    snapshot
      ? formatSnapshotText(
          {
            ...snapshot,
            entries: snapshot.entries
              .filter((e) => tabFilter === 'all' || tabKey(e) === tabFilter)
              .filter((e) => kindFilter === 'all' || e.kind === kindFilter),
          },
          { fullUrls }
        )
      : '';

  const flash = (m: string) => {
    setNotice(m);
    setTimeout(() => setNotice(''), 2500);
  };

  // Needs no clipboardWrite permission: it runs inside a click handler.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      flash('Copied to clipboard');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text();
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      flash(ok ? 'Copied to clipboard' : 'Copy failed, use Download instead');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autoreload-activity-log.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Container className="py-3" style={{ maxWidth: 1100 }}>
      <h1 className="h4">AutoReload activity log</h1>
      <p className="text-body-secondary">
        What AutoReload has done since the browser or add-on last started. Kept
        in memory only: never saved or sent anywhere, and cleared on restart.
        Keeps the last {snapshot?.cap ?? 500} entries.
      </p>

      {!connected && (
        <p className="text-danger">Not connected to the add-on, retrying...</p>
      )}
      {snapshot && <Summary snap={snapshot} fullUrls={fullUrls} />}

      <div
        className="d-flex flex-wrap align-items-center gap-2 mb-2"
        id="controls"
      >
        <Form.Select
          size="sm"
          style={{ width: 'auto' }}
          aria-label="Filter by tab"
          id="filter-tab"
          value={tabFilter}
          onChange={(e) => setTabFilter(e.target.value)}
        >
          <option value="all">All tabs</option>
          {tabOptions.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
          <option value="none">Not tab-specific</option>
        </Form.Select>
        <Form.Select
          size="sm"
          style={{ width: 'auto' }}
          aria-label="Filter by kind"
          id="filter-kind"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="all">All kinds</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </Form.Select>
        <Form.Check
          type="checkbox"
          id="full-urls"
          label="Show full URLs"
          checked={fullUrls}
          onChange={(e) => setFullUrls(e.target.checked)}
        />
        <div className="ms-auto d-flex align-items-center gap-2">
          {notice && <span className="text-success small">{notice}</span>}
          <Button size="sm" variant="secondary" id="btn-copy" onClick={copy}>
            Copy as text
          </Button>
          <Button
            size="sm"
            variant="secondary"
            id="btn-download"
            onClick={download}
          >
            Download .txt
          </Button>
          <Button
            size="sm"
            variant="outline-danger"
            id="btn-clear"
            onClick={clear}
          >
            Clear
          </Button>
        </div>
      </div>

      <Table size="sm" hover id="log-table">
        <thead>
          <tr>
            <th style={{ width: 160 }}>Time</th>
            <th style={{ width: 130 }}>Event</th>
            <th>What happened</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={3} className="text-body-secondary" id="log-empty">
                Nothing logged{entries.length ? ' for this filter' : ' yet'}.
              </td>
            </tr>
          )}
          {shown.map((e) => (
            <tr key={e.id} data-kind={e.kind} className="log-row">
              <td className="text-nowrap">{formatTime(e.time)}</td>
              <td>
                <Badge
                  bg={KIND_VARIANT[e.kind] ?? 'secondary'}
                  text={KIND_VARIANT[e.kind] === 'light' ? 'dark' : undefined}
                >
                  {kindLabel(e.kind)}
                </Badge>
              </td>
              <td>
                {e.tabId !== undefined && (
                  <span className="text-body-secondary">
                    {entryTabLabel(e, fullUrls)}:{' '}
                  </span>
                )}
                <span className="log-message">{e.message}</span>
                {e.details && (
                  <div
                    className="small text-body-secondary"
                    style={{ whiteSpace: 'pre-wrap' }}
                  >
                    {e.details}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Container>
  );
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ActivityPage />
  </React.StrictMode>
);
