'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Brand, ConnectedWorkbench, Workbench } from '@attuner/ui';
import { isPage, isScenario } from '@attuner/shared';
import { webController } from './connected-controller';
export function WebWorkbench({ children }: { children: React.ReactNode }) {
  const router = useRouter(),
    pathname = usePathname(),
    query = useSearchParams();
  const [controller] = useState(webController);
  const [secure, setSecure] = useState<boolean | null>(null);
  useEffect(() => setSecure(window.location.protocol === 'https:'), []);
  const section = pathname.split('/').filter(Boolean),
    page = section[0] ?? 'overview';
  const enrollment = page === 'enroll' && section.length === 2 ? section[1] : undefined;
  if ((!isPage(page) && !enrollment) || (isPage(page) && section.length > 1)) return children;
  const scenario = query.get('scenario'),
    demo = query.get('demo') === '1' && !enrollment;
  if (!demo && secure === null)
    return (
      <main className="initial-loading" aria-label="Checking secure connection">
        <span className="loading-line" />
      </main>
    );
  if (!demo && !secure) {
    const address = new URL(window.location.href);
    address.protocol = 'https:';
    if (['127.0.0.1', 'localhost'].includes(address.hostname) && address.port === '3000') {
      address.hostname = '127.0.0.1';
      address.port = '4318';
    }
    return (
      <main className="secure-entry">
        <Brand />
        <p className="eyebrow">YOUR PRIVATE WORKSPACE</p>
        <h1>Use a secure connection</h1>
        <p>Open Attuner over HTTPS to sign in and manage your devices.</p>
        <a className="button button-primary" href={address.href}>
          Open HTTPS workspace
        </a>
        <a className="connected-demo-link" href="/?demo=1">
          Explore the labeled interface demo
        </a>
      </main>
    );
  }
  return (
    <>
      {demo ? (
        <Workbench
          platform="web"
          page={isPage(page) ? page : 'overview'}
          initialScenario={isScenario(scenario) ? scenario : 'synchronized'}
          onNavigate={(next) => router.push(`${next === 'overview' ? '/' : `/${next}`}?demo=1`)}
        />
      ) : (
        <ConnectedWorkbench
          platform="web"
          controller={controller}
          page={isPage(page) ? page : 'overview'}
          {...(enrollment ? { enrollmentId: enrollment } : {})}
          onNavigate={(next) => router.push(next === 'overview' ? '/' : `/${next}`)}
        />
      )}
      {children}
    </>
  );
}
