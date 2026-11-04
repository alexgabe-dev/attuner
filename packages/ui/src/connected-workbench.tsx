'use client';
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeftRight,
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  CircleCheck,
  FileCode2,
  History,
  House,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { pages, pageLabels, type Page } from '@attuner/shared';
import { Badge, Brand, Button } from './primitives';
import {
  bytes,
  stateLabel,
  progressLabel,
  terminal,
  type Audit,
  type ConnectedController,
  type ConflictEntry,
  type ConflictReview,
  type Device,
  type Head,
  type LocalInspection,
  type LocalJob,
  type Manifest,
  type NativeStatus,
  type Profile,
  type Proposal,
  type Report,
  type Snapshot,
  type VariantDecision,
} from './connected-model';
const DialogError = createContext('');
const icons = {
  overview: House,
  devices: Monitor,
  snapshots: Layers3,
  activity: History,
  conflicts: TriangleAlert,
  diff: ArrowLeftRight,
  addons: Box,
  settings: Settings2,
};
const descriptions: Record<Page, string> = {
  overview: 'One setup. Every device.',
  devices: 'Your trusted devices and their last applied revision.',
  snapshots: 'Immutable history. Every revision preserved.',
  activity: 'A complete record of your profile’s activity.',
  conflicts: 'Review each version. Keep control of every change.',
  diff: 'See exactly what changed between revisions.',
  addons: 'Content captured in your published setup.',
  settings: 'A private connection. Deliberate changes.',
};
const date = (value: number) =>
  new Date(value * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const short = (value: string) => value.slice(0, 10);
const reason = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'The operation could not be completed.';
const key = (file: { root: string; path: string }) => `${file.root}/${file.path}`;
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Layers3 size={25} />
      <h3>{title}</h3>
      <div className="connected-empty-copy">{children}</div>
    </div>
  );
}
function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="content-panel connected-panel">
      <div className="section-heading">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
