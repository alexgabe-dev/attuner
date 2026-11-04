import { it, expect, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { nativeController } from './connected-controller';
it('serializes overlapping views while keeping native cancellation immediate', async () => {
  const calls: string[] = [];
  let release: (value: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementation((command) => {
    calls.push(command);
    if (command === 'sync_remote' && calls.length === 1)
      return new Promise((resolve) => {
        release = resolve;
      });
    return Promise.resolve({}) as never;
  });
  const controller = nativeController();
  const first = controller.read({ view: 'profiles' });
  const second = controller.native!.local({ action: 'inspect', fixture: 'synthetic-id' });
  await Promise.resolve();
  expect(calls).toEqual(['sync_remote']);
  await controller.native!.cancel();
  expect(calls).toEqual(['sync_remote', 'sync_cancel']);
  release({ profiles: [] });
  await Promise.all([first, second]);
  expect(calls).toEqual(['sync_remote', 'sync_cancel', 'sync_local']);
});
it('a failed foreground request does not strand the remaining queue', async () => {
  vi.mocked(invoke)
    .mockReset()
    .mockRejectedValueOnce(new Error('Server unavailable'))
    .mockResolvedValue({ snapshots: [] });
  const controller = nativeController();
  const first = controller.read({ view: 'profiles' });
  const next = controller.native!.local({ action: 'inspect', fixture: 'synthetic-id' });
  await expect(first).rejects.toThrow('Server unavailable');
  await expect(next).resolves.toEqual({ snapshots: [] });
});
