'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Workbench } from '@attuner/ui';
import { isPage, isScenario } from '@attuner/shared';
export function WebWorkbench({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams();
  const section = pathname.split('/').filter(Boolean);
  const page = section[0] ?? 'overview';
  if (!isPage(page) || section.length > 1) return children;
  const scenario = query.get('scenario');
  return (
    <>
      <Workbench
        platform="web"
        page={page}
        initialScenario={isScenario(scenario) ? scenario : 'synchronized'}
        onNavigate={(next) => router.push(next === 'overview' ? '/' : `/${next}`)}
      />
      {children}
    </>
  );
}
