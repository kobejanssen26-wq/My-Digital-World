// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ProjectRow, type Snapshot } from '@mdw/shared';
import { Login } from '../src/components/Login.js';
import { fromSnapshot, EMPTY_DATA } from '../src/lib/data.js';
import { useStore } from '../src/store.js';
import ProjectsView from '../src/views/ProjectsView.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.now();
const project = (id: string, name: string, o: Partial<ProjectRow> = {}): ProjectRow => ({
  id, name, summary: `${name} summary`, repo: null, projectType: null, lifecycle: 'active', activityLevel: 'developing', testStatus: 'unknown', deployStatus: 'none',
  deployHints: [], userPaused: false, building: 'development', slot: 0, x: 0, z: 0, hue: 10, firstSeen: NOW, lastActive: NOW, version: 1, ...o,
});
const snap = (projects: ProjectRow[]): Snapshot => ({
  cursor: 1, serverTime: NOW, projects, sessions: [], tasks: [], events: [], stats: { files: 0, storageBytes: 0, storageLimitBytes: 0, r2: true },
  bridge: { tokens: [], lastIngestAt: null, lastIngestSource: null }, settings: DEFAULT_SETTINGS,
});

beforeEach(() => {
  useStore.setState({ filter: 'all', query: '', showObserved: false, selectedId: null, data: EMPTY_DATA, now: NOW });
});
afterEach(cleanup);

describe('Login', () => {
  it('shows an error for a wrong password and keeps the user on the form', async () => {
    useStore.setState({ login: vi.fn().mockRejectedValue(Object.assign(new Error('invalid_credentials'), { code: 'invalid_credentials', status: 401 })) });
    const { ApiError } = await import('../src/api.js');
    useStore.setState({ login: vi.fn().mockRejectedValue(new ApiError(401, 'invalid_credentials')) });
    render(<Login unconfigured={false} />);
    const btn = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'nope' } });
    fireEvent.click(btn);
    expect((await screen.findByRole('alert')).textContent).toContain('Wrong password');
  });
  it('explains when the deployment has no password configured', () => {
    render(<Login unconfigured />);
    expect(screen.getByRole('alert').textContent).toContain('setup:secrets');
  });
});

describe('ProjectsView', () => {
  it('shows a loading state before data arrives', () => {
    render(<ProjectsView />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
  });
  it('shows setup instructions (not fake projects) when nothing has been recorded', () => {
    useStore.setState({ data: fromSnapshot(snap([]), NOW) });
    render(<ProjectsView />);
    expect(screen.getByText('No Claude Code activity recorded yet')).toBeTruthy();
    expect(screen.getByText(/mdw-bridge init/)).toBeTruthy();
  });
  it('lists real projects, searches by name, filters by state, and opens details', async () => {
    useStore.setState({ data: fromSnapshot(snap([project('a', 'Alpha Site'), project('b', 'Beta API', { lifecycle: 'completed' }), project('c', 'Gamma', { userPaused: true, lifecycle: 'paused' })]), NOW) });
    render(<ProjectsView />);
    expect(screen.getAllByRole('button', { name: /Alpha Site|Beta API|Gamma/ })).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Filter projects by name'), { target: { value: 'beta' } });
    await waitFor(() => expect(screen.queryByText('Alpha Site')).toBeNull());
    expect(screen.getByText('Beta API')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter projects by name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Paused' }));
    await waitFor(() => expect(screen.queryByText('Alpha Site')).toBeNull());
    expect(screen.getByText('Gamma')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(await screen.findByText('Beta API')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Failed / attention' }));
    expect(await screen.findByText('No projects match')).toBeTruthy();
  });
});
