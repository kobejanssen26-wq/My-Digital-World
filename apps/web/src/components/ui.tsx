import type { ReactNode } from 'react';
import { hueFor } from '@mdw/shared';

export function Pill({ tone, children, pulse }: { tone: 'ok' | 'warn' | 'bad' | 'idle' | 'info' | 'done'; children: ReactNode; pulse?: boolean }) {
  return <span className={`pill ${tone}${pulse ? ' pulse' : ''}`}>{children}</span>;
}

export function Swatch({ id }: { id: string }) {
  return <span className="swatch" style={{ background: `hsl(${hueFor(id)} 70% 52%)` }} aria-hidden="true" />;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty card flat" role="status">
      <h2>{title}</h2>
      {children}
      {action}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="banner bad" role="alert">
      {children}
    </div>
  );
}

export const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const ICONS = {
  world: 'M12 3l9 5v8l-9 5-9-5V8zM12 12l9-4M12 12v9M12 12L3 8',
  projects: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  tasks: 'M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h9',
  cloud: 'M7 18a4 4 0 01-.5-7.97A5.5 5.5 0 0117 8.5 4.5 4.5 0 0117.5 18z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
} as const;
