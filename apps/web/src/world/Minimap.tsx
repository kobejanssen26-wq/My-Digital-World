import { BUILDING_SPECS, type ProjectRow } from '@mdw/shared';
import { useStore } from '../store.js';
import { TONE_COLOR } from './palette.js';
import { projectStatus } from '../lib/metrics.js';
import type { Data } from '../lib/data.js';

const SIZE = 104; // world extent shown (-52..52)

export function Minimap({ projects, data, now }: { projects: ProjectRow[]; data: Data; now: number }) {
  const focus = useStore((s) => s.focus);
  const selectedId = useStore((s) => s.selectedId);
  const selectedBuilding = useStore((s) => s.selectedBuilding);
  const toWorld = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    focus(((e.clientX - r.left) / r.width - 0.5) * SIZE, ((e.clientY - r.top) / r.height - 0.5) * SIZE);
  };
  return (
    <svg className="minimap glass" viewBox={`${-SIZE / 2} ${-SIZE / 2} ${SIZE} ${SIZE}`} role="img" aria-label="World minimap. Click to move the camera." onClick={toWorld}>
      <rect x={-SIZE / 2} y={-SIZE / 2} width={SIZE} height={SIZE} fill="#e6ecf4" opacity="0.7" />
      {[-33, -11, 11, 33].flatMap((v) => [<line key={`h${v}`} x1={-33} x2={33} y1={v} y2={v} stroke="#8b97a8" strokeWidth="1.4" />, <line key={`v${v}`} y1={-33} y2={33} x1={v} x2={v} stroke="#8b97a8" strokeWidth="1.4" />])}
      {Object.values(BUILDING_SPECS).map((b) => (
        <rect key={b.id} x={b.center[0] - 6} y={b.center[1] - 7} width={12} height={12} rx={1.5} fill={selectedBuilding === b.id ? '#2563eb' : '#2f6fb5'} opacity={selectedBuilding === b.id ? 0.95 : 0.55}>
          <title>{b.label}</title>
        </rect>
      ))}
      {projects.map((p) => {
        const st = projectStatus(p, data, now);
        return <circle key={p.id} cx={p.x} cy={p.z} r={selectedId === p.id ? 2.4 : 1.6} fill={TONE_COLOR[st.tone]} stroke="#fff" strokeWidth="0.5" />;
      })}
    </svg>
  );
}
