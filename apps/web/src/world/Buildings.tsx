import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import type { BuildingId } from '@mdw/shared';
import { C } from './palette.js';
import { Box, Cyl } from './Primitives.js';

/** Low-poly landmark for each district. `lit` (0..1) drives window glow from real activity. */
export interface BuildingProps {
  lit: number;
  animate: boolean;
  alert: boolean;
}

const glow = (lit: number) => (lit > 0 ? C.glassOn : '#000');

function Beacon({ y, color, animate, on }: { y: number; color: string; animate: boolean; on: boolean }) {
  const ref = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (ref.current && animate) ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 4) * 0.18);
  });
  if (!on) return null;
  return (
    <group ref={ref} position={[0, y, 0]}>
      <mesh>
        <sphereGeometry args={[0.45, 12, 12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} />
      </mesh>
    </group>
  );
}

function Spinner({ children, animate, speed = 0.8 }: { children: React.ReactNode; animate: boolean; speed?: number }) {
  const ref = useRef<Group>(null);
  useFrame((_, dt) => {
    if (ref.current && animate) ref.current.rotation.y += dt * speed;
  });
  return <group ref={ref}>{children}</group>;
}

function Podium({ w = 13, d = 13 }: { w?: number; d?: number }) {
  return <Box size={[w, 0.3, d]} color={C.steel} />;
}

const HQ = ({ lit, animate, alert }: BuildingProps) => (
  <group>
    <Podium />
    <Box pos={[0, 0.3, 0]} size={[7, 1.4, 7]} color={C.white} />
    <Box pos={[0, 1.7, 0]} size={[5, 11, 5]} color={C.blue} />
    {[3, 5.5, 8, 10.5].map((y) => (
      <Box key={y} pos={[0, y, 0]} size={[5.2, 0.8, 5.2]} color={C.glass} emissive={glow(lit)} ei={lit * 0.7} />
    ))}
    <Box pos={[0, 12.7, 0]} size={[3.6, 1.2, 3.6]} color={C.white} />
    <Cyl pos={[0, 13.9, 0]} r={0.12} h={3} color={C.dark} />
    <Beacon y={17.2} color={alert ? C.bad : C.ok} animate={animate} on />
  </group>
);

const Intake = ({ lit }: BuildingProps) => (
  <group>
    <Podium />
    <Box pos={[0, 0.3, -1]} size={[11, 4.2, 7]} color={C.white} />
    <Box pos={[0, 4.5, -1]} size={[11.4, 0.5, 7.4]} color={C.blue} />
    {[-3.5, 0, 3.5].map((x) => (
      <Box key={x} pos={[x, 0.3, 2.55]} size={[2.4, 2.8, 0.2]} color={C.dark} emissive={glow(lit)} ei={lit * 0.4} />
    ))}
    <Box pos={[-4, 0.3, 4.4]} size={[1.2, 1.2, 1.2]} color="#d7b98a" />
    <Box pos={[-2.6, 0.3, 4.4]} size={[1.2, 0.9, 1.2]} color="#e4c99c" />
    <Box pos={[-3.3, 1.5, 4.4]} size={[1, 0.8, 1]} color="#d7b98a" />
  </group>
);

const Planning = ({ lit }: BuildingProps) => (
  <group>
    <Podium />
    <Box pos={[0, 0.3, -0.5]} size={[9, 6, 6.5]} color={C.white} />
    <Box pos={[0, 2, 2.85]} size={[8, 3.4, 0.2]} color={C.glass} emissive={glow(lit)} ei={lit * 0.6} />
    <Box pos={[0, 6.3, -0.5]} size={[9.4, 0.5, 6.9]} color={C.deepBlue} />
    <Box pos={[2.2, 6.8, -1]} size={[3.5, 0.8, 2.5]} color={C.tree} />
    <Box pos={[-5.2, 0.3, 3.8]} size={[0.15, 2.2, 3]} color={C.dark} />
  </group>
);

const Development = ({ lit }: BuildingProps) => (
  <group>
    <Podium />
    {[-3.4, 0, 3.4].map((x, i) => (
      <group key={x} position={[x, 0, i === 1 ? -1.5 : 0.3]}>
        <Box pos={[0, 0.3, 0]} size={[3.2, 3.3, 4.6]} color={C.white} />
        <Box pos={[0, 3.6, 0]} size={[3.4, 0.5, 4.8]} color={C.blue} />
        <Box pos={[0, 1.2, 2.35]} size={[2.2, 1.3, 0.1]} color={C.glass} emissive={glow(lit)} ei={lit * 0.9} />
      </group>
    ))}
    <Cyl pos={[4.8, 0.3, -4]} r={0.7} h={3.4} color={C.steel} />
  </group>
);

