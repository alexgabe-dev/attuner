import Link from 'next/link';
export default function NotFound() {
  return (
    <main style={{ maxWidth: 600, margin: '20vh auto', padding: 24 }}>
      <p style={{ color: '#a78bfa', marginBottom: 12 }}>ATTUNER / 404</p>
      <h1>This view wandered off.</h1>
      <p style={{ margin: '16px 0', color: '#9ba3af' }}>
        Your setup is still right where you left it.
      </p>
      <Link href="/" style={{ color: '#b9a5ff' }}>
        Return to your overview →
      </Link>
    </main>
  );
}
