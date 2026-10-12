import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { clampTarget, easeToward, HOME } from '../lib/camera.js';
import { useStore } from '../store.js';

/** Orbit / zoom / pan, plus animated "focus project/building" and "reset" commands from the store. */
export function CameraRig({ reduced }: { reduced: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const goal = useRef<{ target: [number, number, number]; cam?: [number, number, number] } | null>(null);
  const cmd = useStore((s) => s.camera);
  const { camera, invalidate } = useThree();

  useEffect(() => {
    if (!cmd || !controls.current) return;
    if (cmd.kind === 'reset') goal.current = { target: [...HOME.target], cam: [...HOME.position] };
    else {
      const [x, z] = clampTarget(cmd.x, cmd.z);
      goal.current = { target: [x, 0, z] };
    }
    if (reduced) {
      const c = controls.current;
      const g = goal.current;
      const dx = g.target[0] - c.target.x, dz = g.target[2] - c.target.z;
      c.target.set(...g.target);
      if (g.cam) camera.position.set(...g.cam);
      else camera.position.add({ x: dx, y: 0, z: dz } as never);
      c.update();
      goal.current = null;
      invalidate();
    }
  }, [cmd, reduced, camera, invalidate]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const g = goal.current;
    if (g) {
      const tx = easeToward(c.target.x, g.target[0], dt), tz = easeToward(c.target.z, g.target[2], dt);
      const dx = tx - c.target.x, dz = tz - c.target.z;
      c.target.x = tx;
      c.target.z = tz;
      if (g.cam) {
        camera.position.x = easeToward(camera.position.x, g.cam[0], dt);
        camera.position.y = easeToward(camera.position.y, g.cam[1], dt);
        camera.position.z = easeToward(camera.position.z, g.cam[2], dt);
        c.target.y = easeToward(c.target.y, g.target[1], dt);
      } else {
        camera.position.x += dx;
        camera.position.z += dz;
      }
      c.update();
      if (c.target.x === g.target[0] && c.target.z === g.target[2] && (!g.cam || Math.abs(camera.position.x - g.cam[0]) < 0.05)) goal.current = null;
    }
    // Keep the pan target inside the world.
    const [cx, cz] = clampTarget(c.target.x, c.target.z);
    if (cx !== c.target.x || cz !== c.target.z) {
      camera.position.x += cx - c.target.x;
      camera.position.z += cz - c.target.z;
      c.target.x = cx;
      c.target.z = cz;
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={HOME.target}
      enableDamping={!reduced}
      dampingFactor={0.1}
      minDistance={14}
      maxDistance={130}
      minPolarAngle={0.25}
      maxPolarAngle={1.3}
      screenSpacePanning={false}
      zoomToCursor={false}
      mouseButtons={{ LEFT: 0, MIDDLE: 1, RIGHT: 2 }}
    />
  );
}
