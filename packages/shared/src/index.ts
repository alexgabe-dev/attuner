export const scenarios = ['synchronized', 'pending', 'offline', 'conflict', 'error'] as const;
export type Scenario = (typeof scenarios)[number];
export const scenarioLabels: Record<Scenario, string> = {
  synchronized: 'Synchronized',
  pending: 'Changes pending',
  offline: 'Offline device',
  conflict: 'Conflict',
  error: 'Error',
};
export const pages = [
  'overview',
  'activity',
  'snapshots',
  'diff',
  'conflicts',
  'addons',
  'devices',
  'settings',
] as const;
export type Page = (typeof pages)[number];
export const pageLabels: Record<Page, string> = {
  overview: 'Overview',
  activity: 'Activity',
  snapshots: 'Snapshots',
  diff: 'Diff Explorer',
  conflicts: 'Conflicts',
  addons: 'Addons',
  devices: 'Devices',
  settings: 'Settings',
};
export type Tone = 'success' | 'warning' | 'error' | 'neutral' | 'accent';
export const scenarioContent: Record<
  Scenario,
  {
    title: string;
    description: string;
    tone: Tone;
    status: string;
    pending: number;
    readiness: string;
  }
> = {
  synchronized: {
    title: 'Everything is in tune.',
    description: 'Your configuration matches revision #4,892 on both devices.',
    tone: 'success',
    status: 'Up to date',
    pending: 0,
    readiness: 'Fixture verified · no game connected',
  },
  pending: {
    title: 'A few changes to bring along.',
    description: '14 changed files on Main PC are waiting to be synchronized.',
    tone: 'warning',
    status: 'Changes pending',
    pending: 14,
    readiness: 'Waiting for a demo synchronization',
  },
  offline: {
    title: 'Your MacBook is taking a break.',
    description: 'Main PC is current. MacBook Pro last reported revision #4,891.',
    tone: 'neutral',
    status: 'Device offline',
    pending: 0,
    readiness: 'MacBook configuration has not been verified',
  },
  conflict: {
    title: 'Two changes. One decision.',
    description: 'WeakAuras.lua was changed on both devices. Both versions are preserved.',
    tone: 'warning',
    status: 'Needs review',
    pending: 1,
    readiness: 'Review the conflict before applying changes',
  },
  error: {
    title: 'Your files are safe. Let’s try again.',
    description: 'The demo server could not be reached. No files have been changed.',
    tone: 'error',
    status: 'Connection error',
    pending: 14,
    readiness: 'Application paused until the connection recovers',
  },
};
export type Device = {
  id: string;
  name: string;
  os: string;
  kind: 'windows' | 'mac';
  revision: number;
  online: boolean;
  status: string;
  tone: Tone;
  seen: string;
  pending: number;
};
export function getDevices(scenario: Scenario): Device[] {
  return [
    {
      id: 'main',
      name: 'Main PC',
      os: 'Windows 11',
      kind: 'windows',
      revision: scenario === 'pending' || scenario === 'error' ? 4891 : 4892,
      online: scenario !== 'error',
      status: scenario === 'pending' ? '14 changes' : scenario === 'error' ? 'Error' : 'Up to date',
      tone: scenario === 'pending' ? 'warning' : scenario === 'error' ? 'error' : 'success',
      seen: scenario === 'error' ? '6 minutes ago' : '2 minutes ago',
      pending: scenarioContent[scenario].pending,
    },
    {
      id: 'macbook',
      name: 'MacBook Pro',
      os: 'macOS 26',
      kind: 'mac',
      revision: scenario === 'offline' || scenario === 'conflict' ? 4891 : 4892,
      online: scenario !== 'offline',
      status:
        scenario === 'offline' ? 'Offline' : scenario === 'conflict' ? 'Conflict' : 'Up to date',
      tone: scenario === 'offline' ? 'neutral' : scenario === 'conflict' ? 'warning' : 'success',
      seen: scenario === 'offline' ? 'Yesterday, 21:42' : '2 minutes ago',
      pending: scenario === 'conflict' ? 1 : 0,
    },
  ];
}
export type ActivityEvent = {
  id: string;
  type: 'sync' | 'modified' | 'added' | 'conflict' | 'snapshot';
  title: string;
  detail: string;
  device: string;
  time: string;
  path: string;
  before: number;
  after: number;
  bytes: string;
};
export const activity: ActivityEvent[] = [
  {
    id: 'e1',
    type: 'sync',
    title: 'Configuration synchronized',
    detail: '14 files · 3.8 MB transferred',
    device: 'Main PC',
    time: '2 min ago',
    path: 'WTF/Account/DEMO/SavedVariables/',
    before: 4891,
    after: 4892,
    bytes: '3.8 MB',
  },
  {
    id: 'e2',
    type: 'modified',
    title: 'WeakAuras configuration updated',
    detail: 'SavedVariables/WeakAuras.lua',
    device: 'Main PC',
    time: '6 min ago',
    path: 'WTF/Account/DEMO/SavedVariables/WeakAuras.lua',
    before: 4890,
    after: 4891,
    bytes: '24.6 KB',
  },
  {
    id: 'e3',
    type: 'added',
    title: 'Plater added to your setup',
    detail: 'Addon and saved configuration',
    device: 'Main PC',
    time: '9 min ago',
    path: 'Interface/AddOns/Plater/',
    before: 4889,
    after: 4890,
    bytes: '2.4 MB',
  },
  {
    id: 'e4',
    type: 'snapshot',
    title: 'Restore point created',
    detail: 'Automatic backup before synchronization',
    device: 'MacBook Pro',
    time: '18 min ago',
    path: 'Local backup · fixture only',
    before: 4888,
    after: 4889,
    bytes: '3.2 MB',
  },
  {
    id: 'e5',
    type: 'sync',
    title: 'MacBook Pro brought up to date',
    detail: '8 files · 1.2 MB transferred',
    device: 'MacBook Pro',
    time: '42 min ago',
    path: 'WTF/Account/DEMO/',
    before: 4887,
    after: 4888,
    bytes: '1.2 MB',
  },
  {
    id: 'e6',
    type: 'modified',
    title: 'Bartender4 layout adjusted',
    detail: 'SavedVariables/Bartender4.lua',
    device: 'Main PC',
    time: '1 hour ago',
    path: 'WTF/Account/DEMO/SavedVariables/Bartender4.lua',
    before: 4886,
    after: 4887,
    bytes: '8.1 KB',
  },
];
export const addons = [
  {
    name: 'WeakAuras',
    initials: 'WA',
    version: '5.20.2',
    size: '42.8 MB',
    category: 'Interface',
    color: 'violet',
  },
  {
    name: 'Plater',
    initials: 'PL',
    version: '1.0.28',
    size: '18.4 MB',
    category: 'Combat',
    color: 'green',
  },
  {
    name: 'Bartender4',
    initials: 'B4',
    version: '4.15.1',
    size: '3.2 MB',
    category: 'Interface',
    color: 'blue',
  },
  {
    name: 'ElvUI',
    initials: 'EU',
    version: '13.85',
    size: '36.7 MB',
    category: 'Interface',
    color: 'amber',
  },
  {
    name: 'Details!',
    initials: 'D!',
    version: '11.1.0',
    size: '22.1 MB',
    category: 'Combat',
    color: 'red',
  },
  {
    name: 'Deadly Boss Mods',
    initials: 'DB',
    version: '11.1.8',
    size: '12.6 MB',
    category: 'Combat',
    color: 'blue',
  },
  {
    name: 'Bagnon',
    initials: 'BG',
    version: '11.0.3',
    size: '4.3 MB',
    category: 'Inventory',
    color: 'amber',
  },
  {
    name: 'Leatrix Plus',
    initials: 'L+',
    version: '3.0.12',
    size: '1.8 MB',
    category: 'Utilities',
    color: 'green',
  },
];
export const snapshots = [4892, 4891, 4890, 4889, 4888, 4887].map((revision, index) => ({
  revision,
  device: index === 3 || index === 4 ? 'MacBook Pro' : 'Main PC',
  time: [
    'Today, 18:42',
    'Today, 18:38',
    'Today, 18:35',
    'Today, 18:26',
    'Today, 18:02',
    'Today, 17:43',
  ][index]!,
  files: [14, 2, 18, 8, 8, 3][index]!,
  size: ['3.8 MB', '24.6 KB', '2.4 MB', '3.2 MB', '1.2 MB', '8.1 KB'][index]!,
}));
export const demoClock = '2026-11-03T18:44:00+01:00';
export function formatRevision(n: number) {
  return `#${n.toLocaleString('en-US')}`;
}
export function matchesSearch(values: string[], query: string) {
  const q = query.trim().toLowerCase();
  return values.some((value) => value.toLowerCase().includes(q));
}
export function isScenario(value: unknown): value is Scenario {
  return scenarios.includes(value as Scenario);
}
export function isPage(value: unknown): value is Page {
  return pages.includes(value as Page);
}
export type DemoState = { scenario: Scenario; resolved: boolean; syncCount: number };
export type DemoAction =
  | { type: 'scenario'; scenario: Scenario }
  | { type: 'sync' }
  | { type: 'resolve' }
  | { type: 'reset' };
export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'scenario':
      return { scenario: action.scenario, resolved: false, syncCount: 0 };
    case 'sync':
      return state.scenario === 'conflict'
        ? state
        : state.scenario === 'offline'
          ? { ...state, syncCount: state.syncCount + 1 }
          : { scenario: 'synchronized', resolved: state.resolved, syncCount: state.syncCount + 1 };
    case 'resolve':
      return { scenario: 'synchronized', resolved: true, syncCount: state.syncCount };
    case 'reset':
      return { scenario: 'synchronized', resolved: false, syncCount: 0 };
  }
}