function Status({ state }: { state: string }) {
  return (
    <Badge
      dot
      tone={
        state === 'complete'
          ? 'success'
          : ['conflictReview', 'recoveryRequired', 'failed'].includes(state)
            ? 'warning'
            : 'neutral'
      }
    >
      {stateLabel(state)}
    </Badge>
  );
}
function Modal({
  title,
  description,
  close,
  children,
}: {
  title: string;
  description: string;
  close: () => void;
  children: ReactNode;
}) {
  const error = useContext(DialogError);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content connected-dialog">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="dialog-description">{description}</Dialog.Description>
          {error && (
            <div className="connected-message connected-error" role="alert">
              {error}
            </div>
          )}
          <Dialog.Close className="icon-button dialog-close" aria-label="Close dialog">
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function ConflictChoices({
  conflicts,
  choices,
  choose,
}: {
  conflicts: ConflictEntry[];
  choices: Record<string, 'local' | 'remote'>;
  choose: (entry: ConflictEntry, value: 'local' | 'remote') => void;
}) {
  return (
    <div className="connected-conflicts">
      {conflicts.map((entry) => (
        <fieldset key={key(entry)} className="connected-conflict">
          <legend>
            <FileCode2 size={15} />
            <bdi>{key(entry)}</bdi>
          </legend>
          <p>
            {entry.group
              ? `Keep the ${entry.path.split('/')[0]} addon together.`
              : 'Both versions changed since the baseline.'}
          </p>
          <div className="connected-variants">
            {(['local', 'remote'] as const).map((side) => (
              <label key={side} className={choices[key(entry)] === side ? 'selected' : ''}>
                <input
                  type="radio"
                  name={key(entry)}
                  checked={choices[key(entry)] === side}
                  onChange={() => choose(entry, side)}
                />
                <span>
                  <strong>{side === 'local' ? 'Source device' : 'Published version'}</strong>
                  <small>
                    {entry[side]
                      ? `${bytes(entry[side]!.size)} · ${short(entry[side]!.hash)}`
                      : 'Delete this file'}
                  </small>
                </span>
                {choices[key(entry)] === side && <Check size={16} />}
              </label>
            ))}
          </div>
          <small className="muted">
            Baseline:{' '}
            {entry.baseline
              ? `${bytes(entry.baseline.size)} · ${short(entry.baseline.hash)}`
              : 'File did not exist'}
          </small>
        </fieldset>
      ))}
    </div>
  );
}
function decisions(
  conflicts: ConflictEntry[],
  choices: Record<string, 'local' | 'remote'>,
): VariantDecision[] {
  return conflicts.map((c) => ({ root: c.root, path: c.path, choice: choices[key(c)]! }));
}
export function ConnectedWorkbench({
  platform,
  controller,
  page: controlledPage = 'overview',
  onNavigate,
  enrollmentId,
}: {
  platform: 'web' | 'desktop';
  controller: ConnectedController;
  page?: Page;
  onNavigate?: (page: Page) => void;
  enrollmentId?: string;
}) {
  const [page, setPage] = useState(controlledPage),
    [mobile, setMobile] = useState(false);
  const [authenticated, setAuthenticated] = useState(false),
    [checking, setChecking] = useState(true),
    [username, setUsername] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [profileId, setProfileId] = useState('');
  const [head, setHead] = useState<Head>({ snapshotId: null, revision: 0, manifestHash: null });
  const [devices, setDevices] = useState<Device[]>([]),
    [snapshots, setSnapshots] = useState<Snapshot[]>([]),
    [jobs, setJobs] = useState<Report[]>([]),
    [events, setEvents] = useState<Audit[]>([]);
  const [next, setNext] = useState<{
    snapshots: number | null;
    jobs: number | null;
    activity: number | null;
  }>({ snapshots: null, jobs: null, activity: null });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all');
  const [native, setNative] = useState<NativeStatus>(),
    [fixtureId, setFixtureId] = useState(''),
    [local, setLocal] = useState<LocalInspection>();
  const [modal, setModal] = useState<
      'profile' | 'revoke' | 'review' | 'connection' | 'forget' | null
    >(null),
    [revoke, setRevoke] = useState<Device>();
  const [review, setReview] = useState<ConflictReview>(),
    [choices, setChoices] = useState<Record<string, 'local' | 'remote'>>({}),
    [reviewJob, setReviewJob] = useState<LocalJob>(),
    [proposals, setProposals] = useState<Proposal[]>([]);
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [comparison, setComparison] = useState<{ before: Manifest; after: Manifest }>(),
    [preview, setPreview] = useState<{
      path: string;
      text: string | null;
      kind: string;
      truncated: boolean;
      size: number;
    }>();
  const [headManifest, setHeadManifest] = useState<Manifest>();
  const operation = useRef(false),
    generation = useRef(0);
  const navigate = (next: Page) => {
    setPage(next);
    onNavigate?.(next);
    setMobile(false);
    setQuery('');
    setFilter('all');
    setPreview(undefined);
  };
  useEffect(() => {
    setPage(controlledPage);
    setQuery('');
    setFilter('all');
    setPreview(undefined);
  }, [controlledPage]);
  const loadProfiles = useCallback(async () => {
    const result = await controller.read<{ profiles: Profile[] }>({ view: 'profiles' });
    setProfiles(result.profiles);
    setProfileId((old) =>
      result.profiles.some((p) => p.id === old) ? old : (result.profiles[0]?.id ?? ''),
    );
  }, [controller]);
  const refresh = useCallback(async () => {
    if (!profileId) return;
    const version = ++generation.current;
    // Serial requests respect the API's bounded manifest/transfer admission.
    const current = await controller.read<{ head: Head }>({ view: 'head', profile: profileId });
    const ds = await controller.read<{ devices: Device[] }>({
      view: 'devices',
      profile: profileId,
    });
    const ss = await controller.read<{ snapshots: Snapshot[]; nextBefore: number | null }>({
      view: 'snapshots',
      profile: profileId,
    });
    const js = await controller.read<{ jobs: Report[]; nextBefore: number | null }>({
      view: 'jobs',
      profile: profileId,
    });
    const es = await controller.read<{ events: Audit[]; nextBefore: number | null }>({
      view: 'activity',
      profile: profileId,
    });
    if (version !== generation.current) return;
    setHead(current.head);
    setDevices(ds.devices);
    setSnapshots(ss.snapshots);
    setJobs(js.jobs);
    setEvents(es.events);
    setNext({ snapshots: ss.nextBefore, jobs: js.nextBefore, activity: es.nextBefore });
    setFrom((old) => (ss.snapshots.some((s) => s.id === old) ? old : (ss.snapshots[1]?.id ?? '')));
    setTo((old) => (ss.snapshots.some((s) => s.id === old) ? old : (ss.snapshots[0]?.id ?? '')));
    setComparison(undefined);
    setHeadManifest(undefined);
  }, [controller, profileId]);
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
      operation.current = false;
    }
  };
  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        if (controller.native) {
          const status = await controller.native.status();
          if (active) setNative(status);
          if (!status.device?.enrolled) return;
        } else {
          const session = await controller.session!();
          if (active) setUsername(session.user.username);
        }
        if (active) {
          setAuthenticated(true);
          await loadProfiles();
        }
      } catch {
        /* A session is never assumed from demo data. */
      } finally {
        if (active) setChecking(false);
      }
    }
    void initialize();
    return () => {
      active = false;
    };
  }, [controller, loadProfiles]);
  useEffect(() => {
    if (!authenticated || !profileId) return;
    let active = true;
    void refresh().catch((e) => {
      if (active) setError(reason(e));
    });
    return () => {
      active = false;
    };
  }, [authenticated, profileId, refresh]);
  useEffect(() => {
    if (!controller.native) return;
    let active = true;
    const tick = async () => {
      try {
        const value = await controller.native!.status();
        if (!active) return;
        setNative(value);
        if (value.device?.enrolled && !authenticated) {
          setAuthenticated(true);
          await loadProfiles();
        }
      } catch {
        /* Explicit operations surface host errors. */
      }
    };
    const timer = setInterval(() => void tick(), 800);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [controller, authenticated, loadProfiles]);
  const fixture = native?.fixtures?.find((f) => f.id === fixtureId);
  useEffect(() => {
    const available = native?.fixtures?.filter((f) => f.profileId === profileId) ?? [];
    setFixtureId((old) => (available.some((f) => f.id === old) ? old : (available[0]?.id ?? '')));
  }, [native?.fixtures, profileId]);
  useEffect(() => {
    setLocal(undefined);
    if (!fixtureId || !controller.native) return;
    let active = true;
    void controller.native
      .local<LocalInspection>({ action: 'inspect', fixture: fixtureId })
      .then((value) => {
        if (active) setLocal(value);
      })
      .catch((e) => {
        if (active) setError(reason(e));
      });
    return () => {
      active = false;
    };
  }, [controller, fixtureId]);
  async function localAction(action: Record<string, unknown>) {
    const result = await controller.native!.local<LocalInspection>({
      ...(action.action === 'create' ? {} : { fixture: fixtureId }),
      ...action,
    });
    setLocal(result);
    const status = await controller.native!.status();
    setNative(status);
    if (authenticated) {
      try {
        await refresh();
      } catch {
        setNotice('Local state saved. Refresh the remote history after reconnecting.');
      }
    }
    if (action.action === 'create') {
      const added = status.fixtures?.filter((f) => f.profileId === profileId).at(-1);
      if (added) setFixtureId(added.id);
    }
  }
  const working = busy || native?.busy;
  const profile = profiles.find((p) => p.id === profileId);
  const readOnly = profile?.permission === 'read' || profile?.role === 'reader';
  const activeJob = local?.jobs.find(
    (j) => !terminal(j.state) && !('revokedAt' in j && j.revokedAt),
  );
  const activeReports = jobs.filter(
    (j) => !terminal(j.state) && !('revokedAt' in j && j.revokedAt),
  );
  const needsReview = jobs.filter((j) => j.state === 'conflictReview' && !j.revokedAt);
  const filtered = <T,>(rows: T[]) =>
    rows.filter((row) =>
      JSON.stringify(row).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
  const matchesJob = (job: Report) =>
    filter === 'all' || filter === 'attention'
      ? filter === 'all' || ['failed', 'recoveryRequired', 'conflictReview'].includes(job.state)
      : job.state === filter;
  async function more(kind: 'snapshots' | 'jobs' | 'activity') {
    const before = next[kind];
    if (before === null) return;
    const result = await controller.read<{
      snapshots?: Snapshot[];
      jobs?: Report[];
      events?: Audit[];
      nextBefore: number | null;
    }>({ view: kind, profile: profileId, before });
    if (kind === 'snapshots') setSnapshots((v) => [...v, ...result.snapshots!]);
    if (kind === 'jobs') setJobs((v) => [...v, ...result.jobs!]);
    if (kind === 'activity') setEvents((v) => [...v, ...result.events!]);
    setNext((v) => ({ ...v, [kind]: result.nextBefore }));
  }
  async function openReview(job: Report) {
    const result = await controller.read<ConflictReview>({
      view: 'conflicts',
      profile: profileId,
      job: job.id,
    });
    setReview(result);
    setReviewJob(undefined);
    setChoices({});
    setProposals(
      (
        await controller.read<{ proposals: Proposal[] }>({
          view: 'proposals',
          profile: profileId,
          job: job.id,
        })
      ).proposals,
    );
    setModal('review');
  }
  function choose(entry: ConflictEntry, side: 'local' | 'remote') {
    const list = reviewJob?.conflicts ?? review?.conflicts ?? [];
    setChoices((old) => ({
      ...old,
      ...Object.fromEntries(
        list
          .filter((c) => key(c) === key(entry) || (entry.group && c.group === entry.group))
          .map((c) => [key(c), side]),
      ),
    }));
  }
  async function compare() {
    if (!from || !to || from === to) return;
    const before = await controller.read<{ manifest: Manifest }>({
      view: 'snapshot',
      profile: profileId,
      snapshot: from,
    });
    const after = await controller.read<{ manifest: Manifest }>({
      view: 'snapshot',
      profile: profileId,
      snapshot: to,
    });
    setComparison({ before: before.manifest, after: after.manifest });
    setPreview(undefined);
  }
  const diff = (() => {
    if (!comparison) return [];
    const b = new Map(comparison.before.files.map((f) => [key(f), f])),
      a = new Map(comparison.after.files.map((f) => [key(f), f]));
    return [...new Set([...b.keys(), ...a.keys()])].sort().flatMap((path) => {
      const before = b.get(path),
        after = a.get(path);
      return before?.hash === after?.hash && before?.size === after?.size
        ? []
        : [{ path, before, after, kind: !before ? 'added' : !after ? 'removed' : 'modified' }];
    });
  })();
  async function showPreview(snapshot: string, file: Manifest['files'][number]) {
    const result = await controller.read<{
      text: string | null;
      kind: string;
      truncated: boolean;
      size: number;
    }>({ view: 'preview', profile: profileId, snapshot, root: file.root, path: file.path });
    setPreview({ path: key(file), ...result });
  }
  const reportRows = (rows: Report[]) =>
    rows.map((job) => (
      <div className="connected-row" key={job.id}>
        <span className="connected-symbol">
          <ArrowLeftRight size={17} />
        </span>
        <div className="connected-grow">
          <strong>{job.deviceName}</strong>
          <small>
            {date(job.receivedAt)} · {short(job.id)}
            {job.publishedHead ? ` · revision ${job.publishedHead.revision}` : ''}
          </small>
          {job.plannedBytes > 0 && (
            <small>
              {bytes(job.transferredBytes)} of {bytes(job.plannedBytes)} received by server
            </small>
          )}
          {job.reason && <small className="connected-warning">{job.reason}</small>}
        </div>
        <Status state={'revokedAt' in job && job.revokedAt ? 'revoked' : job.state} />
        {job.state === 'conflictReview' && !('revokedAt' in job && job.revokedAt) && (
          <Button
            variant="ghost"
            disabled={working}
            onClick={() => void run(() => openReview(job))}
          >
            Review <ChevronRight size={14} />
          </Button>
        )}
      </div>
    ));
  return (
    <DialogError.Provider value={error}>
      <div className={`app-shell platform-${platform} connected-shell`}>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {mobile && (
          <button
            className="mobile-backdrop"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          />
        )}
        <aside className={`sidebar ${mobile ? 'sidebar-open' : ''}`}>
          <div className="sidebar-brand">
            <Brand />
            <button
              className="icon-button mobile-close"
              aria-label="Close navigation"
              onClick={() => setMobile(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="connected-profile">
            <span className="micro-label">PROFILE</span>
            <select
              aria-label="Profile"
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                setLocal(undefined);
              }}
              disabled={!profiles.length || working}
            >
              {!profiles.length && <option value="">No profile yet</option>}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="connected-synthetic">
              {readOnly ? 'Read-only · Synthetic installations' : 'Synthetic installations'}
            </span>
          </div>
          <nav aria-label="Main navigation">
            {pages
              .filter((p) => p !== 'settings')
              .map((p) => {
                const Icon = icons[p];
                return (
                  <button
                    key={p}
                    className={`nav-item ${page === p ? 'active' : ''}`}
                    aria-label={pageLabels[p]}
                    aria-current={page === p ? 'page' : undefined}
                    onClick={() => navigate(p)}
                  >
                    <Icon size={18} />
                    <span>{pageLabels[p]}</span>
                    {p === 'conflicts' && needsReview.length > 0 && (
                      <span className="nav-count">{needsReview.length}</span>
                    )}
                  </button>
                );
              })}
          </nav>
          <div className="sidebar-bottom">
            <button
              className={`nav-item ${page === 'settings' ? 'active' : ''}`}
              onClick={() => navigate('settings')}
            >
              <Settings2 size={18} />
              Settings
            </button>
            <div className="connected-account">
              <span className="status-dot" />
              <span>
                {authenticated
                  ? platform === 'desktop'
                    ? 'Device enrolled'
                    : username
                  : 'Private workspace'}
              </span>
              <LockKeyhole size={13} />
            </div>
            <small className="connected-synthetic">Phase 3 · Manual synchronization</small>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                className="icon-button mobile-menu"
                aria-label="Open navigation"
                onClick={() => setMobile(true)}
              >
                <Menu size={19} />
              </button>
              <span className="breadcrumb-workspace">Workspace</span>
              <ChevronRight size={13} />
              <span>{enrollmentId ? 'Device enrollment' : pageLabels[page]}</span>
            </div>
            <div className="topbar-right">
              <span className="topbar-private">
                <LockKeyhole size={13} />
                Self-hosted & private
              </span>
              <Badge tone="accent">Connected mode</Badge>
            </div>
          </header>
          <main id="main-content" className="main-content" tabIndex={-1}>
            <div className="page-heading">
              <div>
                <p className="eyebrow">{profile?.name ?? 'YOUR PRIVATE WORKSPACE'}</p>
                <h1>{enrollmentId ? 'Connect your device' : pageLabels[page]}</h1>
                <p>
                  {enrollmentId ? 'Approve only the device you requested.' : descriptions[page]}
                </p>
              </div>
              {authenticated && !enrollmentId && (
                <div className="heading-actions">
                  {controller.write && (
                    <Button variant="ghost" disabled={working} onClick={() => setModal('profile')}>
                      <Plus size={15} />
                      New profile
                    </Button>
                  )}
                  <Button
                    disabled={working}
                    onClick={() =>
                      void run(async () => {
                        await loadProfiles();
                        await refresh();
                        if (fixtureId)
                          setLocal(
                            await controller.native!.local({
                              action: 'inspect',
                              fixture: fixtureId,
                            }),
                          );
                      })
                    }
                  >
                    <RefreshCw size={14} className={working ? 'spin' : ''} />
                    Refresh
                  </Button>
                </div>
              )}
            </div>
            {error && (
              <div className="connected-message connected-error" role="alert">
                <TriangleAlert size={17} />
                <span>{error}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError('')}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {notice && (
              <div className="connected-message" role="status">
                <CircleCheck size={17} />
                {notice}
              </div>
            )}
            {checking ? (
              <Empty title="Opening your workspace…" />
            ) : !authenticated ? (
              controller.native ? (
                <Connection
                  controller={controller}
                  native={native}
                  busy={!!working}
                  run={run}
                  connected={async () => {
                    setNative(await controller.native!.status());
                    await loadProfiles();
                    setAuthenticated(true);
                  }}
                />
              ) : (
                <Login
                  controller={controller}
                  busy={busy}
                  run={run}
                  onLogin={async (name) => {
                    setUsername(name);
                    setAuthenticated(true);
                    await loadProfiles();
                  }}
                />
              )
            ) : enrollmentId ? (
              <Enrollment
                controller={controller}
                id={enrollmentId}
                profiles={profiles}
                busy={busy}
                run={run}
              />
            ) : !profileId ? (
              <Empty title="A fresh start">
                <p>
                  Create a profile, then enroll a desktop device to publish your first synthetic
                  setup.
                </p>
                <Button variant="primary" onClick={() => setModal('profile')}>
                  Create profile
                </Button>
              </Empty>
            ) : (
              <>
                {controller.native && page === 'overview' && (
                  <Panel title="This device" aside={<Badge tone="accent">Isolated fixture</Badge>}>
                    <div className="connected-local-toolbar">
                      <label>
                        Local workspace
                        <select
                          aria-label="Local workspace"
                          value={fixtureId}
                          disabled={working}
                          onChange={(e) => setFixtureId(e.target.value)}
                        >
                          <option value="">Choose a workspace</option>
                          {native?.fixtures
                            ?.filter((f) => f.profileId === profileId)
                            .map((f, i) => (
                              <option key={f.id} value={f.id}>
                                Synthetic setup {i + 1} · adapter {f.adapterVersion}
                              </option>
                            ))}
                        </select>
                      </label>
                      <Button
                        disabled={working || !native?.localSupported || readOnly}
                        onClick={() =>
                          void run(() =>
                            localAction({ action: 'create', profile: profileId, adapter: 1 }),
                          )
                        }
                      >
                        <Plus size={15} />
                        Create fixture
                      </Button>
                      <Button
                        variant="primary"
                        disabled={working || !fixture || !!activeJob || readOnly}
                        onClick={() => void run(() => localAction({ action: 'prepare' }))}
                      >
                        <RefreshCw size={15} />
                        Compare changes
                      </Button>
                    </div>
                    {!native?.localSupported && (
                      <p className="connected-note">
                        Local file application is disabled until Windows durability qualification is
                        complete. Device and revision management are available.
                      </p>
                    )}
                    {readOnly && (
                      <p className="connected-note">
                        This device can inspect snapshots. Publishing permission is required to
                        start a local synchronization comparison.
                      </p>
                    )}
                    {native?.busy && (
                      <div className="connected-progress" role="status">
                        <LoaderCircle size={15} className="spin" />
                        <span>
                          {progressLabel(native.progress?.phase ?? 'Working')}
                          {native.progress?.path ? ` · ${native.progress.path}` : ''}
                          {native.progress?.transfer
                            ? ` · ${bytes(native.progress.transfer.completedBytes)} / ${bytes(native.progress.transfer.totalBytes)}`
                            : ''}
                        </span>
                        <Button variant="ghost" onClick={() => void controller.native!.cancel()}>
                          Cancel operation
                        </Button>
                      </div>
                    )}
                    {activeJob && (
                      <LocalReview
                        readOnly={readOnly}
                        job={activeJob}
                        busy={!!working}
                        action={(action) =>
                          void run(() => localAction({ job: activeJob.id, ...action }))
                        }
                        review={() => {
                          setReviewJob(activeJob);
                          setReview(undefined);
                          setChoices({});
                          setProposals([]);
                          setModal('review');
                          void run(async () =>
                            setProposals(
                              (
                                await controller.read<{ proposals: Proposal[] }>({
                                  view: 'proposals',
                                  profile: profileId,
                                  job: activeJob.id,
                                })
                              ).proposals,
                            ),
                          );
                        }}
                      />
                    )}{' '}
                    {!!local?.pendingAcknowledgements && (
                      <div className="connected-row">
                        <span className="connected-grow">
                          Applied safely. {local.pendingAcknowledgements} receipt pending.
                        </span>
                        <Button
                          disabled={working}
                          onClick={() => void run(() => localAction({ action: 'acknowledge' }))}
                        >
                          Send receipt
                        </Button>
                      </div>
                    )}
                    {local?.operations
                      .filter((op) => !['committed', 'rolledBack', 'recovered'].includes(op.state))
                      .map((op) => (
                        <div className="connected-row" key={op.id}>
                          <div className="connected-grow">
                            <strong>Recovery operation #{op.id}</strong>
                            <small>
                              {op.state} · {op.error}
                            </small>
                          </div>
                          <Button
                            disabled={working}
                            onClick={() =>
                              void run(() => localAction({ action: 'recover', operation: op.id }))
                            }
                          >
                            Recover safely
                          </Button>
                        </div>
                      ))}
                  </Panel>
                )}
                {page === 'overview' && (
                  <>
                    <section className="connected-overview">
                      <div className="connected-health-icon">
                        {needsReview.length ? (
                          <TriangleAlert size={24} />
                        ) : (
                          <ShieldCheck size={25} />
                        )}
                      </div>
                      <div>
                        <h2>
                          {needsReview.length
                            ? 'A few changes need your attention'
                            : head.revision
                              ? 'Your setup, preserved'
                              : 'Ready for your first revision'}
                        </h2>
                        <p>
                          {head.revision
                            ? `Revision ${head.revision} is immutable and content verified.`
                            : 'Publish a reviewed snapshot from an enrolled desktop.'}
                        </p>
                      </div>
                      <div className="connected-revision">
                        <span className="micro-label">LATEST REVISION</span>
                        <strong>
                          {head.revision ? `#${head.revision.toLocaleString()}` : '—'}
                        </strong>
                      </div>
                    </section>
                    <div className="connected-metrics">
                      <div>
                        <span>Trusted devices</span>
                        <strong>{devices.filter((d) => !d.revokedAt).length}</strong>
                      </div>
                      <div>
                        <span>Active synchronizations</span>
                        <strong>{activeReports.length}</strong>
                      </div>
                      <div>
                        <span>Conflicts to review</span>
                        <strong>{needsReview.length}</strong>
                      </div>
                    </div>
                    <div className="connected-columns">
                      <Panel
                        title="Synchronization history"
                        aside={
                          <Button variant="ghost" onClick={() => navigate('activity')}>
                            View all <ArrowRight size={13} />
                          </Button>
                        }
                      >
                        {jobs.length ? (
                          reportRows(jobs.slice(0, 5))
                        ) : (
                          <Empty title="No synchronizations yet">
                            Real source-device activity will appear here.
                          </Empty>
                        )}
                      </Panel>
                      <Panel
                        title="Devices"
                        aside={
                          <Button variant="ghost" onClick={() => navigate('devices')}>
                            Manage <ArrowRight size={13} />
                          </Button>
                        }
                      >
                        {devices.length ? (
                          devices.slice(0, 4).map((d) => (
                            <div key={d.id} className="connected-row">
                              <Monitor size={20} className="muted" />
                              <div className="connected-grow">
                                <strong>{d.name}</strong>
                                <small>
                                  {d.os} ·{' '}
                                  {d.lastSeenAt
                                    ? `Seen ${date(d.lastSeenAt)}`
                                    : 'Awaiting first connection'}
                                </small>
                              </div>
                              <Badge tone={d.revokedAt ? 'neutral' : 'success'}>
                                {d.revokedAt
                                  ? 'Revoked'
                                  : d.acknowledgedRevision
                                    ? `Applied #${d.acknowledgedRevision}`
                                    : 'Enrolled'}
                              </Badge>
                            </div>
                          ))
                        ) : (
                          <Empty title="No trusted devices">
                            Enroll from the Attuner desktop app.
                          </Empty>
                        )}
                      </Panel>
                    </div>
                  </>
                )}
                {page === 'devices' && (
                  <>
                    <div className="connected-toolbar">
                      <SearchBox value={query} change={setQuery} placeholder="Find a device…" />
                      <select
                        aria-label="Device status"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">All devices</option>
                        <option value="active">Trusted</option>
                        <option value="revoked">Revoked</option>
                      </select>
                      {controller.native && (
                        <Button
                          onClick={() =>
                            void run(async () => {
                              await controller.native!.dashboard();
                            })
                          }
                        >
                          Manage in browser <ArrowRight size={14} />
                        </Button>
                      )}
                    </div>
                    <Panel title={`${devices.filter((d) => !d.revokedAt).length} trusted devices`}>
                      {filtered(devices)
                        .filter((d) => filter === 'all' || (filter === 'revoked') === !!d.revokedAt)
                        .map((d) => (
                          <div className="connected-row" key={d.id}>
                            <span className="connected-symbol">
                              <Monitor size={19} />
                            </span>
                            <div className="connected-grow">
                              <strong>{d.name}</strong>
                              <small>
                                {d.os} · Attuner {d.clientVersion} · Enrolled {date(d.createdAt)}
                              </small>
                              <small>
                                {d.lastSeenAt
                                  ? `Last foreground request ${date(d.lastSeenAt)}`
                                  : 'Not seen yet'}{' '}
                                ·{' '}
                                {d.acknowledgedRevision
                                  ? `Applied revision #${d.acknowledgedRevision}`
                                  : 'No application receipt'}
                              </small>
                            </div>
                            <Badge tone={d.revokedAt ? 'neutral' : 'success'}>
                              {d.revokedAt ? 'Revoked' : 'Trusted'}
                            </Badge>
                            {controller.write && !!d.owned && !d.revokedAt && (
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setRevoke(d);
                                  setModal('revoke');
                                }}
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        ))}
                      {!devices.length && (
                        <Empty title="Enroll your first device">
                          Open Attuner on your desktop and choose Connect device.
                        </Empty>
                      )}
                    </Panel>
                    <p className="connected-note">
                      Device presence reflects its last authenticated foreground request. It does
                      not imply the game is closed.
                    </p>
                  </>
                )}
                {page === 'snapshots' && (
                  <>
                    <div className="connected-toolbar">
                      <SearchBox value={query} change={setQuery} placeholder="Find a revision…" />
                      <Button disabled={snapshots.length < 2} onClick={() => navigate('diff')}>
                        <ArrowLeftRight size={15} />
                        Compare revisions
                      </Button>
                    </div>
                    <Panel title="Published revisions">
                      {filtered(snapshots).map((s) => (
                        <div className="connected-row" key={s.id}>
                          <span className="connected-symbol">
                            <Layers3 size={18} />
                          </span>
                          <div className="connected-grow">
                            <strong>
                              Revision #{s.revision}{' '}
                              {s.id === head.snapshotId && <Badge tone="accent">Latest</Badge>}
                            </strong>
                            <small>
                              {date(s.createdAt)} · {short(s.manifestHash)} ·{' '}
                              {bytes(s.transferredBytes)} transferred
                            </small>
                          </div>
                          <span className="connected-change-count">
                            <span>+{s.added}</span> {s.modified} changed <em>−{s.removed}</em>
                          </span>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setTo(s.id);
                              setFrom(s.parentId ?? '');
                              navigate('diff');
                            }}
                          >
                            Inspect <ChevronRight size={14} />
                          </Button>
                        </div>
                      ))}
                      {!snapshots.length && (
                        <Empty title="Your history starts here">
                          Published revisions appear after an explicit desktop approval.
                        </Empty>
                      )}
                      {next.snapshots !== null && (
                        <Button
                          disabled={working}
                          onClick={() => void run(() => more('snapshots'))}
                        >
                          Load earlier revisions
                        </Button>
                      )}
                    </Panel>
                    {controller.native && !!local?.snapshots.length && (
                      <Panel title="Local recovery snapshots">
                        {local.snapshots.map((s) => (
                          <div className="connected-row" key={s.id}>
                            <div className="connected-grow">
                              <strong>Local snapshot #{s.id}</strong>
                              <small>{s.files} files · original bytes preserved</small>
                            </div>
                            <Button
                              disabled={working}
                              onClick={() =>
                                void run(async () => {
                                  const v = await controller.native!.local<{
                                    files: number;
                                    bytes: number;
                                  }>({ action: 'verify', fixture: fixtureId, snapshot: s.id });
                                  setNotice(
                                    `Backup verified: ${v.files} files, ${bytes(v.bytes)}.`,
                                  );
                                })
                              }
                            >
                              <ShieldCheck size={14} />
                              Verify backup
                            </Button>
                          </div>
                        ))}
                      </Panel>
                    )}
                  </>
                )}
                {page === 'activity' && (
                  <>
                    <div className="connected-toolbar">
                      <SearchBox
                        value={query}
                        change={setQuery}
                        placeholder="Search synchronization history…"
                      />
                      <select
                        aria-label="Synchronization status"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">All states</option>
                        <option value="complete">Synchronized</option>
                        <option value="offline">Waiting for connection</option>
                        <option value="attention">Needs attention</option>
                      </select>
                    </div>
                    <Panel title="Synchronization history">
                      {reportRows(filtered(jobs).filter(matchesJob))}
                      {!jobs.length && <Empty title="Nothing to show yet" />}
                      {next.jobs !== null && (
                        <Button onClick={() => void run(() => more('jobs'))}>
                          Load earlier jobs
                        </Button>
                      )}
                    </Panel>
                    <Panel title="Audit trail">
                      {filtered(events).map((e) => (
                        <details className="connected-audit" key={e.id}>
                          <summary>
                            <span className="connected-grow">
                              <strong>{e.type.replaceAll('.', ' · ')}</strong>
                              <small>
                                {date(e.createdAt)} · {e.actorKind} {short(e.actorId)}
                              </small>
                            </span>
                            <Badge>{e.outcome}</Badge>
                            <ChevronRight size={14} />
                          </summary>
                          <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                        </details>
                      ))}
                      {!events.length && <Empty title="No profile events yet" />}
                      {next.activity !== null && (
                        <Button onClick={() => void run(() => more('activity'))}>
                          Load earlier events
                        </Button>
                      )}
                    </Panel>
                  </>
                )}
                {page === 'conflicts' && (
                  <Panel title="Source-device reviews">
                    {reportRows(filtered(needsReview))}
                    {!needsReview.length && (
                      <Empty title="Nothing left unresolved">
                        New conflicts appear after a device compares its offline changes.
                      </Empty>
                    )}
                    <p className="connected-note">
                      Web choices are proposals. The source device validates them against fresh
                      local files and the current revision before you approve publication.
                    </p>
                  </Panel>
                )}
                {page === 'diff' && (
                  <>
                    <div className="connected-toolbar connected-comparison-controls">
                      <label>
                        Before
                        <select
                          aria-label="Before revision"
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                        >
                          <option value="">Choose revision</option>
                          {snapshots.map((s) => (
                            <option key={s.id} value={s.id}>
                              Revision #{s.revision}
                            </option>
                          ))}
                        </select>
                      </label>
                      <ArrowRight size={16} />
                      <label>
                        After
                        <select
                          aria-label="After revision"
                          value={to}
                          onChange={(e) => setTo(e.target.value)}
                        >
                          <option value="">Choose revision</option>
                          {snapshots.map((s) => (
                            <option key={s.id} value={s.id}>
                              Revision #{s.revision}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        variant="primary"
                        disabled={working || !from || !to || from === to}
                        onClick={() => void run(compare)}
                      >
                        Compare
                      </Button>
                    </div>
                    {comparison ? (
                      <Panel
                        title={`${diff.length} changed files`}
                        aside={<Badge>Verified manifest comparison</Badge>}
                      >
                        {filtered(diff).map((d) => (
                          <div className="connected-row" key={d.path}>
                            <FileCode2 size={16} className="muted" />
                            <div className="connected-grow">
                              <strong>
                                <bdi>{d.path}</bdi>
                              </strong>
                              <small>
                                {d.before ? bytes(d.before.size) : 'Absent'} →{' '}
                                {d.after ? bytes(d.after.size) : 'Absent'}
                              </small>
                            </div>
                            <Badge tone={d.kind === 'removed' ? 'warning' : 'accent'}>
                              {d.kind}
                            </Badge>
                            {d.before && (
                              <Button
                                variant="ghost"
                                disabled={working}
                                onClick={() => void run(() => showPreview(from, d.before!))}
                              >
                                Before
                              </Button>
                            )}
                            {d.after && (
                              <Button
                                variant="ghost"
                                disabled={working}
                                onClick={() => void run(() => showPreview(to, d.after!))}
                              >
                                After
                              </Button>
                            )}
                          </div>
                        ))}
                        {!diff.length && (
                          <Empty title="The same content">
                            These revisions contain identical file bytes.
                          </Empty>
                        )}
                      </Panel>
                    ) : (
                      <Empty title="Every detail, side by side">
                        Choose two published revisions to inspect additions, modifications and
                        deletions.
                      </Empty>
                    )}
                    {preview && (
                      <Panel title={preview.path} aside={<Badge>{bytes(preview.size)}</Badge>}>
                        {preview.kind === 'binary' ? (
                          <p className="connected-note">
                            Binary or non-UTF8 content. A text preview is unavailable.
                          </p>
                        ) : (
                          <pre className="connected-code">{preview.text}</pre>
                        )}
                        {preview.truncated && (
                          <p className="connected-note">
                            Preview limited to the first 64 KiB. Original stored bytes are
                            preserved.
                          </p>
                        )}
                      </Panel>
                    )}
                  </>
                )}
                {page === 'addons' && (
                  <Panel
                    title="Published addons"
                    aside={
                      head.snapshotId && (
                        <Button
                          disabled={working}
                          onClick={() =>
                            void run(async () =>
                              setHeadManifest(
                                (
                                  await controller.read<{ manifest: Manifest }>({
                                    view: 'snapshot',
                                    profile: profileId,
                                    snapshot: head.snapshotId!,
                                  })
                                ).manifest,
                              ),
                            )
                          }
                        >
                          Load current manifest
                        </Button>
                      )
                    }
                  >
                    {headManifest ? (
                      <>
                        <div className="connected-toolbar">
                          <SearchBox
                            value={query}
                            change={setQuery}
                            placeholder="Find an addon file…"
                          />
                        </div>
                        {filtered(headManifest.files.filter((f) => f.root === 'addons'))
                          .slice(0, 1000)
                          .map((f) => (
                            <div className="connected-row" key={key(f)}>
                              <Box size={17} />
                              <div className="connected-grow">
                                <strong>
                                  <bdi>{f.path}</bdi>
                                </strong>
                                <small>
                                  {f.path.split('/')[0]} · {short(f.hash)}
                                </small>
                              </div>
                              <span className="muted">{bytes(f.size)}</span>
                            </div>
                          ))}
                      </>
                    ) : (
                      <Empty
                        title={
                          head.revision ? 'Read your current setup' : 'No addon content published'
                        }
                      >
                        Addon names come from verified manifests. No files are executed.
                      </Empty>
                    )}
                  </Panel>
                )}
                {page === 'settings' && (
                  <>
                    <Panel title="Connection">
                      <div className="connected-row">
                        <LockKeyhole size={19} />
                        <div className="connected-grow">
                          <strong>{native?.connection?.origin ?? 'This HTTPS origin'}</strong>
                          <small>
                            {platform === 'desktop'
                              ? 'Device credentials are held by the operating system.'
                              : `Signed in as ${username}. Sessions use Secure, HttpOnly cookies.`}
                          </small>
                        </div>
                        <Badge tone="success">TLS verified</Badge>
                      </div>
                      {controller.write ? (
                        <Button
                          disabled={working}
                          onClick={() =>
                            void run(async () => {
                              await controller.write!('/api/v1/auth/logout', {});
                              setAuthenticated(false);
                              setProfiles([]);
                              setProfileId('');
                              setUsername('');
                            })
                          }
                        >
                          Sign out
                        </Button>
                      ) : (
                        <div className="connected-toolbar">
                          <Button
                            disabled={working}
                            onClick={() =>
                              void run(async () => {
                                await controller.native!.disconnect(false);
                                setAuthenticated(false);
                                setProfiles([]);
                                setNative(await controller.native!.status());
                              })
                            }
                          >
                            Revoke this device & disconnect
                          </Button>
                          <Button variant="ghost" onClick={() => setModal('forget')}>
                            Forget local credential…
                          </Button>
                        </div>
                      )}
                    </Panel>
                    <Panel title="Your safety settings">
                      <div className="connected-row">
                        <ShieldCheck size={18} />
                        <div className="connected-grow">
                          <strong>Manual synchronization</strong>
                          <small>
                            Compare, review, publish. Approve local application separately.
                          </small>
                        </div>
                        <Badge>Always on</Badge>
                      </div>
                      <div className="connected-row">
                        <Layers3 size={18} />
                        <div className="connected-grow">
                          <strong>Immutable recovery history</strong>
                          <small>
                            Snapshots and verified backups are retained. Automatic cleanup is
                            disabled.
                          </small>
                        </div>
                      </div>
                      <div className="connected-row">
                        <LockKeyhole size={18} />
                        <div className="connected-grow">
                          <strong>Synthetic installations only</strong>
                          <small>
                            Real World of Warcraft discovery and configuration files remain out of
                            scope.
                          </small>
                        </div>
                      </div>
                    </Panel>
                  </>
                )}
              </>
            )}
          </main>
          <footer className="workspace-footer">
            <span>
              <span className="status-dot" />{' '}
              {authenticated ? 'Authenticated workspace' : 'Self-hosted Attuner'}
            </span>
            <span>Synthetic data · Real local operations · No automatic apply</span>
          </footer>
        </div>
        {modal === 'profile' && (
          <Modal
            title="A new setup"
            description="Create an isolated synthetic profile for your devices."
            close={() => setModal(null)}
          >
            <form
              className="connected-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const name = String(form.get('name'));
                void run(async () => {
                  const result = await controller.write!<{ id: string }>(
                    '/api/v1/profiles',
                    { name },
                    crypto.randomUUID(),
                  );
                  await loadProfiles();
                  setProfileId(result.id);
                  setModal(null);
                });
              }}
            >
              <label>
                Profile name
                <input name="name" autoFocus required maxLength={80} placeholder="My interface" />
              </label>
              <div className="dialog-actions">
                <Button type="button" onClick={() => setModal(null)}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={busy}>
                  Create profile
                </Button>
              </div>
            </form>
          </Modal>
        )}
        {modal === 'revoke' && revoke && (
          <Modal
            title={`Revoke ${revoke.name}?`}
            description="This device will lose access immediately. Published snapshots remain preserved."
            close={() => setModal(null)}
          >
            <PasswordAction
              busy={busy}
              label="Revoke device"
              danger
              action={(password) =>
                void run(async () => {
                  await controller.write!('/api/v1/auth/reauthenticate', { password });
                  await controller.write!(`/api/v1/devices/${revoke.id}/revocations`, {});
                  setModal(null);
                  await refresh();
                })
              }
            />
          </Modal>
        )}
        {modal === 'forget' && (
          <Modal
            title="Forget this connection?"
            description="This removes the local credential. If the server is offline, its device grant remains active until you revoke it in the web dashboard."
            close={() => setModal(null)}
          >
            <div className="dialog-actions">
              <Button onClick={() => setModal(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() =>
                  void run(async () => {
                    await controller.native!.disconnect(true);
                    setAuthenticated(false);
                    setProfiles([]);
                    setNative(await controller.native!.status());
                    setModal(null);
                  })
                }
              >
                Forget local credential
              </Button>
            </div>
          </Modal>
        )}
        {modal === 'review' && (review || reviewJob) && (
          <Modal
            title={
              reviewJob?.state === 'awaitingApproval' || reviewJob?.state === 'remoteCommitted'
                ? 'Review synchronization'
                : 'Choose your versions'
            }
            description={
              reviewJob
                ? 'The native engine validates every choice. Original file bytes are preserved.'
                : 'Propose choices for the source device to validate. This does not publish or apply files.'
            }
            close={() => setModal(null)}
          >
            {proposals.map((proposal) => (
              <div className="connected-message" key={proposal.id}>
                <div className="connected-grow">
                  <strong>Proposal from {proposal.username}</strong>
                  <small>
                    {date(proposal.createdAt)} · {short(proposal.candidateManifestHash)}
                  </small>
                </div>
                {controller.native ? (
                  <Button
                    disabled={working}
                    onClick={() =>
                      void run(async () => {
                        await localAction({
                          action: 'acceptProposal',
                          job: reviewJob!.id,
                          proposal: proposal.id,
                        });
                        setModal(null);
                      })
                    }
                  >
                    Validate proposal
                  </Button>
                ) : (
                  <Button
                    disabled={working}
                    onClick={() =>
                      void run(async () => {
                        await controller.write!(
                          `/api/v1/profiles/${profileId}/proposals/${proposal.id}/withdrawals`,
                          {},
                        );
                        setProposals([]);
                        setNotice('Proposal withdrawn.');
                      })
                    }
                  >
                    Withdraw
                  </Button>
                )}
              </div>
            ))}
            <ConflictChoices
              conflicts={reviewJob?.conflicts ?? review!.conflicts}
              choices={choices}
              choose={choose}
            />
            {reviewJob && reviewJob.conflictTotal > reviewJob.conflicts.length && (
              <Button
                disabled={working}
                onClick={() =>
                  void run(async () => {
                    const result = await controller.native!.local<LocalJob>({
                      action: 'conflicts',
                      fixture: fixtureId,
                      job: reviewJob.id,
                      offset: reviewJob.conflicts.length,
                    });
                    if (result.generation !== reviewJob.generation)
                      throw new Error('The native comparison changed. Reopen the review.');
                    setReviewJob({
                      ...reviewJob,
                      conflicts: [...reviewJob.conflicts, ...result.conflicts],
                    });
                  })
                }
              >
                Load more conflicts
              </Button>
            )}
            {review?.nextOffset !== null && review?.nextOffset !== undefined && (
              <Button
                disabled={working}
                onClick={() =>
                  void run(async () => {
                    const result = await controller.read<ConflictReview>({
                      view: 'conflicts',
                      profile: profileId,
                      job: review.jobId,
                      offset: review.nextOffset!,
                    });
                    if (result.sourceGeneration !== review.sourceGeneration)
                      throw new Error('The source comparison changed. Reopen this review.');
                    setReview({ ...result, conflicts: [...review.conflicts, ...result.conflicts] });
                  })
                }
              >
                Load more conflicts
              </Button>
            )}
            <div className="dialog-actions">
              <Button onClick={() => setModal(null)}>Close</Button>
              <Button
                variant="primary"
                disabled={
                  working ||
                  readOnly ||
                  !!review?.nextOffset ||
                  (reviewJob ? reviewJob.conflictTotal > reviewJob.conflicts.length : false) ||
                  !(reviewJob?.conflicts ?? review?.conflicts ?? []).length ||
                  (reviewJob?.conflicts ?? review?.conflicts ?? []).some((c) => !choices[key(c)])
                }
                onClick={() =>
                  void run(async () => {
                    const list = reviewJob?.conflicts ?? review!.conflicts;
                    if (reviewJob)
                      await localAction({
                        action: 'resolve',
                        job: reviewJob.id,
                        decisions: decisions(list, choices),
                      });
                    else {
                      await controller.write!(
                        `/api/v1/profiles/${profileId}/jobs/${review!.jobId}/proposals`,
                        {
                          sourceGeneration: review!.sourceGeneration,
                          localManifestHash: review!.localManifestHash,
                          remoteHead: review!.remoteHead,
                          decisions: decisions(list, choices),
                        },
                      );
                      setNotice(
                        'Proposal saved. Validate it on the source device before publication.',
                      );
                      await refresh();
                    }
                    setModal(null);
                  })
                }
              >
                {reviewJob ? 'Validate choices' : 'Send proposal to device'}
              </Button>
            </div>
          </Modal>
        )}
      </div>
    </DialogError.Provider>
  );
}
function SearchBox({
  value,
  change,
  placeholder,
}: {
  value: string;
  change: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-field">
      <Search size={15} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
}
function PasswordAction({
  action,
  busy,
  label,
  danger = false,
}: {
  action: (password: string) => void;
  busy: boolean;
  label: string;
  danger?: boolean;
}) {
  return (
    <form
      className="connected-form"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const password = String(new FormData(form).get('password'));
        form.reset();
        action(password);
      }}
    >
      <label>
        Confirm your password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
        />
      </label>
      <div className="dialog-actions">
        <Button variant={danger ? 'danger' : 'primary'} disabled={busy}>
          {busy && <LoaderCircle size={14} className="spin" />}
          {label}
        </Button>
      </div>
    </form>
  );
}
function Login({
  controller,
  busy,
  run,
  onLogin,
}: {
  controller: ConnectedController;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  onLogin: (name: string) => Promise<void>;
}) {
  return (
    <section className="connected-welcome">
      <Brand small />
      <p className="eyebrow">WELCOME HOME</p>
      <h2>
        Your setup.
        <br />
        <span>Always yours.</span>
      </h2>
      <p>Sign in to your private Attuner workspace.</p>
      <form
        className="connected-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget,
            data = new FormData(form);
          const name = String(data.get('username')),
            password = String(data.get('password'));
          (form.elements.namedItem('password') as HTMLInputElement).value = '';
          void run(async () => {
            await controller.login!(name, password);
            await onLogin(name);
          });
        }}
      >
        <label>
          Username
          <input name="username" autoComplete="username" required maxLength={64} />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
          />
        </label>
        <Button variant="primary" disabled={busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <LockKeyhole size={15} />}Sign in
        </Button>
      </form>
      <small>Self-hosted accounts · No public registration</small>
      <a className="connected-demo-link" href="/?demo=1">
        Explore the labeled interface demo <ArrowRight size={12} />
      </a>
    </section>
  );
}
function Connection({
  controller,
  native,
  busy,
  run,
  connected,
}: {
  controller: ConnectedController;
  native: NativeStatus | undefined;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  connected: () => Promise<void>;
}) {
  const [origin, setOrigin] = useState(native?.connection?.origin ?? 'https://127.0.0.1:4318'),
    [ca, setCa] = useState(native?.connection?.ca ?? '');
  const [forget, setForget] = useState(false);
  const savedOrigin = native?.connection?.origin,
    savedCa = native?.connection?.ca;
  useEffect(() => {
    if (savedOrigin) {
      setOrigin(savedOrigin);
      setCa(savedCa ?? '');
    }
  }, [savedOrigin, savedCa]);
  return (
    <section className="connected-welcome connected-connect">
      <Brand small />
      <p className="eyebrow">YOUR DEVICES, IN HARMONY</p>
      <h2>
        A familiar setup.
        <br />
        <span>Wherever you play.</span>
      </h2>
      <p>Connect to your private Attuner server.</p>
      {native?.localSupported === false && (
        <p className="connected-note">
          Local file operations await Windows durability qualification. Device enrollment and remote
          management are available.
        </p>
      )}
      <form
        className="connected-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await controller.native!.connect(origin, ca);
            const status = await controller.native!.status();
            if (status.device?.enrolled) await connected();
            else await controller.native!.enroll('My desktop');
          });
        }}
      >
        <label>
          Server address
          <input
            type="url"
            required
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="https://attuner.example.com"
          />
        </label>
        <details>
          <summary>Custom certificate authority</summary>
          <label>
            Public CA certificate
            <textarea
              rows={4}
              value={ca}
              onChange={(e) => setCa(e.target.value)}
              maxLength={16384}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              placeholder="-----BEGIN CERTIFICATE-----"
            />
          </label>
        </details>
        <Button variant="primary" disabled={busy}>
          <LockKeyhole size={15} />
          {busy ? (
            <>
              <LoaderCircle size={15} className="spin" /> Connecting securely…
            </>
          ) : native?.device?.enrollmentPending ? (
            'Reopen device approval'
          ) : (
            'Connect device'
          )}
        </Button>
        {native?.device?.enrollmentPending && (
          <Button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await controller.native!.finish();
                await connected();
              })
            }
          >
            Finish approved enrollment
          </Button>
        )}
      </form>
      {busy && native?.progress?.phase && (
        <p role="status" className="connected-note">
          {native.progress.phase}
        </p>
      )}
      <small>Credentials stay in your operating system’s secure store.</small>
      {native?.connection && (
        <Button variant="ghost" disabled={busy} onClick={() => setForget(true)}>
          Forget saved connection…
        </Button>
      )}
      {forget && (
        <Modal
          title="Forget the saved connection?"
          description="Remove only this server’s local OS credential. Its remote device grant remains active until you revoke it in the dashboard."
          close={() => setForget(false)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setForget(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await controller.native!.disconnect(true);
                  setForget(false);
                  setCa('');
                })
              }
            >
              Forget local credential
            </Button>
          </div>
        </Modal>
      )}

      {!!native?.fixtures?.length && (
        <OfflineRecovery controller={controller} fixtures={native.fixtures} busy={busy} run={run} />
      )}
      {native?.error && <p role="alert">{native.error}</p>}
    </section>
  );
}
function LocalReview({
  readOnly = false,
  job,
  busy,
  action,
  review,
}: {
  readOnly?: boolean;
  job: LocalJob;
  busy: boolean;
  action: (action: Record<string, unknown>) => void;
  review: () => void;
}) {
  const [approval, setApproval] = useState<'publish' | 'apply' | null>(null);
  const reviewChanges = approval === 'publish' ? job.publicationChanges : job.changes;
  const reviewCount = approval === 'publish' ? job.publicationChangeCount : job.changeCount;
  return (
    <div className="connected-local-review">
      <div className="connected-row">
        <div className="connected-grow">
          <strong>{stateLabel(job.state)}</strong>
          <small>
            {job.localFiles ?? 0} captured files
            {job.candidateFiles !== null
              ? ` · ${job.candidateFiles} proposed files · ${job.changeCount} local changes`
              : ''}
          </small>
        </div>
        <Status state={'revokedAt' in job && job.revokedAt ? 'revoked' : job.state} />
      </div>
      {job.reason && <p className="connected-note connected-warning">{job.reason}</p>}
      {job.state === 'bootstrapReview' && (
        <div className="connected-toolbar">
          <Button disabled={busy} onClick={() => action({ action: 'bootstrap', choice: 'local' })}>
            Use this device’s setup
          </Button>
          {job.remoteHead?.revision !== 0 && (
            <Button
              disabled={busy}
              onClick={() => action({ action: 'bootstrap', choice: 'remote' })}
            >
              Use published setup
            </Button>
          )}
        </div>
      )}
      {job.state === 'conflictReview' && !('revokedAt' in job && job.revokedAt) && (
        <Button variant="primary" disabled={busy} onClick={review}>
          Review conflicts
        </Button>
      )}
      {job.state === 'awaitingApproval' && (
        <Button
          variant="primary"
          disabled={busy || readOnly}
          onClick={() => setApproval('publish')}
        >
          Review & publish
        </Button>
      )}
      {job.state === 'remoteCommitted' && (
        <Button variant="primary" disabled={busy} onClick={() => setApproval('apply')}>
          Review local application
        </Button>
      )}
      {['offline', 'transferring', 'publishing'].includes(job.state) &&
        job.resumeState !== 'acknowledgementPending' && (
          <div className="connected-toolbar">
            <Button disabled={busy} onClick={() => action({ action: 'resume' })}>
              Reconnect & compare
            </Button>
            {job.digest && (
              <Button
                disabled={busy}
                onClick={() => setApproval(job.publishedHead ? 'apply' : 'publish')}
              >
                Review interrupted {job.publishedHead ? 'application' : 'publication'}
              </Button>
            )}
          </div>
        )}
      {!['applying', 'recoveryRequired', 'acknowledgementPending', 'remoteCommitted'].includes(
        job.state,
      ) && (
        <Button variant="ghost" disabled={busy} onClick={() => action({ action: 'cancel' })}>
          Cancel comparison
        </Button>
      )}
      {approval && (
        <Modal
          title={
            approval === 'publish' ? 'Publish this revision?' : 'Apply to this synthetic setup?'
          }
          description={
            approval === 'publish'
              ? 'Publish the exact reviewed manifest as an immutable revision. Local files stay unchanged until a separate application approval.'
              : 'The native engine rechecks current local files, stages verified content and preserves rollback preimages before applying.'
          }
          close={() => setApproval(null)}
        >
          <div className="connected-review-summary">
            <span>
              Captured files <strong>{job.localFiles}</strong>
            </span>
            <span>
              Proposed files <strong>{job.candidateFiles}</strong>
            </span>
            <span>
              {approval === 'publish' ? 'Published changes' : 'Local changes'}{' '}
              <strong>{reviewCount}</strong>
            </span>
          </div>
          <div className="connected-review-files">
            {reviewChanges.map((c) => (
              <div className="connected-row" key={key(c)}>
                <bdi className="connected-grow">{key(c)}</bdi>
                <Badge tone={c.kind === 'removed' ? 'warning' : 'neutral'}>{c.kind}</Badge>
              </div>
            ))}
            {reviewCount > reviewChanges.length && (
              <p className="connected-note">
                Showing the first {reviewChanges.length} of {reviewCount} changes.
              </p>
            )}
          </div>
          <details className="connected-note">
            <summary>Capture integrity</summary>
            <code>{job.digest}</code>
          </details>
          <div className="dialog-actions">
            <Button onClick={() => setApproval(null)}>Go back</Button>
            <Button
              variant="primary"
              disabled={busy || !job.digest}
              onClick={() => {
                setApproval(null);
                action({ action: approval, digest: job.digest });
              }}
            >
              {approval === 'publish' ? 'Approve publication' : 'Approve local application'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function Enrollment({
  controller,
  id,
  profiles,
  busy,
  run,
}: {
  controller: ConnectedController;
  id: string;
  profiles: Profile[];
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const [request, setRequest] = useState<{
      deviceName: string;
      os: string;
      clientVersion: string;
      thumbprint: string;
      state: string;
    }>(),
    [error, setError] = useState(''),
    [grants, setGrants] = useState<Record<string, 'read' | 'write'>>({}),
    [redirect, setRedirect] = useState(''),
    [denied, setDenied] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/auth/enrollments/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            'This enrollment expired or is unavailable. Start again on your desktop.',
          );
        return r.json() as Promise<NonNullable<typeof request>>;
      })
      .then((r) => {
        if (active) setRequest(r);
      })
      .catch((e) => {
        if (active) setError(reason(e));
      });
    return () => {
      active = false;
    };
  }, [id]);
  if (error) return <Empty title="Enrollment unavailable">{error}</Empty>;
  if (redirect)
    return (
      <div className="connected-welcome">
        <CircleCheck size={32} />
        <h2>Device approved.</h2>
        <p>Return to Attuner to finish the secure exchange.</p>
        <a className="button button-primary" href={redirect}>
          Return to Attuner <ArrowRight size={15} />
        </a>
      </div>
    );
  if (denied) return <Empty title="Request denied">This device was not granted access.</Empty>;
  return (
    <Panel
      title={request?.deviceName ?? 'Reading device request…'}
      aside={<Badge tone="accent">Device enrollment</Badge>}
    >
      {request && (
        <>
          <p className="connected-note">
            {request.os} · Attuner {request.clientVersion} · Proof key{' '}
            <code>{short(request.thumbprint)}</code>
          </p>
          <h3 className="connected-subheading">Choose profile access</h3>
          {profiles.map((p) => (
            <div className="connected-row" key={p.id}>
              <strong className="connected-grow">{p.name}</strong>
              <select
                aria-label={`Access to ${p.name}`}
                value={grants[p.id] ?? ''}
                onChange={(e) =>
                  setGrants((old) => {
                    const next = { ...old };
                    if (!e.target.value) delete next[p.id];
                    else next[p.id] = e.target.value as 'read' | 'write';
                    return next;
                  })
                }
              >
                <option value="">No access</option>
                <option value="read">Read snapshots</option>
                {['owner', 'writer'].includes(p.role ?? '') && (
                  <option value="write">Read & publish</option>
                )}
              </select>
            </div>
          ))}
          {!profiles.length && (
            <p className="connected-note">Create a profile before approving this device.</p>
          )}
          <PasswordAction
            busy={busy || !Object.keys(grants).length}
            label="Approve device"
            action={(password) =>
              void run(async () => {
                await controller.write!('/api/v1/auth/reauthenticate', { password });
                const result = await controller.write!<{ redirectUri: string }>(
                  `/api/v1/auth/enrollments/${id}/decision`,
                  {
                    approve: true,
                    grants: Object.entries(grants).map(([profileId, permission]) => ({
                      profileId,
                      permission,
                    })),
                  },
                );
                if (!result.redirectUri.startsWith('app.attuner.desktop:/enrollment?'))
                  throw new Error('Unexpected enrollment response.');
                setRedirect(result.redirectUri);
              })
            }
          />
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await controller.write!(`/api/v1/auth/enrollments/${id}/decision`, {
                  approve: false,
                });
                setDenied(true);
              })
            }
          >
            Deny request
          </Button>
        </>
      )}
    </Panel>
  );
}

