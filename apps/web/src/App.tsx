import { lazy, Suspense, useEffect } from 'react';
import { Login } from './components/Login.js';
import { Shell } from './components/Shell.js';
import { ErrorBanner } from './components/ui.js';
import { startRealtime } from './realtime.js';
import { routeFromHash, useStore } from './store.js';

const WorldView = lazy(() => import('./views/WorldView.js'));
const ProjectsView = lazy(() => import('./views/ProjectsView.js'));
const ActivityView = lazy(() => import('./views/ActivityView.js'));
const TasksView = lazy(() => import('./views/TasksView.js'));
const CloudView = lazy(() => import('./views/CloudView.js'));
const SettingsView = lazy(() => import('./views/SettingsView.js'));

export function App() {
  const auth = useStore((s) => s.auth);
  const route = useStore((s) => s.route);
  const reduced = useStore((s) => s.data.settings.reducedMotion);

  useEffect(() => {
    void useStore.getState().boot();
    const onHash = () => {
      const { route, id } = routeFromHash(location.hash);
      useStore.setState({ route, selectedId: id ?? useStore.getState().selectedId });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => (auth === 'authed' ? startRealtime() : undefined), [auth]);
  useEffect(() => {
    document.documentElement.classList.toggle('reduced', reduced);
  }, [reduced]);

  if (auth === 'loading') return <div className="login muted" role="status">Loading…</div>;
  if (auth === 'error') return <div className="login"><ErrorBanner>Could not reach the server. Check your connection and reload.</ErrorBanner></div>;
  if (auth !== 'authed') return <Login unconfigured={auth === 'unconfigured'} />;

  return (
    <Shell>
      <Suspense fallback={<div className="page muted" role="status">Loading view…</div>}>
        {route === 'world' && <WorldView />}
        {route === 'projects' && <ProjectsView />}
        {route === 'activity' && <ActivityView />}
        {route === 'tasks' && <TasksView />}
        {route === 'cloud' && <CloudView />}
        {route === 'settings' && <SettingsView />}
      </Suspense>
    </Shell>
  );
}
