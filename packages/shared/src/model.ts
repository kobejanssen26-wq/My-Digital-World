/** Domain model shared by worker, bridge and web. */

export const TASK_STATUSES = [
  'received',
  'planning',
  'in_development',
  'waiting_input',
  'testing',
  'needs_attention',
  'ready_for_review',
  'completed',
  'paused',
  'failed',
  'interrupted',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Task statuses that no longer receive automatic progress. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'interrupted'];
export const isOpenTask = (s: TaskStatus) => !TERMINAL_TASK_STATUSES.includes(s);

export const TASK_KINDS = [
  'question',
  'bugfix',
  'feature',
  'refactor',
  'experiment',
  'build',
  'other',
  'activity', // implicit task created from tool use when no prompt was observed
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const PROMPT_KINDS = ['question', 'bugfix', 'feature', 'refactor', 'experiment', 'build', 'other', 'continuation'] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const SESSION_STATUSES = ['active', 'idle', 'ended', 'lost'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const TEST_STATUSES = ['unknown', 'running', 'passing', 'failing'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

/** "command_succeeded" is deliberately not "live": we never verify a URL. */
export const DEPLOY_STATUSES = ['none', 'ready', 'running', 'command_succeeded', 'failed'] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export const LIFECYCLES = ['new', 'active', 'attention', 'idle', 'paused', 'completed'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export const BUILDINGS = [
  'hq',
  'intake',
  'planning',
  'development',
  'testing',
  'workshop',
  'deployment',
  'completed',
  'cloud',
] as const;
export type BuildingId = (typeof BUILDINGS)[number];
/** Buildings a project can be located in (hq and cloud are infrastructure). */
export type ProjectBuilding = Exclude<BuildingId, 'hq' | 'cloud'>;

export interface ProjectRow {
  id: string;
  name: string;
  summary: string;
  repo: string | null; // normalized public identity, e.g. github.com/owner/repo
  projectType: string | null;
  lifecycle: Lifecycle;
  activityLevel: 'observed' | 'developing';
  testStatus: TestStatus;
  deployStatus: DeployStatus;
  deployHints: string[];
  userPaused: boolean;
  building: ProjectBuilding;
  slot: number;
  x: number;
  z: number;
  hue: number;
  firstSeen: number;
  lastActive: number;
  version: number; // seq of last event applied
}

export interface SessionRow {
  id: string;
  projectId: string;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  lastEventAt: number;
  stateTs: number;
  permissionMode: string | null;
}

export interface TaskRow {
  id: string;
  projectId: string;
  sessionId: string | null;
  kind: TaskKind;
  summary: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  stateTs: number;
  completedAt: number | null;
  completionBasis: string | null;
  failStreak: number;
  version: number;
}

export interface EventRow {
  seq: number;
  id: string;
  type: string;
  projectId: string | null;
  sessionId: string | null;
  taskId: string | null;
  ts: number;
  ingestedAt: number;
  late: boolean;
  data: Record<string, unknown>;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  received: 'Received',
  planning: 'Planning / investigating',
  in_development: 'In development',
  waiting_input: 'Waiting for input',
  testing: 'Testing',
  needs_attention: 'Needs attention',
  ready_for_review: 'Ready for review',
  completed: 'Completed',
  paused: 'Paused',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export const BUILDING_LABEL: Record<BuildingId, string> = {
  hq: 'Headquarters',
  intake: 'Project Intake',
  planning: 'Planning Office',
  development: 'Development District',
  testing: 'Testing Center',
  workshop: 'Repair Workshop',
  deployment: 'Deployment Center',
  completed: 'Completed Projects',
  cloud: 'Personal Cloud',
};
