import type { PromptKind } from './model.js';
import type { ToolCategory } from './events.js';

export interface PromptClassification {
  kind: PromptKind;
  confidence: 'low' | 'medium' | 'high';
}

const CONTINUATION =
  /^(continue|go on|keep going|carry on|also\b|and\b|now\b|next\b|then\b|yes\b|yep\b|ok\b|okay\b|sure\b|proceed|do it|go ahead|try again|retry|looks good|lgtm|thanks|thank you|please also|one more|that'?s (not|wrong|right)|still\b|why (did|didn'?t|is it)|actually\b)/i;
const QUESTION_START =
  /^(what|why|how|where|when|which|who|can you (explain|tell|show)|could you (explain|tell|show)|does|do|is|are|explain|describe|show me|tell me|summari[sz]e|walk me through)\b/i;
const BUGFIX = /\b(fix|bug|broken|errors?|crash(es|ing)?|fails?|failing|failed|doesn'?t work|not working|regression|exception|stack ?trace)\b/i;
const REFACTOR = /\b(refactor|clean ?up|rename|restructure|simplify|reorgani[sz]e|migrate|modernize|deduplicate)\b/i;
const EXPERIMENT = /\b(experiment|prototype|try out|spike|poc|proof of concept|playground|sandbox|just to see|test whether)\b/i;
const BUILD =
  /\b(build|create|make|generate|scaffold|develop|write|set ?up|start)\b[^.?!]{0,60}\b(app|application|website|web ?site|site|project|game|tool|script|bot|dashboard|api|cli|extension|plugin|library|package|service|landing page|portfolio)\b/i;
const FEATURE = /\b(add|implement|support|enable|integrate|introduce|include|allow|extend|improve|update|change|make it)\b|\b(create|make|write|generate)\b[^.?!]{0,50}\b(file|function|component|page|module|class|endpoint|route|test|command|hook|script)s?\b/i;

/**
 * Conservative prompt classification. When nothing matches with confidence the
 * result is `other`/low, which the server attaches to an existing open task
 * instead of creating new work items.
 */
export function classifyPrompt(
  prompt: string,
  ctx: { isNewProject?: boolean; hasOpenTask?: boolean } = {},
): PromptClassification {
  const text = prompt.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ').trim();
  const head = text.slice(0, 500);
  const words = head.split(/\s+/).filter(Boolean).length;

  if (words === 0) return { kind: 'other', confidence: 'low' };
  if (CONTINUATION.test(head) && ctx.hasOpenTask) return { kind: 'continuation', confidence: 'high' };
  if (words <= 3 && ctx.hasOpenTask && !QUESTION_START.test(head)) return { kind: 'continuation', confidence: 'medium' };
  if (QUESTION_START.test(head) && (head.includes('?') || words < 18) && !BUGFIX.test(head))
    return { kind: 'question', confidence: head.endsWith('?') ? 'high' : 'medium' };
  if (BUILD.test(head)) return { kind: 'build', confidence: ctx.isNewProject ? 'high' : 'medium' };
  if (EXPERIMENT.test(head)) return { kind: 'experiment', confidence: 'medium' };
  if (BUGFIX.test(head)) return { kind: 'bugfix', confidence: 'medium' };
  if (REFACTOR.test(head)) return { kind: 'refactor', confidence: 'medium' };
  if (FEATURE.test(head)) return { kind: 'feature', confidence: 'medium' };
  if (head.endsWith('?')) return { kind: 'question', confidence: 'low' };
  return { kind: 'other', confidence: 'low' };
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'ExitPlanMode']);
const MODIFY_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);

const TEST_CMD =
  /(^|[\s;&|(])(node\s+\S*\.(test|spec)\.[cm]?[jt]s\b|(npm|pnpm|yarn|bun)\s+(run\s+)?(test|verify|e2e)\b|npx\s+(vitest|jest|playwright|mocha)|vitest|jest|pytest|py\.test|cargo\s+test|go\s+test|playwright\s+test|mocha|phpunit|rspec|dotnet\s+test|gradle\w*\s+test|mvn\s+test|deno\s+test|ctest|swift\s+test)\b/;
const BUILD_CMD = /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|typecheck|tsc|check)\b|tsc\b|cargo\s+(build|check|clippy)|go\s+build|make\b|vite\s+build|next\s+build|eslint|ruff|mypy)/;
const DEPLOY_CMD =
  /(^|[\s;&|(])(wrangler\s+(deploy|pages\s+deploy|publish)|npx\s+wrangler\s+(deploy|pages\s+deploy)|(npm|pnpm|yarn)\s+(run\s+)?deploy|vercel(\s+deploy|\s+--prod|\s*$)|netlify\s+deploy|firebase\s+deploy|fly\s+deploy|flyctl\s+deploy|railway\s+up|gh\s+workflow\s+run|git\s+push)\b/;
const MUTATING_SHELL = /(^|[\s;&|(])(rm|mv|cp|mkdir|touch|tee|sed\s+-i|npm\s+(install|i|uninstall)|pnpm\s+(add|install)|yarn\s+add|pip3?\s+install|git\s+(add|commit|checkout|merge|rebase|reset|stash|init|clone|pull)|chmod|ln)\b|[^>]>[^>&]|>>/;

/** Categorize a tool call. The command text is inspected locally and never uploaded. */
export function categorizeTool(tool: string, input?: { command?: unknown }): ToolCategory {
  if (MODIFY_TOOLS.has(tool)) return 'modify';
  if (READ_TOOLS.has(tool)) return 'read';
  if (WEB_TOOLS.has(tool)) return 'web';
  if (AGENT_TOOLS.has(tool)) return 'agent';
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = typeof input?.command === 'string' ? input.command : '';
    if (DEPLOY_CMD.test(cmd)) return 'deploy';
    if (TEST_CMD.test(cmd)) return 'test';
    if (BUILD_CMD.test(cmd)) return 'build';
    if (MUTATING_SHELL.test(cmd)) return 'modify';
    return 'shell';
  }
  return 'other';
}

/** Tool categories that mean the project is really being developed (not just read). */
export const MODIFYING_CATEGORIES: readonly ToolCategory[] = ['modify', 'build', 'test', 'deploy'];
