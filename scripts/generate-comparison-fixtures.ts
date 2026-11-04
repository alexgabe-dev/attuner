import { writeFile } from 'node:fs/promises';
import {
  consistencyGroup,
  type Manifest,
  type ManifestFile,
} from '../packages/sync-protocol/src/index.ts';
const profileId = '22222222-2222-4222-8222-222222222222';
async function file(root: 'account' | 'addons', path: string, char: string): Promise<ManifestFile> {
  return { root, path, hash: char.repeat(64), size: 1, group: await consistencyGroup(root, path) };
}
const a = await file('account', 'SavedVariables/A.lua', 'a'),
  b = await file('account', 'SavedVariables/B.lua', 'a'),
  la = { ...a, hash: 'b'.repeat(64) },
  ra = { ...a, hash: 'c'.repeat(64) },
  rb = { ...b, hash: 'c'.repeat(64) };
const ga = await file('addons', 'Demo/a.lua', 'a'),
  gb = await file('addons', 'Demo/b.lua', 'a');
const manifest = (files: ManifestFile[]): Manifest => ({
  protocolVersion: 1,
  profileId,
  policyVersion: 1,
  files,
});
const unicodeA = await file('account', '𐀀.lua', 'a'),
  unicodeB = await file('account', '\uE000.lua', 'a');
const cases = [
  {
    name: 'UTF-8 ordering',
    baseline: manifest([unicodeB, unicodeA]),
    local: manifest([unicodeB, { ...unicodeA, hash: 'b'.repeat(64) }]),
    remote: manifest([{ ...unicodeB, hash: 'c'.repeat(64) }, unicodeA]),
    conflictPaths: [],
    merged: manifest([
      { ...unicodeB, hash: 'c'.repeat(64) },
      { ...unicodeA, hash: 'b'.repeat(64) },
    ]),
  },
  {
    name: 'independent changes',
    baseline: manifest([a, b]),
    local: manifest([la, b]),
    remote: manifest([a, rb]),
    conflictPaths: [],
    merged: manifest([la, rb]),
  },
  {
    name: 'competing modification',
    baseline: manifest([a]),
    local: manifest([la]),
    remote: manifest([ra]),
    conflictPaths: ['account/SavedVariables/A.lua'],
    merged: null,
  },
  {
    name: 'local modification remote deletion',
    baseline: manifest([a]),
    local: manifest([la]),
    remote: manifest([]),
    conflictPaths: ['account/SavedVariables/A.lua'],
    merged: null,
  },
  {
    name: 'local deletion remote modification',
    baseline: manifest([a]),
    local: manifest([]),
    remote: manifest([ra]),
    conflictPaths: ['account/SavedVariables/A.lua'],
    merged: null,
  },
  {
    name: 'identical changes',
    baseline: manifest([a]),
    local: manifest([la]),
    remote: manifest([la]),
    conflictPaths: [],
    merged: manifest([la]),
  },
  {
    name: 'addon consistency group',
    baseline: manifest([ga, gb]),
    local: manifest([{ ...ga, hash: 'b'.repeat(64) }, gb]),
    remote: manifest([ga, { ...gb, hash: 'c'.repeat(64) }]),
    conflictPaths: ['addons/Demo/a.lua', 'addons/Demo/b.lua'],
    merged: null,
  },
];
await writeFile(
  new URL('../fixtures/protocol/comparisons.json', import.meta.url),
  JSON.stringify(cases, null, 2) + '\n',
);
