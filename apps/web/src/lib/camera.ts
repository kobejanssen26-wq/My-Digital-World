/** Camera helpers kept pure so they can be unit-tested without WebGL. */
export const HOME = { position: [54, 60, 70] as [number, number, number], target: [0, 0, 4] as [number, number, number] };
export const BOUNDS = 44;

export const clampTarget = (x: number, z: number): [number, number] => [Math.max(-BOUNDS, Math.min(BOUNDS, x)), Math.max(-BOUNDS, Math.min(BOUNDS, z))];

/** Frame-rate independent exponential easing toward a target. */
export function easeToward(current: number, target: number, dt: number, rate = 5): number {
  const k = 1 - Math.exp(-rate * dt);
  const v = current + (target - current) * k;
  return Math.abs(target - v) < 0.01 ? target : v;
}
