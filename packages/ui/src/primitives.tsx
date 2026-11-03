import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '@attuner/shared';
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? 'brand-small' : ''}`}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path d="M20 3 3 34l13-8-5 1 9-17 6 12H17l-4 6h16l8 6L20 3Z" fill="currentColor" />
        <path d="m20 3 6 19h-5l-1-12Z" fill="white" opacity=".18" />
      </svg>
      {!small && (
        <span>
          Attuner<span className="brand-period">.</span>
        </span>
      )}
    </span>
  );
}
export function Badge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="status-dot" />}
      {children}
    </span>
  );
}
export function Button({
  children,
  variant = 'neutral',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'neutral' | 'ghost' | 'danger';
}) {
  return (
    <button className={`button button-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
