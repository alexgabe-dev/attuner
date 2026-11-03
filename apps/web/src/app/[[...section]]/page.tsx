import { notFound } from 'next/navigation';
import { isPage } from '@attuner/shared';
export default async function Page({ params }: { params: Promise<{ section?: string[] }> }) {
  const { section } = await params;
  if (!isPage(section?.[0] ?? 'overview') || (section?.length ?? 0) > 1) notFound();
  return null;
}