const Testing = ({ lit, animate, alert }: BuildingProps) => (
  <group>
    <Podium />
    <Cyl pos={[0, 0.3, 0]} r={4.6} h={3} color={C.white} seg={20} />
    <mesh position={[0, 3.3, 0]} castShadow>
      <sphereGeometry args={[4.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
      <meshStandardMaterial color={C.sky} flatShading emissive={glow(lit)} emissiveIntensity={lit * 0.35} />
    </mesh>
    <Cyl pos={[0, 7.6, 0]} r={0.15} h={1.6} color={C.dark} />
    <Spinner animate={animate} speed={1.2}>
      <Box pos={[0, 9.1, 0]} size={[3.2, 0.2, 0.5]} color={C.dark} />
    </Spinner>
    <Beacon y={10.2} color={alert ? C.bad : C.ok} animate={animate} on={alert || lit > 0} />
  </group>
);

const Workshop = ({ lit, animate, alert }: BuildingProps) => (
  <group>
    <Podium />
    <Box pos={[0, 0.3, -0.5]} size={[10, 4, 7]} color={C.steel} />
    <Box pos={[0, 4.3, -0.5]} size={[10.4, 0.5, 7.4]} color={C.dark} />
    <Box pos={[0, 0.3, 3.05]} size={[5, 3, 0.2]} color={C.dark} emissive={glow(lit)} ei={lit * 0.5} />
    <Spinner animate={animate} speed={0.6}>
      <group position={[0, 6.4, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
          <torusGeometry args={[1.2, 0.35, 6, 8]} />
          <meshStandardMaterial color={C.warn} flatShading />
        </mesh>
      </group>
    </Spinner>
    <Box pos={[0, 4.8, -0.5]} size={[0.4, 1, 0.4]} color={C.dark} />
    <Beacon y={9} color={C.bad} animate={animate} on={alert} />
  </group>
);

const Deployment = ({ lit, animate }: BuildingProps) => (
  <group>
    <Podium />
    <Box pos={[0, 0.3, 0]} size={[10.5, 0.8, 8.5]} color={C.white} />
    {[-4, 4].map((x) => (
      <Box key={x} pos={[x, 1.1, -2.5]} size={[0.7, 8, 0.7]} color={C.blue} />
    ))}
    <Box pos={[0, 8.6, -2.5]} size={[9, 0.7, 0.7]} color={C.blue} />
    <Spinner animate={animate} speed={0.25}>
      <Box pos={[0, 7.2, 0]} size={[0.3, 0.3, 0]} color={C.dark} shadow={false} />
    </Spinner>
    <Box pos={[-2.5, 1.1, 1.5]} size={[3, 1.6, 1.6]} color="#4f7fb8" emissive={glow(lit)} ei={lit * 0.3} />
    <Box pos={[1, 1.1, 1.5]} size={[3, 1.6, 1.6]} color="#9bb7d8" />
    <Box pos={[1, 2.7, 1.5]} size={[3, 1.6, 1.6]} color="#d6e2f0" />
  </group>
);

const Completed = ({ lit }: BuildingProps) => (
  <group>
    <Podium />
    <Box pos={[0, 0.3, -4.2]} size={[8, 0.5, 2]} color={C.white} />
    <Box pos={[0, 0.8, -4.2]} size={[1.2, 3, 1.2]} color={C.blue} emissive={glow(lit)} ei={lit * 0.3} />
    <Cyl pos={[5, 0.3, -4.5]} r={0.1} h={5} color={C.dark} />
    <Box pos={[5.6, 4.2, -4.5]} size={[1.2, 0.8, 0.05]} color={C.blue} />
  </group>
);

const Cloud = ({ lit, animate }: BuildingProps) => (
  <group>
    <Podium />
    {[0, 1.9, 3.8].map((y, i) => (
      <group key={y}>
        <Cyl pos={[0, 0.3 + y, 0]} r={3.4 - i * 0.5} h={1.6} color={C.white} seg={16} />
        <Cyl pos={[0, 1.7 + y, 0]} r={3.5 - i * 0.5} h={0.2} color={C.blue} seg={16} emissive={C.sky} ei={0.6 + lit} />
      </group>
    ))}
    <Cyl pos={[0, 6.3, 0]} r={0.14} h={2} color={C.dark} />
    <Spinner animate={animate} speed={1}>
      <mesh position={[0.9, 8.6, 0]} rotation={[0, 0, 0.5]} castShadow>
        <coneGeometry args={[1, 0.5, 10]} />
        <meshStandardMaterial color={C.steel} flatShading />
      </mesh>
    </Spinner>
  </group>
);

export const BUILDING_COMPONENTS: Record<BuildingId, (p: BuildingProps) => JSX.Element> = {
  hq: HQ,
  intake: Intake,
  planning: Planning,
  development: Development,
  testing: Testing,
  workshop: Workshop,
  deployment: Deployment,
  completed: Completed,
  cloud: Cloud,
};
