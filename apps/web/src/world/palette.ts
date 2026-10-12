export const C = {
  white: '#f6f8fb',
  blue: '#2f6fb5',
  deepBlue: '#1f4f8a',
  sky: '#9cc4ee',
  steel: '#c5cedb',
  dark: '#2b3748',
  glass: '#8dbbe8',
  glassOn: '#ffe9a8',
  grass: '#d9e8d3',
  ground: '#e6ecf4',
  road: '#5a6678',
  line: '#eef2f7',
  bad: '#e5484d',
  warn: '#f0a020',
  ok: '#2fb36d',
  idle: '#94a3b8',
  info: '#3b82f6',
  tree: '#6fa874',
  trunk: '#8a6a4d',
};

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'done' | 'info';
export const TONE_COLOR: Record<Tone, string> = { ok: C.ok, warn: C.warn, bad: C.bad, idle: C.idle, done: C.ok, info: C.info };
