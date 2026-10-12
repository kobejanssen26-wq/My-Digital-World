import type { ThreeElements } from '@react-three/fiber';

type P = { pos?: [number, number, number]; size: [number, number, number]; color: string; shadow?: boolean; emissive?: string; ei?: number; opacity?: number } & Omit<ThreeElements['mesh'], 'position' | 'args'>;

export function Box({ pos = [0, 0, 0], size, color, shadow = true, emissive, ei = 0, opacity, ...rest }: P) {
  return (
    <mesh position={[pos[0], pos[1] + size[1] / 2, pos[2]]} castShadow={shadow} receiveShadow {...rest}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} flatShading roughness={0.85} metalness={0.05} emissive={emissive ?? '#000'} emissiveIntensity={ei} transparent={opacity !== undefined} opacity={opacity ?? 1} />
    </mesh>
  );
}

export function Cyl({ pos = [0, 0, 0], r, h, color, seg = 12, emissive, ei = 0 }: { pos?: [number, number, number]; r: number; h: number; color: string; seg?: number; emissive?: string; ei?: number }) {
  return (
    <mesh position={[pos[0], pos[1] + h / 2, pos[2]]} castShadow receiveShadow>
      <cylinderGeometry args={[r, r, h, seg]} />
      <meshStandardMaterial color={color} flatShading roughness={0.8} emissive={emissive ?? '#000'} emissiveIntensity={ei} />
    </mesh>
  );
}
