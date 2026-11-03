import type { Metadata } from 'next';
import { Suspense } from 'react';
import { WebWorkbench } from '../components/web-workbench';
import '@attuner/ui/styles.css';
export const metadata: Metadata = {
  title: 'Attuner — Your WoW setup. Everywhere.',
  description:
    'A private, self-hosted World of Warcraft configuration workspace. Phase 1 interactive fixture preview.',
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Suspense
          fallback={
            <main className="initial-loading" aria-label="Loading workspace">
              <span className="loading-line" />
              <span className="loading-line" />
              <span className="loading-line" />
            </main>
          }
        >
          <WebWorkbench>{children}</WebWorkbench>
        </Suspense>
      </body>
    </html>
  );
}