function OfflineRecovery({
  controller,
  fixtures,
  busy,
  run,
}: {
  controller: ConnectedController;
  fixtures: NonNullable<NativeStatus['fixtures']>;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const [id, setId] = useState(fixtures[0]?.id ?? ''),
    [inspection, setInspection] = useState<LocalInspection>(),
    [verified, setVerified] = useState('');
  return (
    <details className="connected-offline">
      <summary>Local recovery · available offline</summary>
      <p className="connected-note">
        Inspect preserved synthetic snapshots or recover an interrupted operation without contacting
        the server.
      </p>
      <select
        aria-label="Recovery workspace"
        value={id}
        onChange={(e) => {
          setId(e.target.value);
          setInspection(undefined);
        }}
      >
        {fixtures.map((f, i) => (
          <option key={f.id} value={f.id}>
            Synthetic setup {i + 1} · {f.id.slice(0, 8)}
          </option>
        ))}
      </select>
      <Button
        disabled={busy}
        onClick={() =>
          void run(async () =>
            setInspection(await controller.native!.local({ action: 'inspect', fixture: id })),
          )
        }
      >
        Inspect local history
      </Button>
      {inspection?.operations
        .filter((op) => !['committed', 'rolledBack'].includes(op.state))
        .map((op) => (
          <div className="connected-row" key={op.id}>
            <span className="connected-grow">
              Operation #{op.id} · {op.state}
            </span>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setInspection(
                    await controller.native!.local({
                      action: 'recover',
                      fixture: id,
                      operation: op.id,
                    }),
                  ),
                )
              }
            >
              Recover safely
            </Button>
          </div>
        ))}
      {inspection?.snapshots.map((s) => (
        <div className="connected-row" key={s.id}>
          <span className="connected-grow">
            Snapshot #{s.id} · {s.files} files
          </span>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await controller.native!.local({ action: 'verify', fixture: id, snapshot: s.id });
                setVerified(`Snapshot #${s.id} verified.`);
              })
            }
          >
            Verify backup
          </Button>
        </div>
      ))}
      {verified && (
        <p role="status" className="connected-note">
          {verified}
        </p>
      )}
    </details>
  );
}
