import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import type { ConnectedController } from '@attuner/ui';
export function nativeController(): ConnectedController {
  // React views can request metadata together. Serialize foreground IPC without
  // weakening the native busy guard; status and cancellation remain immediate.
  let tail: Promise<unknown> = Promise.resolve(),
    queued = 0;
  function serial<T>(command: string, args?: InvokeArgs): Promise<T> {
    if (queued >= 32)
      return Promise.reject(new Error('Finish the current operation before continuing.'));
    queued++;
    const next = tail.then(() => invoke<T>(command, args));
    tail = next.catch(() => undefined);
    return next.finally(() => {
      queued--;
    });
  }
  return {
    read: (request) => serial('sync_remote', { request }),
    native: {
      status: () => invoke('sync_status'),
      connect: (origin, ca) => serial('sync_connect', { origin, ca }),
      enroll: (name) => serial('sync_enroll', { name }),
      finish: () => serial('sync_finish'),
      disconnect: (forgetOnly) => serial('sync_disconnect', { forgetOnly }),
      dashboard: () => serial('sync_open_dashboard'),
      cancel: () => invoke('sync_cancel'),
      local: (request) => serial('sync_local', { request }),
    },
  };
}
