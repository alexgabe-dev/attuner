'use client';
import { useEffect, useReducer, useRef, useState, type ComponentType } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  FileCode2,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  History,
  House,
  Laptop,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  WifiOff,
  X,
} from 'lucide-react';
import {
  activity,
  addons,
  demoClock,
  demoReducer,
  formatRevision,
  getDevices,
  matchesSearch,
  pageLabels,
  pages,
  scenarioContent,
  scenarioLabels,
  scenarios,
  snapshots,
  type ActivityEvent,
  type Device,
  type Page,
  type Scenario,
  type Tone,
} from '@attuner/shared';
import { Badge, Brand, Button } from './primitives';
import { DiffView } from './views/diff-view';
const icons: Record<Page, ComponentType<{ size?: number; className?: string }>> = {
  overview: House,
  activity: History,
  snapshots: Layers3,
  diff: ArrowLeftRight,
  conflicts: TriangleAlert,
  addons: Box,
  devices: Monitor,
  settings: Settings2,
};
const descriptions: Record<Page, string> = {
  overview: 'Your WoW setup, at a glance.',
  activity: 'Every change has a story. Here’s yours.',
  snapshots: 'A little peace of mind, saved in every revision.',
  diff: 'The details between one setup and the next.',
  conflicts: 'Keep the changes you want. Preserve everything else.',
  addons: 'All the pieces that make your interface yours.',
  devices: 'One familiar setup, wherever you play.',
  settings: 'A few thoughtful defaults. Room to make them yours.',
};
const eventIcons = {
  sync: RefreshCw,
  modified: FileCode2,
  added: Plus,
  snapshot: ShieldCheck,
  conflict: TriangleAlert,
};
const eventTones: Record<ActivityEvent['type'], Tone> = {
  sync: 'success',
  modified: 'accent',
  added: 'success',
  snapshot: 'neutral',
  conflict: 'warning',
};
const initialSettings = {
  compact: false,
  notifications: true,
  reduceMotion: false,
  retention: '30 days',
};
type Settings = typeof initialSettings;
type Modal =
  'commands' | 'profile' | 'event' | 'device' | 'pair' | 'restore' | 'resolve' | 'about' | null;
