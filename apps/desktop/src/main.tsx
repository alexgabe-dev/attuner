import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Workbench } from '@attuner/ui';
import { isScenario } from '@attuner/shared';
import '@attuner/ui/styles.css';
import { LocalEngineLab } from './local-engine';
function Desktop() {
  const [nativeVersion, setNativeVersion] = useState<string>();
  const query = new URLSearchParams(window.location.search).get('scenario');
  useEffect(() => {
    if ('__TAURI_INTERNALS__' in window)
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke<{ version: string; mode: string }>('get_app_info'))
        .then((info) => {
          if (info.mode === 'fixture-demo' || info.mode === 'local-fixture-engine')
            setNativeVersion(info.version);
        })
        .catch(() => console.error('Native metadata command unavailable'));
  }, []);
  return (
    <Workbench
      platform="desktop"
      localEngine={<LocalEngineLab nativeAvailable={'__TAURI_INTERNALS__' in window} />}
      initialScenario={isScenario(query) ? query : 'synchronized'}
      {...(nativeVersion ? { nativeVersion } : {})}
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Desktop />
  </React.StrictMode>,
);
