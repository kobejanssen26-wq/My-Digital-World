import { Canvas } from '@react-three/fiber';
import { useMemo } from 'react';
import { BUILDINGS, type BuildingId, type ProjectRow } from '@mdw/shared';
import type { Data } from '../lib/data.js';
import { computeMetrics, projectStatus } from '../lib/metrics.js';
import { useStore } from '../store.js';
import { Actors } from './Actors.js';
import { CameraRig } from './CameraRig.js';
import { City, type BuildingState } from './City.js';
import { HOME } from '../lib/camera.js';

const WORKING = new Set(['received', 'planning', 'in_development', 'testing']);

export function buildingStates(data: Data, projects: ProjectRow[], now: number): Record<BuildingId, BuildingState> {
  const out = Object.fromEntries(BUILDINGS.map((b) => [b, { count: 0, lit: 0, alert: false }])) as Record<BuildingId, BuildingState>;
  for (const p of projects) {
    const st = projectStatus(p, data, now);
    const b = out[p.building];
    b.count++;
    if (WORKING.has(st.key)) b.lit = Math.min(1, b.lit + 0.5);
    if (st.tone === 'bad') b.alert = true;
  }
  const m = computeMetrics(data, now);
  out.hq = { count: projects.length, lit: m.connectedSessions > 0 ? 1 : 0, alert: m.tasksNeedingAttention > 0 };
  out.cloud = { count: data.stats.files, lit: data.stats.files > 0 ? 0.3 : 0, alert: false };
  return out;
}

export default function Scene({ visible, all, data, now, reduced, light }: { visible: ProjectRow[]; all: ProjectRow[]; data: Data; now: number; reduced: boolean; light: boolean }) {
  const states = useMemo(() => buildingStates(data, all, now), [data, all, now]);
  const select = useStore((s) => s.select);
  const selectBuilding = useStore((s) => s.selectBuilding);
  const animate = !reduced;
  return (
    <Canvas
      shadows={!light}
      dpr={light ? 1 : [1, 1.75]}
      frameloop={reduced ? 'demand' : 'always'}
      camera={{ position: HOME.position, fov: 38, near: 0.5, far: 400 }}
      gl={{ antialias: !light, powerPreference: light ? 'low-power' : 'high-performance' }}
      onPointerMissed={() => (select(null), selectBuilding(null))}
      aria-label="Interactive 3D city of your projects"
      data-testid="world-canvas"
    >
      <color attach="background" args={[matchMedia('(prefers-color-scheme: dark)').matches ? '#0e1a30' : '#dfe9f6']} />
      <fog attach="fog" args={[matchMedia('(prefers-color-scheme: dark)').matches ? '#0e1a30' : '#dfe9f6', 120, 260]} />
      <hemisphereLight args={['#ffffff', '#8aa0bd', 1.0]} />
      <directionalLight position={[40, 70, 30]} intensity={1.7} castShadow={!light} shadow-mapSize={[2048, 2048]} shadow-camera-left={-70} shadow-camera-right={70} shadow-camera-top={70} shadow-camera-bottom={-70} shadow-camera-near={10} shadow-camera-far={220} shadow-bias={-0.0005} />
      <City states={states} animate={animate} light={light} />
      <Actors projects={visible} all={all} data={data} now={now} animate={animate} reduced={reduced} />
      <CameraRig reduced={reduced} />
    </Canvas>
  );
}
