import { useLayoutEffect, useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import { InstancedMesh, Object3D } from 'three';
import { BUILDING_SPECS, BUILDINGS, ROADS, type BuildingId } from '@mdw/shared';
import { BUILDING_COMPONENTS } from './Buildings.js';
import { C } from './palette.js';
import { Box } from './Primitives.js';
import { useStore } from '../store.js';

export interface BuildingState {
  count: number;
  lit: number;
  alert: boolean;
}

const dummy = new Object3D();

function Roads({ light }: { light: boolean }) {
  const edges = useMemo(() => {
    const seen = new Set<string>();
    const out: { a: [number, number]; b: [number, number] }[] = [];
    for (const [id, nbrs] of Object.entries(ROADS.edges))
      for (const n of nbrs) {
        const key = [id, n].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ a: ROADS.nodes[id]!, b: ROADS.nodes[n]! });
      }
    return out;
  }, []);
  const dashes = useMemo(() => {
    const out: { x: number; z: number; rot: number }[] = [];
    for (const { a, b } of edges) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.floor(len / 3);
      const rot = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 0 : Math.PI / 2;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, rot });
      }
    }
    return out;
  }, [edges]);
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    dashes.forEach((d, i) => {
      dummy.position.set(d.x, 0.07, d.z);
      dummy.rotation.set(0, d.rot, 0);
      dummy.updateMatrix();
      ref.current!.setMatrixAt(i, dummy.matrix);
    });
    ref.current!.instanceMatrix.needsUpdate = true;
  }, [dashes]);
  return (
    <group>
      {edges.map((e, i) => {
        const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
        const horizontal = Math.abs(e.b[0] - e.a[0]) > Math.abs(e.b[1] - e.a[1]);
        return <mesh key={i} position={[(e.a[0] + e.b[0]) / 2, 0.03, (e.a[1] + e.b[1]) / 2]} receiveShadow><boxGeometry args={horizontal ? [len + 2.4, 0.06, 2.4] : [2.4, 0.06, len + 2.4]} /><meshStandardMaterial color={C.road} roughness={1} /></mesh>;
      })}
      <instancedMesh ref={ref} args={[undefined, undefined, dashes.length]}>
        <boxGeometry args={[1.2, 0.02, 0.14]} />
        <meshStandardMaterial color={light ? C.line : C.steel} />
      </instancedMesh>
    </group>
  );
}

function Trees({ light }: { light: boolean }) {
  const spots = useMemo(() => {
    const out: [number, number, number][] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const spec of Object.values(BUILDING_SPECS)) {
      const [cx, cz] = spec.center;
      for (const [dx, dz] of [[-8.3, -8.3], [8.3, -8.3], [-8.3, 2], [8.3, 2], ...(light ? [] : [[-8.3, 8.4], [8.3, 8.4], [0, -9.2]])] as [number, number][])
        out.push([cx + dx + (rnd() - 0.5) * 0.8, cz + dz + (rnd() - 0.5) * 0.8, 0.8 + rnd() * 0.5]);
    }
    for (const lane of [-44, 44]) for (let i = -40; i <= 40; i += 10) { out.push([lane, i, 1]); out.push([i, lane, 1]); }
    return out;
  }, [light]);
  const crowns = useRef<InstancedMesh>(null);
  const trunks = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    spots.forEach(([x, z, s], i) => {
      dummy.rotation.set(0, i, 0);
      dummy.position.set(x, 1.7 * s + 0.6, z);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      crowns.current!.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, 0.5 * s, z);
      dummy.updateMatrix();
      trunks.current!.setMatrixAt(i, dummy.matrix);
    });
    crowns.current!.instanceMatrix.needsUpdate = true;
    trunks.current!.instanceMatrix.needsUpdate = true;
  }, [spots]);
  return (
    <group>
      <instancedMesh ref={crowns} args={[undefined, undefined, spots.length]} castShadow>
        <coneGeometry args={[1.1, 2.6, 7]} />
        <meshStandardMaterial color={C.tree} flatShading />
      </instancedMesh>
      <instancedMesh ref={trunks} args={[undefined, undefined, spots.length]}>
        <cylinderGeometry args={[0.18, 0.22, 1, 6]} />
        <meshStandardMaterial color={C.trunk} flatShading />
      </instancedMesh>
    </group>
  );
}

export function City({ states, animate, light }: { states: Record<BuildingId, BuildingState>; animate: boolean; light: boolean }) {
  const selectBuilding = useStore((s) => s.selectBuilding);
  const focus = useStore((s) => s.focus);
  const selected = useStore((s) => s.selectedBuilding);
  return (
    <group>
      <Box pos={[0, -1, 0]} size={[104, 1, 104]} color={C.ground} />
      {Object.values(BUILDING_SPECS).map((s) => (
        <Box key={s.id} pos={[s.center[0], 0, s.center[1]]} size={[19, 0.12, 19]} color={C.grass} shadow={false} />
      ))}
      <Roads light={light} />
      <Trees light={light} />
      {BUILDINGS.map((id) => {
        const spec = BUILDING_SPECS[id];
        const st = states[id];
        const B = BUILDING_COMPONENTS[id];
        return (
          <group
            key={id}
            position={[spec.center[0], 0.1, spec.center[1] - 1.5]}
            onClick={(e) => {
              e.stopPropagation();
              selectBuilding(id);
              focus(spec.center[0], spec.center[1]);
            }}
            onPointerOver={() => (document.body.style.cursor = 'pointer')}
            onPointerOut={() => (document.body.style.cursor = '')}
          >
            <B lit={st.lit} animate={animate} alert={st.alert} />
            {selected === id && (
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.2, 1.5]}>
                <ringGeometry args={[10.2, 10.6, 48]} />
                <meshBasicMaterial color={C.info} />
              </mesh>
            )}
            <Html position={[0, id === 'hq' ? 18.5 : 11, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
              <div className="bldg-label">{spec.label}{st.count > 0 && <b>{st.count}</b>}</div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
