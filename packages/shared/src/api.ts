import type { EventRow, ProjectRow, SessionRow, TaskRow } from './model.js';

/** Wire types shared between worker and web. */

export interface Snapshot {
  cursor: number;
  serverTime: number;
  projects: ProjectRow[];
  sessions: SessionRow[];
  tasks: TaskRow[];
  events: EventRow[];
  stats: { files: number; storageBytes: number; storageLimitBytes: number; r2: boolean };
  bridge: BridgeHealth;
  settings: Settings;
}

export interface BridgeHealth {
  tokens: { id: string; name: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null }[];
  lastIngestAt: number | null;
  lastIngestSource: string | null;
}

export interface Settings {
  retentionDays: number;
  reducedMotion: boolean;
  lightweight: boolean;
  storageLimitMb: number;
}
export const DEFAULT_SETTINGS: Settings = { retentionDays: 90, reducedMotion: false, lightweight: false, storageLimitMb: 1024 };

export interface Delta {
  type: 'delta';
  cursor: number;
  projects: ProjectRow[];
  sessions: SessionRow[];
  tasks: TaskRow[];
  events: EventRow[];
  bridge?: Pick<BridgeHealth, 'lastIngestAt' | 'lastIngestSource'>;
}
export type WsMessage = Delta | { type: 'hello'; cursor: number } | { type: 'pong' };

export interface FileRow {
  id: string;
  name: string;
  mime: string;
  size: number;
  folderId: string | null;
  createdAt: number;
}
export interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}
