import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectedWorkbench, Workbench } from '@attuner/ui';
import { nativeController } from './connected-controller';
import { isScenario } from '@attuner/shared';
import '@attuner/ui/styles.css';
import { LocalEngineLab } from './local-engine';
function Desktop() {
  const [controller] = useState(nativeController);
  const demo = new URLSearchParams(window.location.search).get('demo') === '1';
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
  if (!demo)
    return '__TAURI_INTERNALS__' in window ? (
      <ConnectedWorkbench platform="desktop" controller={controller} />
    ) : (
      <main className="initial-loading">
        <p>The connected desktop requires the native Attuner app.</p>
        <a href="/?demo=1">Open the labeled browser demo</a>
      </main>
    );
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
