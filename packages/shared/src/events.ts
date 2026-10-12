import { z } from 'zod';
import { PROMPT_KINDS } from './model.js';

export const SCHEMA_VERSION = 1;

/**
 * Event types emitted by the local bridge. Each maps to a documented Claude Code
 * hook (see docs/CLAUDE_CODE_INTEGRATION.md). Unknown types are rejected.
 */
export const EVENT_TYPES = [
  'session.start', // SessionStart
  'session.end', // SessionEnd
  'prompt.submit', // UserPromptSubmit
  'tool.start', // PreToolUse (only test/deploy-class Bash commands)
  'tool.done', // PostToolUse
  'tool.fail', // PostToolUseFailure
  'notification', // Notification
  'subagent.start', // SubagentStart
  'subagent.stop', // SubagentStop
  'turn.stop', // Stop
  'turn.fail', // StopFailure
  'user.action', // produced by the dashboard itself, never by the bridge
  'system.maintenance', // produced by the worker's periodic sweep
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
const EVENT_TYPES_TUPLE = ['session.start','session.end','prompt.submit','tool.start','tool.done','tool.fail','notification','subagent.start','subagent.stop','turn.stop','turn.fail'] as const;
export const BRIDGE_EVENT_TYPES = EVENT_TYPES_TUPLE;

export const TOOL_CATEGORIES = ['read', 'modify', 'test', 'build', 'deploy', 'shell', 'agent', 'web', 'other'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

const identityKey = z.string().regex(/^(remote|path|root):[A-Za-z0-9._:/@+-]{3,200}$/);

export const ProjectRefSchema = z
  .object({
    /** Identity keys in priority order: remote > path(hash) > root commit. */
    keys: z.array(identityKey).min(1).max(4),
    name: z.string().min(1).max(80),
    /** Normalized public repo identity, optional by privacy setting. */
    repo: z.string().max(200).optional(),
    type: z.string().max(40).optional(),
    isNew: z.boolean().optional(),
    deployHints: z.array(z.string().max(40)).max(8).optional(),
  })
  .strict();
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const EventDataSchema = z
  .object({
    hook: z.string().max(40).optional(),
    source: z.string().max(40).optional(), // SessionStart.source
    reason: z.string().max(60).optional(), // SessionEnd.reason / StopFailure.error
    permissionMode: z.string().max(30).optional(),
    // prompt.submit
    promptKind: z.enum(PROMPT_KINDS).optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
    summary: z.string().max(200).optional(),
    words: z.number().int().min(0).max(100000).optional(),
    // tool.*
    tool: z.string().max(80).optional(),
    category: z.enum(TOOL_CATEGORIES).optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
    errorKind: z.string().max(60).optional(),
    // notification
    notificationType: z.string().max(60).optional(),
    // subagent.*
    agentType: z.string().max(60).optional(),
    // user.action
    action: z.string().max(40).optional(),
    targetId: z.string().max(80).optional(),
  })
  .strict();
export type EventData = z.infer<typeof EventDataSchema>;

export const EnvelopeSchema = z
  .object({
    v: z.literal(SCHEMA_VERSION),
    id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    ts: z.number().int().min(1_500_000_000_000).max(4_000_000_000_000),
    source: z.string().min(1).max(80),
    type: z.enum(EVENT_TYPES_TUPLE),
    sessionId: z.string().min(1).max(128),
    project: ProjectRefSchema.optional(),
    data: EventDataSchema.default({}),
  })
  .strict();
export type Envelope = Omit<z.infer<typeof EnvelopeSchema>, 'type'> & { type: Exclude<EventType, 'user.action' | 'system.maintenance'> };

export const IngestBodySchema = z.object({ events: z.array(z.unknown()).min(1).max(100) });

export type IngestResult =
  | { id: string; status: 'accepted'; seq: number; late: boolean }
  | { id: string; status: 'duplicate' }
  | { id: string; status: 'rejected'; reason: string };

export function parseEnvelope(raw: unknown): { ok: true; event: Envelope } | { ok: false; id: string; reason: string } {
  const id = typeof (raw as { id?: unknown })?.id === 'string' ? ((raw as { id: string }).id as string) : '?';
  const r = EnvelopeSchema.safeParse(raw);
  if (r.success) return { ok: true, event: r.data as Envelope };
  const first = r.error.issues[0];
  const typeIssue = first && first.path[0] === 'type';
  return {
    ok: false,
    id,
    reason: typeIssue ? 'unknown_event_type' : `invalid:${first?.path.join('.') ?? ''}:${first?.code ?? ''}`,
  };
}
