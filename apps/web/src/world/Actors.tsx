import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { shapeFor, type Actor, type ProjectRow } from '@mdw/shared';
import { reconcileActors, stepActors } from '../lib/actors.js';
import type { Data } from '../lib/data.js';
import { projectStatus } from '../lib/metrics.js';
import { useStore } from '../store.js';
import { C, TONE_COLOR } from './palette.js';
import { Box } from './Primitives.js';

const WORKING = new Set(['received', 'planning', 'in_development', 'testing']);

function Vehicle({ hue, shape, dim }: { hue: number; shape: 0 | 1 | 2; dim: boolean }) {
  const cargo = dim ? '#aab4c3' : `hsl(${hue} 68% 55%)`;
  return (
    <group scale={1.7}>
      <Box pos={[0, 0.25, -0.5]} size={[0.95, 0.3, 1.5]} color={C.white} />
      <Box pos={[0, 0.25, 0.75]} size={[0.95, 0.85, 0.9]} color={dim ? '#7f8da3' : C.blue} />
      <Box pos={[0, 0.78, 0.98]} size={[0.8, 0.3, 0.05]} color={C.glass} shadow={false} />
      {shape === 0 && <Box pos={[0, 0.55, -0.55]} size={[0.8, 0.8, 1.2]} color={cargo} />}
      {shape === 1 && <Box pos={[0, 0.55, -0.55]} size={[0.8, 0.5, 1.3]} color={cargo} />}
      {shape === 2 && (
        <>
          <Box pos={[0, 0.55, -0.2]} size={[0.8, 0.6, 0.6]} color={cargo} />
          <Box pos={[0, 0.55, -0.9]} size={[0.8, 0.9, 0.6]} color={cargo} />
        </>
      )}
      {[-0.5, 0.5].flatMap((x) => [-1, 0.8].map((z) => (
        <mesh key={`${x}${z}`} position={[x * 0.95, 0.2, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.2, 0.2, 0.15, 10]} />
          <meshStandardMaterial color={C.dark} />
        </mesh>
      )))}
    </group>
  );
}

function SmallBuilding({ hue }: { hue: number }) {
  return (
    <group>
      <Box pos={[0, 0, 0]} size={[1.7, 1.5, 1.7]} color={C.white} />
      <Box pos={[0, 1.5, 0]} size={[1.9, 0.3, 1.9]} color={`hsl(${hue} 68% 50%)`} />
      <Box pos={[0, 0, 0.86]} size={[0.5, 0.9, 0.05]} color={C.dark} shadow={false} />
    </group>
  );
}

function ProjectActor({ project, actors, data, now, animate }: { project: ProjectRow; actors: React.MutableRefObject<Map<string, Actor>>; data: Data; now: number; animate: boolean }) {
  const group = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const selected = useStore((s) => s.selectedId === project.id);
  const hovered = useStore((s) => s.hoveredId === project.id);
  const select = useStore((s) => s.select);
  const hover = useStore((s) => s.hover);
  const st = projectStatus(project, data, now);
  const working = WORKING.has(st.key);
  const dim = st.key === 'paused' || st.key === 'disconnected';
  const arrivedDone = project.building === 'completed';
  const color = TONE_COLOR[st.tone];

  useFrame(({ clock }) => {
    const a = actors.current.get(project.id);
    if (a && group.current) {
      group.current.position.set(a.pos[0], 0.12, a.pos[1]);
      group.current.rotation.y = a.route.length ? a.heading : group.current.rotation.y;
      if (!a.route.length && !arrivedDone) group.current.rotation.y = 0;
    }
    if (ring.current) {
      const s = animate && working ? 1 + (Math.sin(clock.elapsedTime * 3) + 1) * 0.12 : 1;
      ring.current.scale.set(s, s, s);
      (ring.current.material as MeshStandardMaterial).opacity = animate && working ? 0.45 + Math.sin(clock.elapsedTime * 3) * 0.2 : 0.55;
    }
  });

  return (
    <group
      ref={group}
      onClick={(e) => {
        e.stopPropagation();
        select(project.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        hover(project.id);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        hover(null);
        document.body.style.cursor = '';
      }}
    >
      {arrivedDone && !(actors.current.get(project.id)?.route.length) ? <SmallBuilding hue={project.hue} /> : <Vehicle hue={project.hue} shape={shapeFor(project.id)} dim={dim} />}
      {(working || selected || st.tone === 'bad' || st.tone === 'warn') && (
        <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[selected ? 2.3 : 1.9, selected ? 2.6 : 2.15, 28]} />
          <meshStandardMaterial color={selected ? C.info : color} transparent opacity={0.55} />
        </mesh>
      )}
      <mesh position={[0, arrivedDone ? 2.4 : 1.9, 0]}>
        <sphereGeometry args={[0.2, 10, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={dim ? 0 : 1.2} />
      </mesh>
      {(hovered || selected) && (
        <Html position={[0, 2.8, 0]} center zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
          <div className="tooltip"><b>{project.name}</b> · {st.label}</div>
        </Html>
      )}
    </group>
  );
}

export function Actors({ projects, all, data, now, animate, reduced }: { projects: ProjectRow[]; all: ProjectRow[]; data: Data; now: number; animate: boolean; reduced: boolean }) {
  const actors = useRef<Map<string, Actor>>(new Map());
  const first = useRef(true);
  const invalidate = useRef<(() => void) | null>(null);

  // Persisted state -> animation targets. The first pass (page load / reconnect) places vehicles instantly.
  useEffect(() => {
    const r = reconcileActors(actors.current, all, { instant: reduced || first.current });
    actors.current = r.actors;
    first.current = false;
  }, [all, reduced]);

  useFrame((state, dt) => {
    invalidate.current = state.invalidate;
    stepActors(actors.current, Math.min(dt, 0.1));
  });

  const visible = useMemo(() => projects, [projects]);
  return (
    <group>
      {visible.map((p) => (
        <ProjectActor key={p.id} project={p} actors={actors} data={data} now={now} animate={animate} />
      ))}
    </group>
  );
}
