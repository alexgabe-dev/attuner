import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  ScanLine,
  ShieldCheck,
  Archive,
  FolderLock,
  LoaderCircle,
  FileCode2,
} from '@attuner/ui';
type FileRow = { root: string; path: string; hash: string; size: number };
type Snapshot = { id: number; label: string; files: number; bytes: number; createdAt: number };
type LabView = {
  opened: boolean;
  workspacePath: string | null;
  adapterVersion: number | null;
  sqliteVersion: string | null;
  scanned: boolean;
  files: number;
  bytes: number;
  scanMs: number;
  entries: FileRow[];
  changes: { root: string; path: string; kind: string }[];
  changeCount: number;
  snapshots: Snapshot[];
  verification: { files: number; bytes: number; verified: boolean } | null;
  baselineId: number | null;
};
const empty: LabView = {
  opened: false,
  workspacePath: null,
  adapterVersion: null,
  sqliteVersion: null,
  scanned: false,
  files: 0,
  bytes: 0,
  scanMs: 0,
  entries: [],
  changes: [],
  changeCount: 0,
  snapshots: [],
  verification: null,
  baselineId: null,
};
function bytes(n: number) {
  return n >= 1048576
    ? `${(n / 1048576).toFixed(2)} MB`
    : n >= 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${n} B`;
}
export function LocalEngineLab({ nativeAvailable }: { nativeAvailable: boolean }) {
  const [view, setView] = useState<LabView>(empty);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'files' | 'changes' | 'snapshots'>('files');
  const invoke = useCallback(async (command: string, args?: Record<string, unknown>) => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<LabView>(command, args);
  }, []);
  useEffect(() => {
    if (!nativeAvailable) return;
    let alive = true;
    void invoke('local_lab_status')
      .then((value) => {
        if (alive) setView(value);
      })
      .catch(() => {
        if (alive) setError('Could not read the native fixture session.');
      });
    return () => {
      alive = false;
    };
  }, [invoke, nativeAvailable]);
  async function run(command: string, label: string, args?: Record<string, unknown>) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const result = await invoke(command, args);
      setView(result);
      setNotice(
        command === 'local_lab_create'
          ? 'Workspace created. All files are synthetic.'
          : command === 'local_lab_scan'
            ? `Complete scan: ${result.files} files, ${result.changeCount} changes.`
            : command === 'local_lab_snapshot'
              ? 'Immutable local snapshot captured. File bytes are backed up.'
              : 'Backup contents verified against BLAKE3 hashes.',
      );
    } catch (error) {
      const detail = error as { code?: string; message?: string };
      setError(
        detail.message ??
          'The local operation could not complete. No remote synchronization was attempted.',
      );
    } finally {
      setBusy('');
    }
  }
  async function cancel() {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('local_lab_cancel');
      setNotice('Cancellation requested. Waiting for a safe checkpoint.');
    } catch {
      setError('Could not request cancellation.');
    }
  }
  const latest = view.snapshots[0];
  return (
    <div className="local-lab">
      <div className="lab-context">
        <span>
          <span className="status-dot" />
          Real local data <span className="inline-dot">·</span> Rust engine
        </span>
        <Badge tone="neutral">
          <FolderLock size={12} />
          Synthetic workspace only
        </Badge>
      </div>
      {!nativeAvailable ? (
        <section className="content-panel lab-empty">
          <FolderLock size={28} />
          <h2>Open the native app to use the local engine.</h2>
          <p>
            This browser preview cannot access the Rust engine. The macOS app creates its own
            isolated fixture workspace.
          </p>
        </section>
      ) : !view.opened ? (
        <section className="content-panel lab-empty">
          <span className="lab-empty-icon">
            <FolderLock size={26} />
          </span>
          <h2>A safe place to put the engine to work.</h2>
          <p>
            Scan original bytes, capture immutable snapshots and verify compressed backups.
            Everything stays inside a private synthetic workspace.
          </p>
          <Button
            variant="primary"
            disabled={!!busy}
            onClick={() => void run('local_lab_create', 'Creating workspace')}
          >
            <FolderLock size={15} />
            {busy || 'Create fixture workspace'}
          </Button>
          <span className="lab-safety-copy">No game installation is discovered or connected.</span>
        </section>
      ) : (
        <>
          <section className="installation-panel lab-installation">
            <div className="installation-top">
              <span className="game-icon lab-icon">
                <FolderLock size={23} />
              </span>
              <div className="installation-identity">
                <h2>
                  Isolated fixture workspace <span>Adapter v{view.adapterVersion}</span>
                </h2>
                <span className="path-text" title={view.workspacePath ?? ''}>
                  {view.workspacePath}
                </span>
              </div>
              <Badge tone="success" dot>
                Fixture runtime closed
              </Badge>
            </div>
            <div className="installation-stats">
              <div>
                <FileCode2 size={19} />
                <span>
                  <small>Scanned files</small>
                  <strong>{view.scanned ? view.files : '—'}</strong>
                </span>
              </div>
              <div>
                <Archive size={19} />
                <span>
                  <small>Original bytes</small>
                  <strong>{view.scanned ? bytes(view.bytes) : '—'}</strong>
                </span>
              </div>
              <div>
                <ScanLine size={19} />
                <span>
                  <small>Last scan</small>
                  <strong>{view.scanned ? `${view.scanMs.toFixed(1)} ms` : '—'}</strong>
                </span>
              </div>
              <div>
                <ShieldCheck size={19} />
                <span>
                  <small>Local snapshots</small>
                  <strong>{view.snapshots.length}</strong>
                </span>
              </div>
            </div>
          </section>
          <div className="lab-actions">
            <Button
              variant="primary"
              disabled={!!busy}
              onClick={() => void run('local_lab_scan', 'Scanning fixture files')}
            >
              <ScanLine size={15} />
              Scan fixture files
            </Button>
            <Button
              disabled={!!busy || !view.scanned}
              onClick={() => void run('local_lab_snapshot', 'Capturing snapshot')}
            >
              <Archive size={15} />
              Capture snapshot
            </Button>
            <Button
              disabled={!!busy || !latest}
              onClick={() =>
                latest &&
                void run('local_lab_verify', 'Verifying backups', { snapshotId: latest.id })
              }
            >
              <ShieldCheck size={15} />
              Verify backups
            </Button>
            {busy && <Button onClick={() => void cancel()}>Cancel</Button>}
          </div>
          {view.verification && (
            <div className="lab-verification">
              <ShieldCheck size={19} />
              <div>
                <strong>Backup integrity verified</strong>
                <p>
                  {view.verification.files} files · {bytes(view.verification.bytes)} of original
                  content · Zstandard + BLAKE3
                </p>
              </div>
              <Badge tone="success">Verified</Badge>
            </div>
          )}
          <section className="content-panel lab-results">
            <div className="section-heading">
              <div className="segmented">
                <button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
                  Files {view.scanned ? `· ${view.files}` : ''}
                </button>
                <button aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>
                  Changes · {view.changeCount}
                </button>
                <button aria-pressed={tab === 'snapshots'} onClick={() => setTab('snapshots')}>
                  Snapshots · {view.snapshots.length}
                </button>
              </div>
              <span className="muted lab-readonly">Read-only inspection</span>
            </div>
            {tab === 'files' &&
              (view.scanned ? (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="Real fixture files"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Scope</th>
                        <th>Original size</th>
                        <th>BLAKE3</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.entries.map((file) => (
                        <tr key={`${file.root}/${file.path}`}>
                          <td className="lab-file-name">
                            <FileCode2 size={14} />
                            {file.path}
                          </td>
                          <td>{file.root}</td>
                          <td className="mono">{bytes(file.size)}</td>
                          <td>
                            <code title={file.hash}>{file.hash.slice(0, 12)}…</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="lab-inline-empty">
                  <ScanLine size={22} />
                  <h3>Start with a complete scan.</h3>
                  <p>A scan covers every configured root. Missing or unstable files fail closed.</p>
                </div>
              ))}
            {tab === 'changes' &&
              (view.scanned && view.changeCount ? (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="Real local changes"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Scope</th>
                        <th>Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.changes.map((change) => (
                        <tr key={`${change.root}/${change.path}`}>
                          <td>{change.path}</td>
                          <td>{change.root}</td>
                          <td>
                            <Badge tone={change.kind === 'deleted' ? 'warning' : 'accent'}>
                              {change.kind}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="lab-inline-empty">
                  <ShieldCheck size={23} />
                  <h3>
                    {view.scanned ? 'No changes from the local baseline.' : 'No complete scan yet.'}
                  </h3>
                  <p>
                    {view.scanned
                      ? 'The captured file bytes match the local baseline. This says nothing about remote devices.'
                      : 'Incomplete scans never authorize a deletion.'}
                  </p>
                </div>
              ))}
            {tab === 'snapshots' &&
              (view.snapshots.length ? (
                <div
                  className="table-scroll"
                  role="region"
                  aria-label="Real snapshot history"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Snapshot</th>
                        <th>Captured</th>
                        <th>Files</th>
                        <th>Original size</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.snapshots.map((snapshot) => (
                        <tr key={snapshot.id}>
                          <td>
                            <strong>Local #{snapshot.id}</strong>
                            <small className="lab-snapshot-label">{snapshot.label}</small>
                          </td>
                          <td>
                            {new Date(snapshot.createdAt * 1000).toLocaleTimeString('en-GB', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td>{snapshot.files}</td>
                          <td className="mono">{bytes(snapshot.bytes)}</td>
                          <td>
                            <Badge tone={view.baselineId === snapshot.id ? 'accent' : 'neutral'}>
                              {view.baselineId === snapshot.id ? 'Baseline' : 'Preserved'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="lab-inline-empty">
                  <Archive size={23} />
                  <h3>Your first restore point starts here.</h3>
                  <p>Complete a scan, then capture a local snapshot.</p>
                </div>
              ))}
            <div className="panel-footnote">
              <ShieldCheck size={13} />
              Local metadata · SQLite {view.sqliteVersion} · Up to 100 files and 20 snapshots shown
            </div>
          </section>
          <div className="security-note">
            <FolderLock size={18} />
            <div>
              <h3>Local integrity, without a live game connection.</h3>
              <p>
                The fixture runtime guard is not real WoW detection. Remote synchronization remains
                simulated. No apply, restore or arbitrary-path command is exposed to this UI.
              </p>
            </div>
          </div>
        </>
      )}
      <div className="lab-feedback" aria-live="polite">
        {busy && (
          <span>
            <LoaderCircle size={15} className="spin" />
            {busy}…
          </span>
        )}
        {notice && <p>{notice}</p>}
      </div>
      {error && (
        <div className="lab-error" role="alert">
          <strong>Local operation stopped</strong>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
