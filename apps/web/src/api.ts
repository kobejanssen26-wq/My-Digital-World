import type { Snapshot, EventRow, FileRow, FolderRow, ProjectRow, TaskRow, SessionRow, Settings } from '@mdw/shared';

let csrf: string | null = null;
export const setCsrf = (v: string | null) => (csrf = v);

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function req<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(init.json);
  }
  if (csrf && (init.method ?? 'GET') !== 'GET') headers.set('x-csrf-token', csrf);
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface Me {
  authenticated: boolean;
  csrf?: string;
  configured?: boolean;
}

export const api = {
  me: () => req<Me>('/api/me'),
  login: (password: string) => req<{ ok: true; csrf: string }>('/api/auth/login', { method: 'POST', json: { password } }),
  logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  snapshot: () => req<Snapshot>('/api/snapshot'),
  events: (q: { before?: number; after?: number; project?: string; type?: string; limit?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return req<{ events: EventRow[]; hasMore: boolean; cursor: number }>(`/api/events?${p}`);
  },
  project: (id: string) => req<{ project: ProjectRow; tasks: TaskRow[]; sessions: SessionRow[]; events: EventRow[] }>(`/api/projects/${encodeURIComponent(id)}`),
  action: (a: Record<string, unknown>) => req<{ ok: true }>('/api/actions', { method: 'POST', json: a }),
  search: (q: string) => req<{ projects: ProjectRow[]; tasks: TaskRow[]; files: FileRow[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  saveSettings: (s: Partial<Settings>) => req<{ settings: Settings }>('/api/settings', { method: 'PUT', json: s }),
  createToken: (name: string) => req<{ id: string; name: string; token: string }>('/api/bridge/tokens', { method: 'POST', json: { name } }),
  revokeToken: (id: string) => req<{ ok: true }>(`/api/bridge/tokens/${id}`, { method: 'DELETE' }),
  files: (opts: { folder?: string | null; q?: string }) => {
    const p = new URLSearchParams();
    if (opts.folder) p.set('folder', opts.folder);
    if (opts.q) p.set('q', opts.q);
    return req<{ available: boolean; files: FileRow[]; folders: FolderRow[]; usage: { bytes: number; files: number; limitBytes: number; maxUploadBytes: number } }>(`/api/files?${p}`);
  },
  createFolder: (name: string, parentId: string | null) => req<FolderRow>('/api/files/folders', { method: 'POST', json: { name, parentId } }),
  deleteFolder: (id: string) => req<{ ok: true }>(`/api/files/folders/${id}`, { method: 'DELETE' }),
  deleteFile: (id: string) => req<{ ok: true }>(`/api/files/${id}`, { method: 'DELETE' }),
  upload: (file: File, folder: string | null) =>
    req<FileRow>(`/api/files?name=${encodeURIComponent(file.name)}${folder ? `&folder=${folder}` : ''}`, {
      method: 'PUT',
      body: file,
      headers: { 'content-type': file.type || 'application/octet-stream' },
    }),
};