function OsIcon({ kind }: { kind: 'windows' | 'mac' }) {
  return kind === 'windows' ? (
    <svg viewBox="0 0 24 24" aria-label="Windows" role="img" className="windows-icon">
      <path
        fill="currentColor"
        d="m2 5 8-1v7H2V5Zm10-1 10-2v9H12V4ZM2 13h8v7l-8-1v-6Zm10 0h10v9l-10-2v-7Z"
      />
    </svg>
  ) : (
    <Laptop size={23} aria-label="Mac" />
  );
}
function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <Search size={25} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function SectionTitle({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {aside}
    </div>
  );
}
export function Workbench({
  platform,
  page: controlledPage = 'overview',
  onNavigate,
  initialScenario = 'synchronized',
  nativeVersion,
  localEngine,
}: {
  platform: 'web' | 'desktop';
  page?: Page;
  onNavigate?: (page: Page) => void;
  initialScenario?: Scenario;
  nativeVersion?: string;
  localEngine?: React.ReactNode;
}) {
  const [localView, setLocalView] = useState(false);
  const [localPage, setLocalPage] = useState<Page>(controlledPage);
  const page = onNavigate ? controlledPage : localPage;
  const [state, dispatch] = useReducer(demoReducer, {
    scenario: initialScenario,
    resolved: false,
    syncCount: 0,
  });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const dialogReturnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setMobileViewport(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobileOpen || !mobileViewport) return;
    const previous = document.activeElement as HTMLElement;
    const nav = navRef.current;
    const elements = () => Array.from(nav?.querySelectorAll<HTMLElement>('button,a[href]') ?? []);
    elements()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
      if (event.key === 'Tab') {
        const items = elements();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [mobileOpen, mobileViewport]);
  const [modal, setModal] = useState<Modal>(null);
  const [query, setQuery] = useState('');
  const [commandQuery, setCommandQuery] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [category, setCategory] = useState('all');
  const [selectedEvent, setSelectedEvent] = useState<ActivityEvent>(activity[0]!);
  const [selectedDevice, setSelectedDevice] = useState<Device>(getDevices('synchronized')[0]!);
  const [restoreRevision, setRestoreRevision] = useState(4891);
  const [compare, setCompare] = useState<number[]>([4891, 4892]);
  const [diffFrom, setDiffFrom] = useState(4891);
  const [diffTo, setDiffTo] = useState(4892);
  const [diffFile, setDiffFile] = useState('WeakAuras.lua');
  const [diffMode, setDiffMode] = useState<'split' | 'unified'>('split');
  const [diffQuery, setDiffQuery] = useState('');
  useEffect(() => {
    if (window.matchMedia('(max-width: 767px)').matches) setDiffMode('unified');
  }, []);
  const [resolveChoice, setResolveChoice] = useState<'main' | 'macbook'>('main');
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [draft, setDraft] = useState<Settings>(initialSettings);
  const [toast, setToast] = useState('');
  const [stage, setStage] = useState<'idle' | 'scanning' | 'transferring' | 'verifying'>('idle');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busy = stage !== 'idle';
  const content = scenarioContent[state.scenario];
  const devices = getDevices(state.scenario);
  const conflict = state.scenario === 'conflict';
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);
  const notify = (message: string) => setToast(message);
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setModal((m) => (m === 'commands' ? null : 'commands'));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  function navigate(next: Page) {
    setMobileOpen(false);
    setModal(null);
    setQuery('');
    setLocalPage(next);
    onNavigate?.(next);
  }
  function changeScenario(scenario: Scenario) {
    dispatch({ type: 'scenario', scenario });
    setToast('');
  }
  function sync() {
    if (conflict) {
      navigate('conflicts');
      return;
    }
    clearTimers();
    setStage('scanning');
    timers.current = [
      setTimeout(() => setStage('transferring'), 600),
      setTimeout(() => setStage('verifying'), 1300),
      setTimeout(() => {
        dispatch({ type: 'sync' });
        setStage('idle');
        if (settings.notifications)
          notify(
            state.scenario === 'offline'
              ? 'Demo check complete. MacBook Pro is still offline.'
              : 'Demo complete. Both fixture devices are up to date.',
          );
      }, 2100),
    ];
  }
  function cancel() {
    clearTimers();
    setStage('idle');
    notify('Demo stopped. No files were changed.');
  }
  function compareSelected() {
    const sorted = [...compare].sort((a, b) => a - b);
    if (sorted.length === 2) {
      setDiffFrom(sorted[0]!);
      setDiffTo(sorted[1]!);
      navigate('diff');
    }
  }
  function showDevice(device: Device) {
    setSelectedDevice(device);
    setModal('device');
  }
  const visibleActivity = activity.filter(
    (e) =>
      (deviceFilter === 'all' || e.device === deviceFilter) &&
      (typeFilter === 'all' || e.type === typeFilter) &&
      matchesSearch([e.title, e.path, e.device], query),
  );
  const visibleAddons = addons.filter(
    (a) =>
      (category === 'all' || a.category === category) &&
      matchesSearch([a.name, a.version, a.category], query),
  );
  const headerActions =
    page === 'overview' ? (
      <Button variant="primary" onClick={sync} disabled={busy}>
        {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{' '}
        {busy
          ? 'Synchronizing…'
          : conflict
            ? 'Review conflict'
            : state.scenario === 'error'
              ? 'Retry demo'
              : 'Sync demo'}
      </Button>
    ) : page === 'snapshots' ? (
      <Button variant="primary" disabled={compare.length !== 2} onClick={compareSelected}>
        <ArrowLeftRight size={15} />
        Compare {compare.length === 2 ? 'selected' : '2 revisions'}
      </Button>
    ) : page === 'devices' ? (
      <Button onClick={() => setModal('pair')}>
        <Plus size={15} />
        Pairing preview
      </Button>
    ) : page === 'settings' ? (
      <Button
        variant="primary"
        disabled={!changed}
        onClick={() => {
          setSettings(draft);
          notify('Demo preferences saved for this session.');
        }}
      >
        <Check size={15} />
        Save preferences
      </Button>
    ) : null;
  const modalTitle =
    modal === 'commands'
      ? 'Where would you like to go?'
      : modal === 'profile'
        ? 'Your synchronization profile'
        : modal === 'event'
          ? selectedEvent.title
          : modal === 'device'
            ? selectedDevice.name
            : modal === 'pair'
              ? 'Bring another device along'
              : modal === 'restore'
                ? `Restore ${formatRevision(restoreRevision)}`
                : modal === 'resolve'
                  ? 'Keep the version that feels right'
                  : modal === 'about'
                    ? 'A foundation, thoughtfully built.'
                    : '';
  return (
    <div
      className={`app-shell platform-${platform} ${settings.compact ? 'compact' : ''}`}
      data-reduced-motion={settings.reduceMotion ? 'true' : undefined}
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobileOpen && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        ref={navRef}
        inert={mobileViewport && !mobileOpen}
        className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}
        aria-label="Main navigation"
      >
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button className="profile-switcher" onClick={() => setModal('profile')}>
          <span className="profile-icon">
            <Layers3 size={17} />
          </span>
          <span>
            <strong>WoW Forever</strong>
            <small>Personal profile</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {pages
            .filter((p) => p !== 'settings')
            .map((p) => {
              const Icon = icons[p];
              return (
                <a
                  key={p}
                  href={platform === 'web' ? `/${p === 'overview' ? '' : p}` : `#${p}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(p);
                  }}
                  className={`nav-item ${page === p ? 'nav-active' : ''}`}
                  aria-current={page === p ? 'page' : undefined}
                >
                  <Icon size={17} />
                  <span>{pageLabels[p]}</span>
                  {p === 'conflicts' && conflict ? (
                    <span className="nav-count warning-count">1</span>
                  ) : p === 'addons' ? (
                    <span className="nav-count">132</span>
                  ) : p === 'devices' ? (
                    <span className="nav-count">2</span>
                  ) : null}
                </a>
              );
            })}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-note">
            <ShieldCheck size={16} />
            <span>
              Your setup. Your server.<small>Private by design.</small>
            </span>
          </div>
          <a
            href={platform === 'web' ? '/settings' : '#settings'}
            onClick={(e) => {
              e.preventDefault();
              navigate('settings');
            }}
            className={`nav-item ${page === 'settings' ? 'nav-active' : ''}`}
            aria-current={page === 'settings' ? 'page' : undefined}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </a>
          <button className="sidebar-version" onClick={() => setModal('about')}>
            <span className="small-logo">
              <Brand small />
            </span>
            <span>
              Attuner <span className="muted">v{nativeVersion ?? '0.1.0'}</span>
            </span>
            <span className="version-label">PREVIEW</span>
          </button>
        </div>
      </aside>
      <div className="workspace" inert={mobileViewport && mobileOpen}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-workspace">Personal workspace</span>
            <ChevronRight size={13} />
            <span>WoW Forever</span>
            <Badge tone="neutral">Demo</Badge>
          </div>
          <div className="topbar-right">
            <span className="topbar-private">
              <LockKeyhole size={12} />
              Self-hosted
            </span>
            <button
              className="command-trigger"
              aria-label="Open command menu"
              onClick={() => setModal('commands')}
            >
              <Search size={15} />
              <kbd>{platform === 'desktop' ? '⌘' : '⌘ / Ctrl'} K</kbd>
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR WOW SETUP. EVERYWHERE.</div>
              <h1>{pageLabels[page]}</h1>
              <p>
                {page === 'overview' && localView
                  ? 'Real local operations. Safely confined to synthetic files.'
                  : descriptions[page]}
              </p>
            </div>
            <div className="heading-actions">
              {page === 'overview' && localView ? null : headerActions}
            </div>
          </div>
          {page === 'overview' && localEngine && (
            <div className="segmented lab-view-switch" aria-label="Overview data source">
              <button aria-pressed={!localView} onClick={() => setLocalView(false)}>
                Remote demo
              </button>
              <button aria-pressed={localView} onClick={() => setLocalView(true)}>
                Local engine
              </button>
            </div>
          )}
          {page === 'overview' && localView ? (
            localEngine
          ) : (
            <>
              <div className="demo-toolbar">
                <span>
                  <span className="demo-indicator" />
                  <span className="demo-name">Interactive preview</span>
                  <span className="demo-explanation">
                    {' '}
                    · Isolated fixture data. No game files connected.
                  </span>
                </span>
                <label>
                  <span>Scenario</span>
                  <select
                    aria-label="Demo scenario"
                    value={state.scenario}
                    disabled={busy || !hydrated}
                    onChange={(e) => changeScenario(e.target.value as Scenario)}
                  >
                    {scenarios.map((s) => (
                      <option value={s} key={s}>
                        {scenarioLabels[s]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
          {page === 'overview' && !localView && (
            <>
              <section
                className={`sync-status status-${content.tone}`}
                aria-label="Synchronization status"
              >
                <div className={`status-symbol tone-${content.tone}`}>
                  {busy ? (
                    <RefreshCw size={28} className="spin" />
                  ) : state.scenario === 'synchronized' ? (
                    <Check size={30} strokeWidth={2} />
                  ) : state.scenario === 'offline' ? (
                    <WifiOff size={26} />
                  ) : (
                    <TriangleAlert size={27} />
                  )}
                </div>
                <div className="status-copy">
                  <div className="status-title-line">
                    <h2>
                      {busy
                        ? {
                            scanning: 'Checking your fixture files…',
                            transferring: 'Bringing the demo up to date…',
                            verifying: 'Verifying the demonstration…',
                          }[stage as 'scanning' | 'transferring' | 'verifying']
                        : content.title}
                    </h2>
                    <Badge tone={content.tone} dot>
                      {busy ? 'In progress' : content.status}
                    </Badge>
                  </div>
                  <p>{content.description}</p>
                  <span className="readiness">
                    <ShieldCheck size={13} />
                    {content.readiness}
                  </span>
                </div>
                <div className="status-side">
                  {busy ? (
                    <>
                      <div className="progress-track">
                        <div
                          style={{
                            width:
                              stage === 'scanning'
                                ? '25%'
                                : stage === 'transferring'
                                  ? '65%'
                                  : '92%',
                          }}
                        />
                      </div>
                      <button className="text-button" onClick={cancel}>
                        Stop demo
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="micro-label">CURRENT REVISION</span>
                      <span className="revision-big">#4,892</span>
                      <span className="subtle-meta">
                        <Clock3 size={12} />2 minutes ago
                      </span>
                    </>
                  )}
                </div>
              </section>
              <section className="installation-panel" aria-label="World of Warcraft installation">
                <div className="installation-top">
                  <div className="game-icon">
                    <Sparkles size={25} strokeWidth={1.4} />
                  </div>
                  <div className="installation-identity">
                    <h2>
                      World of Warcraft <span>Forever</span>
                    </h2>
                    <span className="path-text">
                      {platform === 'desktop'
                        ? '/Fixtures/World of Warcraft/'
                        : 'Fixtures / World of Warcraft /'}
                    </span>
                  </div>
                  <Badge tone="neutral">
                    <Folder size={12} />
                    Fixture installation
                  </Badge>
                  <button
                    className="icon-button"
                    aria-label="View installation settings"
                    onClick={() => navigate('settings')}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                </div>
                <div className="installation-stats">
                  <div>
                    <Box size={19} />
                    <span>
                      <small>Addons</small>
                      <strong>
                        132 <em>in illustrated setup</em>
                      </strong>
                    </span>
                  </div>
                  <div>
                    <HardDrive size={19} />
                    <span>
                      <small>Configuration size</small>
                      <strong>
                        1.42 <em>GB</em>
                      </strong>
                    </span>
                  </div>
                  <div>
                    <Monitor size={19} />
                    <span>
                      <small>Devices</small>
                      <strong>
                        2{' '}
                        <em>{state.scenario === 'offline' ? '1 offline' : 'connected fixtures'}</em>
                      </strong>
                    </span>
                  </div>
                  <div>
                    <GitBranch size={19} />
                    <span>
                      <small>Pending changes</small>
                      <strong className={content.pending ? 'text-warning' : ''}>
                        {content.pending}{' '}
                        <em>{content.pending ? 'files to review' : 'all clear'}</em>
                      </strong>
                    </span>
                  </div>
                </div>
              </section>
              <div className="overview-columns">
                <section className="content-panel activity-panel">
                  <SectionTitle
                    title="Recent activity"
                    aside={
                      <button className="text-button" onClick={() => navigate('activity')}>
                        View all
                        <ArrowUpRight size={13} />
                      </button>
                    }
                  />
                  <div className="activity-list">
                    {activity.slice(0, 4).map((event) => {
                      const Icon = eventIcons[event.type];
                      return (
                        <button
                          className="activity-row"
                          key={event.id}
                          onClick={() => {
                            setSelectedEvent(event);
                            setModal('event');
                          }}
                        >
                          <span className={`event-icon tone-${eventTones[event.type]}`}>
                            <Icon size={17} />
                          </span>
                          <span className="activity-copy">
                            <strong>{event.title}</strong>
                            <span>
                              {event.device}
                              <span className="inline-dot">·</span>
                              {event.detail}
                            </span>
                          </span>
                          <time>{event.time}</time>
                        </button>
                      );
                    })}
                  </div>
                  <div className="panel-footnote">
                    <ShieldCheck size={13} />
                    Every change starts with a restore point.
                  </div>
                </section>
                <section className="content-panel devices-panel">
                  <SectionTitle
                    title="Your devices"
                    aside={<span className="section-count">02</span>}
                  />
                  <div>
                    {devices.map((device) => (
                      <button
                        key={device.id}
                        className="device-overview-row"
                        onClick={() => showDevice(device)}
                      >
                        <span className={`os-icon os-${device.kind}`}>
                          <OsIcon kind={device.kind} />
                        </span>
                        <span className="device-copy">
                          <strong>{device.name}</strong>
                          <span>
                            {device.os}
                            <span className="inline-dot">·</span>
                            {device.online ? 'Online' : 'Offline'}
                          </span>
                        </span>
                        <Badge tone={device.tone} dot>
                          {device.status}
                        </Badge>
                      </button>
                    ))}
                  </div>
                  <button className="device-manage text-button" onClick={() => navigate('devices')}>
                    Manage devices
                    <ArrowRight size={14} />
                  </button>
                  <div className="device-note">
                    <LockKeyhole size={13} />
                    <p>Only paired devices can access your configuration.</p>
                  </div>
                </section>
              </div>
              <div className="quiet-footer">
                <span>
                  <CheckCheck size={14} />
                  Built around your peace of mind.
                </span>
                <button className="text-button" onClick={() => navigate('snapshots')}>
                  Explore your snapshots
                  <ArrowRight size={13} />
                </button>
              </div>
            </>
          )}
          {page === 'activity' && (
            <section className="content-panel explorer-panel">
              <div className="filter-bar">
                <label className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="Search activity"
                    placeholder="Search activity, files, or devices…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Filter by device"
                  value={deviceFilter}
                  onChange={(e) => setDeviceFilter(e.target.value)}
                >
                  <option value="all">All devices</option>
                  <option>Main PC</option>
                  <option>MacBook Pro</option>
                </select>
                <select
                  aria-label="Filter by event type"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                >
                  <option value="all">All events</option>
                  <option value="sync">Synchronization</option>
                  <option value="modified">Modified files</option>
                  <option value="added">Added addons</option>
                  <option value="snapshot">Restore points</option>
                </select>
              </div>
              <div className="list-subheading">
                <span>TODAY · NOVEMBER 3, 2026</span>
                <span>{visibleActivity.length} events</span>
              </div>
              {visibleActivity.length ? (
                visibleActivity.map((event) => {
                  const Icon = eventIcons[event.type];
                  return (
                    <button
                      className="activity-row explorer-activity"
                      key={event.id}
                      onClick={() => {
                        setSelectedEvent(event);
                        setModal('event');
                      }}
                    >
                      <span className={`event-icon tone-${eventTones[event.type]}`}>
                        <Icon size={17} />
                      </span>
                      <span className="activity-copy">
                        <strong>{event.title}</strong>
                        <span>
                          {event.device}
                          <span className="inline-dot">·</span>
                          {event.detail}
                        </span>
                      </span>
                      <span className="event-revision">{formatRevision(event.after)}</span>
                      <time>{event.time}</time>
                      <ChevronRight size={14} />
                    </button>
                  );
                })
              ) : (
                <Empty title="No matching activity">
                  Try another file name or clear your filters.
                  <br />
                  <button
                    className="text-button"
                    onClick={() => {
                      setQuery('');
                      setDeviceFilter('all');
                      setTypeFilter('all');
                    }}
                  >
                    Clear filters
                  </button>
                </Empty>
              )}
            </section>
          )}
          {page === 'snapshots' && (
            <section className="content-panel explorer-panel">
              <div className="snapshot-intro">
                <ShieldCheck size={20} />
                <p>
                  Immutable by design.
                  <span>
                    Select two revisions to see what changed. Restoring will create a new revision.
                  </span>
                </p>
                <Badge>6 fixture snapshots</Badge>
              </div>
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Snapshot history table"
              >
                <table>
                  <thead>
                    <tr>
                      <th>
                        <span className="sr-only">Select for comparison</span>
                      </th>
                      <th>Revision</th>
                      <th>Created</th>
                      <th>Source device</th>
                      <th>Changes</th>
                      <th>Transferred</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.map((snapshot, index) => (
                      <tr key={snapshot.revision}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Compare revision ${snapshot.revision}`}
                            checked={compare.includes(snapshot.revision)}
                            disabled={compare.length === 2 && !compare.includes(snapshot.revision)}
                            onChange={(e) =>
                              setCompare(
                                e.target.checked
                                  ? [...compare, snapshot.revision]
                                  : compare.filter((n) => n !== snapshot.revision),
                              )
                            }
                          />
                        </td>
                        <td>
                          <span className="revision-cell">
                            <GitCommitHorizontal size={16} />
                            <strong>{formatRevision(snapshot.revision)}</strong>
                            {index === 0 && <Badge tone="accent">Head</Badge>}
                          </span>
                        </td>
                        <td>{snapshot.time}</td>
                        <td>{snapshot.device}</td>
                        <td>{snapshot.files} files</td>
                        <td className="mono">{snapshot.size}</td>
                        <td>
                          <button
                            className="text-button"
                            aria-label={`Preview restore revision ${snapshot.revision}`}
                            onClick={() => {
                              setRestoreRevision(snapshot.revision);
                              setModal('restore');
                            }}
                          >
                            Preview restore
                            <ArrowUpRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel-footnote">
                <History size={13} />
                Fixed demo clock: November 3, 2026, 18:44 CET.
              </div>
            </section>
          )}
          {page === 'diff' && (
            <DiffView
              from={diffFrom}
              to={diffTo}
              setFrom={setDiffFrom}
              setTo={setDiffTo}
              file={diffFile}
              setFile={setDiffFile}
              mode={diffMode}
              setMode={setDiffMode}
              query={diffQuery}
              setQuery={setDiffQuery}
            />
          )}
          {page === 'conflicts' &&
            (conflict ? (
              <>
                <div className="attention-banner">
                  <TriangleAlert size={18} />
                  <span>
                    <strong>One file needs your attention.</strong> No competing version has been
                    overwritten.
                  </span>
                  <Badge tone="warning">1 conflict</Badge>
                </div>
                <section className="content-panel conflict-detail">
                  <div className="conflict-header">
                    <span className="file-icon">
                      <FileCode2 size={22} />
                    </span>
                    <div>
                      <h2>WeakAuras.lua</h2>
                      <p className="mono">Account / DEMO / SavedVariables</p>
                    </div>
                    <Badge tone="warning">Modified on both devices</Badge>
                  </div>
                  <div className="conflict-variants">
                    {devices.map((device) => (
                      <div key={device.id}>
                        <span className={`os-icon os-${device.kind}`}>
                          <OsIcon kind={device.kind} />
                        </span>
                        <h3>{device.name}</h3>
                        <span className="mono">
                          {formatRevision(device.id === 'main' ? 4892 : 4891)}
                        </span>
                        <p>
                          {device.id === 'main'
                            ? 'Icon size changed to 52.'
                            : 'Icon size changed to 48.'}
                        </p>
                        <Badge tone="neutral">
                          <ShieldCheck size={12} />
                          Version preserved
                        </Badge>
                      </div>
                    ))}
                  </div>
                  <div className="conflict-actions">
                    <Button
                      onClick={() => {
                        setDiffFile('WeakAuras.lua');
                        navigate('diff');
                      }}
                    >
                      <ArrowLeftRight size={15} />
                      Compare versions
                    </Button>
                    <Button variant="primary" onClick={() => setModal('resolve')}>
                      Resolve in demo
                      <ArrowRight size={15} />
                    </Button>
                  </div>
                </section>
              </>
            ) : (
              <section className="content-panel clear-state">
                <span className="clear-icon">
                  <CheckCheck size={30} />
                </span>
                <h2>
                  {state.resolved
                    ? 'A decision made. Both versions kept.'
                    : 'Nothing pulling your setup apart.'}
                </h2>
                <p>
                  {state.resolved
                    ? 'Your demo choice is reflected in the overview. Original fixture contents remain unchanged.'
                    : 'There are no conflicts in this scenario. Your configuration has one clear path forward.'}
                </p>
                <Button onClick={() => changeScenario('conflict')}>
                  Explore a conflict scenario
                  <ArrowRight size={15} />
                </Button>
              </section>
            ))}
          {page === 'addons' && (
            <section className="content-panel explorer-panel">
              <div className="filter-bar">
                <label className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="Search addons"
                    placeholder="Find an addon…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Filter addon category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="all">All categories</option>
                  {['Interface', 'Combat', 'Inventory', 'Utilities'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <Badge>8 curated fixtures</Badge>
              </div>
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Addon inventory table"
              >
                <table className="addon-table">
                  <thead>
                    <tr>
                      <th>Addon</th>
                      <th>Version</th>
                      <th>Size</th>
                      <th>Available on</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAddons.map((addon) => (
                      <tr key={addon.name}>
                        <td>
                          <span className="addon-name">
                            <span className={`addon-icon addon-${addon.color}`}>
                              {addon.initials}
                            </span>
                            <span>
                              <strong>{addon.name}</strong>
                              <small>{addon.category}</small>
                            </span>
                          </span>
                        </td>
                        <td className="mono">{addon.version}</td>
                        <td>{addon.size}</td>
                        <td>
                          <span className="availability">
                            <Monitor size={14} />
                            <Laptop size={14} />
                            <span>Both devices</span>
                          </span>
                        </td>
                        <td>
                          <Badge
                            tone={conflict && addon.name === 'WeakAuras' ? 'warning' : 'success'}
                            dot
                          >
                            {conflict && addon.name === 'WeakAuras' ? 'Conflict' : 'Matching'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!visibleAddons.length && (
                <Empty title="No addons found">Try another name or category.</Empty>
              )}
              <div className="panel-footnote">
                <Box size={13} />
                Showing {visibleAddons.length} curated fixture addons from the illustrated 132-addon
                setup. Versions are sample data.
              </div>
            </section>
          )}
          {page === 'devices' && (
            <>
              <section className="content-panel explorer-panel">
                <SectionTitle
                  title="Paired devices"
                  aside={<span className="muted">2 fixture devices</span>}
                />
                <div className="device-table">
                  <div className="device-table-header">
                    <span>DEVICE</span>
                    <span>REVISION</span>
                    <span>LAST SEEN</span>
                    <span>SYNC STATUS</span>
                    <span />
                  </div>
                  {devices.map((device) => (
                    <button
                      className="device-table-row"
                      key={device.id}
                      onClick={() => showDevice(device)}
                    >
                      <span className="device-table-identity">
                        <span className={`os-icon os-${device.kind}`}>
                          <OsIcon kind={device.kind} />
                        </span>
                        <span>
                          <strong>
                            {device.name}
                            {device.id === 'main' && <span className="this-device">PRIMARY</span>}
                          </strong>
                          <small>
                            {device.os} · {device.online ? 'Online' : 'Offline'}
                          </small>
                        </span>
                      </span>
                      <span className="mono">{formatRevision(device.revision)}</span>
                      <span className="muted">{device.seen}</span>
                      <Badge tone={device.tone} dot>
                        {device.status}
                      </Badge>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              </section>
              <div className="security-note">
                <LockKeyhole size={18} />
                <div>
                  <h3>A private connection between your devices.</h3>
                  <p>
                    Pairing, credential rotation and revocation arrive with backend synchronization.
                    This preview connects to no devices.
                  </p>
                </div>
              </div>
            </>
          )}
          {page === 'settings' && (
            <div className="settings-layout">
              <section className="content-panel settings-panel">
                <SectionTitle
                  title="Profile & installation"
                  aside={<Badge tone="neutral">Fixture only</Badge>}
                />
                <div className="settings-row">
                  <div>
                    <strong>Synchronization profile</strong>
                    <p>Your portable configuration workspace.</p>
                  </div>
                  <span>WoW Forever</span>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>Installation path</strong>
                    <p>No filesystem discovery or access is enabled.</p>
                  </div>
                  <code>/Fixtures/World of Warcraft/</code>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>Automatic synchronization</strong>
                    <p>Requires the verified game-safety interlock in Phase 4.</p>
                  </div>
                  <Badge>Not enabled</Badge>
                </div>
              </section>
              <section className="content-panel settings-panel">
                <SectionTitle
                  title="Preview preferences"
                  aside={<span className="muted">This session only</span>}
                />
                {(
                  [
                    {
                      key: 'compact',
                      title: 'Compact activity rows',
                      description: 'Fit a little more history into your workspace.',
                    },
                    {
                      key: 'notifications',
                      title: 'Completion notifications',
                      description: 'Show a quiet message after a demo synchronization.',
                    },
                    {
                      key: 'reduceMotion',
                      title: 'Reduce interface motion',
                      description: 'Use immediate transitions in addition to your OS preference.',
                    },
                  ] as const
                ).map((item) => (
                  <label className="settings-row" key={item.key}>
                    <span>
                      <strong>{item.title}</strong>
                      <span className="settings-description">{item.description}</span>
                    </span>
                    <input
                      className="switch"
                      type="checkbox"
                      role="switch"
                      checked={draft[item.key]}
                      onChange={(e) => setDraft({ ...draft, [item.key]: e.target.checked })}
                    />
                  </label>
                ))}
                <div className="settings-row">
                  <div>
                    <strong>Illustrative backup retention</strong>
                    <p>Preference preview only. No backup service is running.</p>
                  </div>
                  <select
                    aria-label="Demo backup retention"
                    value={draft.retention}
                    onChange={(e) => setDraft({ ...draft, retention: e.target.value })}
                  >
                    <option>30 days</option>
                    <option>60 days</option>
                    <option>90 days</option>
                  </select>
                </div>
              </section>
              <div className="settings-save-note">
                <span>
                  {changed
                    ? 'You have unsaved preview preferences.'
                    : `Saved preference preview: ${settings.retention} retention. Nothing is written to game files.`}
                </span>
                {changed && (
                  <button className="text-button" onClick={() => setDraft(settings)}>
                    Discard changes
                  </button>
                )}
              </div>
            </div>
          )}
        </main>
        <footer className="workspace-footer">
          <span>
            <span className="status-dot" />
            {platform === 'desktop'
              ? 'Phase 2 · Local engine foundation'
              : 'Phase 1 · Foundation preview'}
          </span>
          <span>
            <LockKeyhole size={11} />
            No live game access<span className="footer-separator">/</span>Protocol v1
          </span>
        </footer>
      </div>
      <Dialog.Root
        open={modal !== null}
        onOpenChange={(open) => {
          if (!open) setModal(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            onOpenAutoFocus={() => {
              dialogReturnFocus.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              dialogReturnFocus.current?.focus();
            }}
            className={`dialog-content ${modal === 'commands' ? 'command-dialog' : ''}`}
          >
            <Dialog.Title className="dialog-title">{modalTitle}</Dialog.Title>
            <Dialog.Description className="dialog-description">
              {modal === 'commands'
                ? 'Find a view or switch the preview scenario.'
                : modal === 'about'
                  ? 'World of Warcraft Configuration Sync. Your WoW setup. Everywhere.'
                  : 'Interactive demonstration · isolated fixtures only.'}
            </Dialog.Description>
            <Dialog.Close className="dialog-close icon-button" aria-label="Close dialog">
              <X size={19} />
            </Dialog.Close>
            {modal === 'commands' && (
              <>
                <label className="search-field command-search">
                  <Search size={17} />
                  <input
                    aria-label="Search commands"
                    autoFocus
                    value={commandQuery}
                    onChange={(e) => setCommandQuery(e.target.value)}
                    placeholder="Search views and scenarios…"
                  />
                </label>
                <div className="command-results">
                  {pages
                    .filter((p) => matchesSearch([pageLabels[p]], commandQuery))
                    .map((p) => {
                      const Icon = icons[p];
                      return (
                        <button key={p} onClick={() => navigate(p)}>
                          <Icon size={17} />
                          <span>{pageLabels[p]}</span>
                          <ArrowRight size={14} />
                        </button>
                      );
                    })}
                  {scenarios
                    .filter((s) => matchesSearch([scenarioLabels[s]], commandQuery))
                    .map((s) => (
                      <button
                        key={s}
                        disabled={busy}
                        onClick={() => {
                          changeScenario(s);
                          setModal(null);
                        }}
                      >
                        <SlidersHorizontal size={17} />
                        <span>{scenarioLabels[s]}</span>
                        <small>Scenario</small>
                      </button>
                    ))}
                </div>
              </>
            )}
            {modal === 'profile' && (
              <>
                <div className="profile-dialog-summary">
                  <span className="profile-icon">
                    <Layers3 size={23} />
                  </span>
                  <div>
                    <h3>WoW Forever</h3>
                    <p>Personal profile · 2 fixture devices</p>
                  </div>
                  <Badge tone="accent">Selected</Badge>
                </div>
                <p className="dialog-body-copy">
                  One portable setup, with device-specific settings kept local. Profile management
                  will connect to the API in a later phase.
                </p>
                <div className="dialog-actions">
                  <Button onClick={() => navigate('settings')}>
                    Profile settings
                    <ArrowRight size={14} />
                  </Button>
                </div>
              </>
            )}
            {modal === 'event' && (
              <>
                <dl className="detail-list">
                  <div>
                    <dt>Device</dt>
                    <dd>{selectedEvent.device}</dd>
                  </div>
                  <div>
                    <dt>File / scope</dt>
                    <dd className="mono">{selectedEvent.path}</dd>
                  </div>
                  <div>
                    <dt>Revisions</dt>
                    <dd className="mono">
                      {formatRevision(selectedEvent.before)} → {formatRevision(selectedEvent.after)}
                    </dd>
                  </div>
                  <div>
                    <dt>Change size</dt>
                    <dd>{selectedEvent.bytes}</dd>
                  </div>
                  <div>
                    <dt>Demo clock</dt>
                    <dd>
                      <time dateTime={demoClock}>3 Nov 2026 · 18:44 CET</time>
                    </dd>
                  </div>
                </dl>
                <div className="dialog-actions">
                  <Button
                    variant="primary"
                    onClick={() => {
                      setDiffFrom(selectedEvent.before);
                      setDiffTo(selectedEvent.after);
                      setDiffFile(
                        selectedEvent.title.includes('Bartender')
                          ? 'Bartender4.lua'
                          : 'WeakAuras.lua',
                      );
                      navigate('diff');
                    }}
                  >
                    Explore fixture diff
                    <ArrowRight size={14} />
                  </Button>
                </div>
              </>
            )}
            {modal === 'device' && (
              <>
                <div className="device-dialog-head">
                  <span className={`os-icon os-${selectedDevice.kind}`}>
                    <OsIcon kind={selectedDevice.kind} />
                  </span>
                  <span>{selectedDevice.os}</span>
                  <Badge tone={selectedDevice.tone} dot>
                    {selectedDevice.status}
                  </Badge>
                </div>
                <dl className="detail-list">
                  <div>
                    <dt>Last seen</dt>
                    <dd>{selectedDevice.seen}</dd>
                  </div>
                  <div>
                    <dt>Applied revision</dt>
                    <dd className="mono">{formatRevision(selectedDevice.revision)}</dd>
                  </div>
                  <div>
                    <dt>Pending changes</dt>
                    <dd>{selectedDevice.pending}</dd>
                  </div>
                  <div>
                    <dt>Connection</dt>
                    <dd>
                      {selectedDevice.online ? 'Online fixture' : 'Offline · last known state'}
                    </dd>
                  </div>
                  <div>
                    <dt>Credentials</dt>
                    <dd>No real credentials issued</dd>
                  </div>
                </dl>
                <div className="dialog-actions">
                  <Button
                    onClick={() => {
                      setDeviceFilter(selectedDevice.name);
                      navigate('activity');
                    }}
                  >
                    View device activity
                    <ArrowRight size={14} />
                  </Button>
                </div>
              </>
            )}
            {modal === 'pair' && (
              <>
                <div className="pair-illustration">
                  <Monitor size={35} />
                  <span className="pair-line" />
                  <Brand small />
                  <span className="pair-line" />
                  <Laptop size={35} />
                </div>
                <p className="dialog-body-copy">
                  Install Attuner on your other computer and approve its one-time pairing code here.
                  Each device will receive its own revocable credential.
                </p>
                <div className="inline-notice">
                  <LockKeyhole size={17} />
                  Pairing is unavailable in this foundation preview. No code or credential has been
                  generated.
                </div>
                <div className="dialog-actions">
                  <Button onClick={() => setModal(null)}>Got it</Button>
                </div>
              </>
            )}
            {modal === 'restore' && (
              <>
                <div className="inline-notice">
                  <ShieldCheck size={18} />
                  Your current setup would be backed up before any change.
                </div>
                <dl className="detail-list">
                  <div>
                    <dt>Selected snapshot</dt>
                    <dd className="mono">{formatRevision(restoreRevision)}</dd>
                  </div>
                  <div>
                    <dt>Current head</dt>
                    <dd className="mono">#4,892</dd>
                  </div>
                  <div>
                    <dt>Result</dt>
                    <dd>A new revision; existing history stays intact</dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>Selected paired devices, when safely closed</dd>
                  </div>
                </dl>
                <p className="dialog-body-copy">
                  Restore is a read-only preview in Phase 1. No files or revisions will change.
                </p>
                <div className="dialog-actions">
                  <Button
                    onClick={() => {
                      setDiffFrom(Math.min(restoreRevision, 4892));
                      setDiffTo(4892);
                      navigate('diff');
                    }}
                  >
                    Compare with current
                    <ArrowLeftRight size={14} />
                  </Button>
                  <Button disabled>Restore · Phase 5</Button>
                </div>
              </>
            )}
            {modal === 'resolve' && (
              <>
                <p className="dialog-body-copy">
                  Choose a fixture version for this session. Both source fixtures remain unchanged
                  and available.
                </p>
                {(['main', 'macbook'] as const).map((choice) => (
                  <label
                    className={`resolution-option ${resolveChoice === choice ? 'resolution-selected' : ''}`}
                    key={choice}
                  >
                    <input
                      type="radio"
                      name="resolution"
                      value={choice}
                      checked={resolveChoice === choice}
                      onChange={() => setResolveChoice(choice)}
                    />
                    <span>
                      <strong>{choice === 'main' ? 'Main PC' : 'MacBook Pro'}</strong>
                      <small>
                        Icon size {choice === 'main' ? '52' : '48'} · original version preserved
                      </small>
                    </span>
                  </label>
                ))}
                <div className="dialog-actions">
                  <Button onClick={() => setModal(null)}>Keep reviewing</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      dispatch({ type: 'resolve' });
                      setModal(null);
                      notify(
                        `Demo resolved using ${resolveChoice === 'main' ? 'Main PC' : 'MacBook Pro'}. Both fixture versions are preserved.`,
                      );
                    }}
                  >
                    Use selected in demo
                    <Check size={14} />
                  </Button>
                </div>
              </>
            )}
            {modal === 'about' && (
              <>
                <div className="about-brand">
                  <Brand />
                </div>
                <dl className="detail-list">
                  <div>
                    <dt>Version</dt>
                    <dd>
                      {nativeVersion ?? '0.1.0'} ·{' '}
                      {platform === 'desktop' ? 'Desktop shell' : 'Web dashboard'}
                    </dd>
                  </div>
                  <div>
                    <dt>Protocol</dt>
                    <dd>v1 · contract foundation</dd>
                  </div>
                  <div>
                    <dt>Data source</dt>
                    <dd>Deterministic client-side fixtures</dd>
                  </div>
                  <div>
                    <dt>Native access</dt>
                    <dd>
                      {nativeVersion
                        ? 'Metadata command verified'
                        : 'No native connection verified'}
                    </dd>
                  </div>
                </dl>
                <p className="dialog-body-copy">
                  Synchronization, pairing, authentication and game-file operations are not
                  implemented in this phase.
                </p>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {toast && (
          <div className="toast">
            <CircleCheck size={18} />
            <span>{toast}</span>
            <button
              aria-label="Dismiss notification"
              className="icon-button"
              onClick={() => setToast('')}
            >
              <X size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
