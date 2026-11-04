'use client';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ConnectedWorkbench, Workbench } from '@attuner/ui';
import { isPage, isScenario } from '@attuner/shared';
import { webController } from './connected-controller';
export function WebWorkbench({ children }: { children: React.ReactNode }) {
  const router = useRouter(),
    pathname = usePathname(),
    query = useSearchParams();
  const [controller] = useState(webController);
  const section = pathname.split('/').filter(Boolean),
    page = section[0] ?? 'overview';
  const enrollment = page === 'enroll' && section.length === 2 ? section[1] : undefined;
  if ((!isPage(page) && !enrollment) || (isPage(page) && section.length > 1)) return children;
  const scenario = query.get('scenario'),
    demo = query.get('demo') === '1' && !enrollment;
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
