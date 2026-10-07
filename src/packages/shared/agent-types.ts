// ============================================================================
// Agent Classes - built-in types
// ============================================================================

export type BuiltInAgentClass = 'scout' | 'builder' | 'debugger' | 'architect' | 'warrior' | 'support' | 'boss';

// AgentClass can be a built-in class or a custom class slug
export type AgentClass = BuiltInAgentClass | string;

export const BUILT_IN_AGENT_CLASSES: Record<BuiltInAgentClass, { icon: string; color: string; description: string }> = {
  scout: { icon: '🔍', color: '#4a9eff', description: 'Codebase exploration, file discovery' },
  builder: { icon: '🔨', color: '#ff9e4a', description: 'Feature implementation, writing code' },
  debugger: { icon: '🐛', color: '#ff4a4a', description: 'Bug hunting, fixing issues' },
  architect: { icon: '📐', color: '#9e4aff', description: 'Planning, design decisions' },
  warrior: { icon: '⚔️', color: '#ff4a9e', description: 'Aggressive refactoring, migrations' },
  support: { icon: '💚', color: '#4aff9e', description: 'Documentation, tests, cleanup' },
  boss: { icon: '👑', color: '#ffd700', description: 'Team leader, delegates tasks to subordinates' },
};

// For backwards compatibility
export const AGENT_CLASSES = BUILT_IN_AGENT_CLASSES;

// Animation mapping for custom models - maps our animation states to model's animation names
export interface AnimationMapping {
  idle?: string;      // Animation name for idle state
  walk?: string;      // Animation name for walking
  working?: string;   // Animation name for working/busy state
}

// Custom Agent Class - user-defined agent types with associated skills
export interface CustomAgentClass {
  id: string;           // Unique identifier (slug)
  name: string;         // Display name
  icon: string;         // Emoji or icon
  iconPath?: string;    // Filename of uploaded PNG icon (e.g., 'my-class-id.png')
  color: string;        // Hex color
  description: string;  // What this class does
  defaultSkillIds: string[];  // Skills automatically assigned to agents of this class
  model?: string;       // Built-in character model file (e.g., 'character-male-a.glb')
  customModelPath?: string;  // Path to custom uploaded model (stored in ~/.tide-commander/custom-models/)
  modelScale?: number;       // Scale multiplier for the model (default: 1.0)
  modelOffset?: { x: number; y: number; z: number };  // Position offset for centering the model (x: horizontal, y: depth, z: vertical)
  animationMapping?: AnimationMapping;  // Maps our states to model's animation names
  availableAnimations?: string[];  // List of animations detected in the custom model
  instructions?: string; // Markdown instructions injected as system prompt (like CLAUDE.md)
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Agent Status & Configuration
// ============================================================================

// Agent Status
// 'orphaned' = Claude process is running but agent state is out of sync (e.g., shows idle when actually working)
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'waiting_permission' | 'error' | 'offline' | 'orphaned';
export type AgentTrackingStatus = 'thinking' | 'working' | 'waiting-subordinates' | 'need-review' | 'blocked' | 'can-clear-context';

// Permission Mode - controls how Claude asks for permissions
export type PermissionMode = 'bypass' | 'interactive';

export const PERMISSION_MODES: Record<PermissionMode, { label: string; description: string }> = {
  bypass: { label: 'Permissionless', description: 'Skip all permission prompts (less safe, faster)' },
  interactive: { label: 'Interactive', description: 'Ask for approval before sensitive operations' },
};

// Agent runtime provider
export type AgentProvider = 'claude' | 'codex' | 'opencode' | 'grok' | 'pi';

/**
 * Providers whose CLI takes the prompt via argv/file and closes stdin after
 * launch. Mid-run follow-ups cannot be written to stdin — they must be queued
 * until the process exits (or force-interrupted and respawned with --resume).
 */
export function providerClosesStdinAfterPrompt(
  provider?: AgentProvider | string | null,
): boolean {
  return provider === 'codex' || provider === 'opencode' || provider === 'grok' || provider === 'pi';
}

export function providerDisplayName(
  provider?: AgentProvider | string | null,
): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    case 'grok':
      return 'Grok';
    case 'pi':
      return 'Pi';
    case 'claude':
      return 'Claude';
    default:
      return provider ? String(provider) : 'agent';
  }
}

// OpenCode model - uses provider/model format (e.g. 'minimax/MiniMax-M1-80k')
export type OpencodeModel = string;

// Grok CLI model id (e.g. 'grok-4.6')
export type GrokModel = string;

// Reasoning-effort values the Grok CLI accepts for --reasoning-effort.
// Grok has no 'max' tier — 'xhigh' is its ceiling (and only on 4.6+).
export type GrokReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const GROK_MODELS: Record<string, { label: string; description: string; icon: string; contextWindow: number; efforts: GrokReasoningEffort[] }> = {
  'grok-4.6': {
    label: 'Grok 4.6',
    description: "SpaceXAI's latest frontier model — adds the xhigh reasoning tier",
    icon: '⚡',
    // Authoritative window from live Grok Build signals.json (contextWindowTokens).
    contextWindow: 500000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
  'grok-4.5': {
    label: 'Grok 4.5',
    description: 'Previous Grok Build generation (still supported)',
    icon: '🌊',
    contextWindow: 500000,
    // 4.5 has no xhigh tier — the model catalog only lists low/medium/high.
    efforts: ['low', 'medium', 'high'],
  },
};

export const DEFAULT_GROK_MODEL = 'grok-4.6';

/** Effort tiers a Grok model accepts; unknown models get the full modern set. */
export function grokEffortsFor(model?: string | null): GrokReasoningEffort[] {
  return GROK_MODELS[model || '']?.efforts || ['low', 'medium', 'high', 'xhigh'];
}

// Tide effort labels → Grok CLI values. Grok tops out at 'xhigh', so 'max'
// clamps down instead of being passed through as an unknown value.
const GROK_EFFORT_VALUES: Record<ClaudeEffort, GrokReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xHigh: 'xhigh',
  max: 'xhigh',
};

/**
 * Resolve a Tide effort label to the `--reasoning-effort` value for a Grok
 * model, clamping to the highest tier that model actually supports (asking
 * grok-4.5 for 'xhigh' would otherwise be rejected by the CLI).
 */
export function resolveGrokReasoningEffort(
  model: string | undefined,
  effort: string | undefined
): GrokReasoningEffort | undefined {
  if (!effort) return undefined;
  const supported = grokEffortsFor(model);
  const requested = GROK_EFFORT_VALUES[effort as ClaudeEffort]
    || (effort.toLowerCase() as GrokReasoningEffort);
  const order: GrokReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
  const requestedRank = order.indexOf(requested);
  if (requestedRank === -1) return undefined;
  for (let rank = requestedRank; rank >= 0; rank -= 1) {
    if (supported.includes(order[rank])) return order[rank];
  }
  return undefined;
}

/**
 * Tide effort labels selectable for a Grok model (drives the effort pickers).
 * 'max' is Claude-only — Grok's ceiling is X-High, so it never shows for Grok.
 */
export function grokSupportsEffort(model: string | undefined, effort: ClaudeEffort): boolean {
  if (effort === 'max') return false;
  return grokEffortsFor(model).includes(GROK_EFFORT_VALUES[effort]);
}

// Pi coding agent model - uses provider/model format (e.g. 'anthropic/claude-sonnet-4-5').
// Empty string means "use pi's own configured default" (~/.pi/agent/settings.json).
export type PiModel = string;

export const DEFAULT_PI_MODEL = '';

// Codex CLI execution controls
export type CodexApprovalMode = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexModel =
  | 'gpt-6-astra'
  | 'gpt-6.1-sol'
  | 'gpt-6-sol'
  | 'gpt-6-luna'
  | 'gpt-5.6-terra';

// Valid values accepted by the codex CLI's `-c model_reasoning_effort=<value>` override.
// Confirmed from `codex -c model_reasoning_effort=bogus exec …` error message.
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const CODEX_REASONING_EFFORTS: Record<CodexReasoningEffort, { label: string; description: string; icon: string }> = {
  none: { label: 'None', description: 'No reasoning', icon: '⚪' },
  minimal: { label: 'Minimal', description: 'Least reasoning, fastest', icon: '💨' },
  low: { label: 'Low', description: 'Light reasoning', icon: '🏃' },
  medium: { label: 'Medium', description: 'Balanced reasoning', icon: '⚖️' },
  high: { label: 'High', description: 'Deep reasoning', icon: '🔬' },
  xhigh: { label: 'X-High', description: 'Extra-high reasoning, slowest', icon: '🧠' },
};

export interface CodexConfig {
  fullAuto?: boolean; // maps to --full-auto
  approvalMode?: CodexApprovalMode; // maps to --ask-for-approval
  sandbox?: CodexSandboxMode; // maps to --sandbox
  search?: boolean; // maps to --search
  profile?: string; // maps to --profile
  reasoningEffort?: CodexReasoningEffort; // maps to -c model_reasoning_effort=<value>
}

// Key order is the picker order: Astra → Sol → Luna (most capable first).
export const CODEX_MODELS: Record<CodexModel, { label: string; description: string; icon: string; deprecated?: boolean }> = {
  'gpt-6-astra': {
    label: 'GPT-6 Astra',
    description: 'GPT-6 Astra — OpenAI\'s most capable model for complex, demanding work',
    icon: '✨',
  },
  'gpt-6.1-sol': {
    label: 'GPT-6.1 Sol',
    description: 'GPT-6.1 Sol — latest Sol, agentic workhorse for everyday coding (default)',
    icon: '☀️',
  },
  'gpt-6-luna': {
    label: 'GPT-6 Luna',
    description: 'GPT-6 Luna — fast and affordable agentic coding',
    icon: '🌙',
  },
  // Superseded models: valid for existing agents, hidden from the new/edit
  // agent pickers.
  'gpt-6-sol': {
    label: 'GPT-6 Sol',
    description: 'Previous Sol generation (GPT-6.1 Sol preferred)',
    icon: '☀️',
    deprecated: true,
  },
  'gpt-5.6-terra': {
    label: 'GPT-5.6 Terra',
    description: 'Previous generation balanced coding model (retained for existing agents)',
    icon: '🌍',
    deprecated: true,
  },
};

/** Model and reasoning effort preselected for every new Codex agent. */
export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-6.1-sol';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'high';

// Codex models removed from Tide Commander, moved to their GPT-6 successor on
// load and on any update (same contract as RETIRED_CLAUDE_MODELS).
const RETIRED_CODEX_MODELS: Readonly<Record<string, CodexModel>> = {
  'gpt-5.6-luna': 'gpt-6-luna',
  'gpt-5.6-sol': 'gpt-6.1-sol',
};

/** The successor of a retired Codex model id, or the id unchanged. */
export function migrateRetiredCodexModel(model: string): string {
  return RETIRED_CODEX_MODELS[model] ?? model;
}

export function isDeprecatedCodexModel(model: CodexModel): boolean {
  return CODEX_MODELS[model]?.deprecated === true;
}

// Claude Model - which AI model to use.
// Short names ('sonnet' | 'opus' | 'haiku') are legacy aliases for the CLI's
// latest-of-family resolution. Explicit IDs (e.g. 'claude-opus-5-5') are
// preferred for new agents so we pin a specific version. Models such as Fable
// 5.1 and Sonnet 5.5 expose a native 1M context under their bare model ID. The '[1m]' suffix
// remains a Tide Commander label for older models whose 1M context uses the
// beta header; those labels translate to bare model IDs on the CLI side.
export type ClaudeModel =
  | 'sonnet'
  | 'opus'
  | 'haiku'
  | 'claude-fable-5-1'
  | 'claude-fable-5'
  | 'claude-fable-5[1m]'
  | 'claude-sonnet-5-5'
  | 'claude-sonnet-5'
  | 'claude-sonnet-5[1m]'
  | 'claude-opus-5-5'
  | 'claude-opus-5-5[1m]'
  | 'claude-opus-5'
  | 'claude-opus-5[1m]'
  | 'claude-opus-4-7'
  | 'claude-opus-4-6'
  | 'opus[1m]';

export const CLAUDE_MODELS: Record<ClaudeModel, { label: string; description: string; icon: string; contextWindow: number; deprecated?: boolean }> = {
  'claude-fable-5-1': { label: 'Fable 5.1 [1M]', description: 'Latest Fable — most capable Claude model for the hardest and longest-running tasks, native 1M token context window', icon: '🪄', contextWindow: 1000000 },
  'claude-opus-5-5[1m]': { label: 'Opus 5.5 [1M]', description: 'Latest Opus with 1M token context window — for complex agentic coding and enterprise work (default)', icon: '🧠', contextWindow: 1000000 },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5 [1M]', description: 'Latest Sonnet — near-Opus intelligence at lower cost, native 1M token context window', icon: '⚡', contextWindow: 1000000 },
  haiku: { label: 'Haiku', description: 'Fast and economical', icon: '🚀', contextWindow: 200000 },
  // Everything below stays a valid model value for existing agents and CLI
  // passthrough, but is hidden from the new/edit agent pickers: previous
  // generations, legacy family aliases, and plain (200K) ids whose 1M variant
  // is listed above.
  'claude-fable-5[1m]': { label: 'Fable 5 [1M]', description: 'Previous Fable generation with 1M token context window', icon: '🪄', contextWindow: 1000000, deprecated: true },
  'claude-opus-5[1m]': { label: 'Opus 5 [1M]', description: 'Previous Opus generation with 1M token context window', icon: '🧠', contextWindow: 1000000, deprecated: true },
  'claude-sonnet-5[1m]': { label: 'Sonnet 5 [1M]', description: 'Previous Sonnet generation with 1M token context window', icon: '⚡', contextWindow: 1000000, deprecated: true },
  'opus[1m]': { label: 'Opus 4.7 [1M]', description: 'Older Opus generation with 1M token context window', icon: '🧠', contextWindow: 1000000, deprecated: true },
  sonnet: { label: 'Sonnet (legacy)', description: 'Legacy alias — prefer Sonnet 5.5 [1M]', icon: '⚡', contextWindow: 200000, deprecated: true },
  'claude-fable-5': { label: 'Fable 5 (200K)', description: 'Previous Fable generation with 200K context (Fable 5.1 preferred)', icon: '🪄', contextWindow: 200000, deprecated: true },
  'claude-opus-5-5': { label: 'Opus 5.5 (200K)', description: 'Latest Opus, 200K context window (1M variant preferred)', icon: '🧠', contextWindow: 200000, deprecated: true },
  'claude-opus-5': { label: 'Opus 5 (200K)', description: 'Previous Opus generation, 200K context window (1M variant preferred)', icon: '🧠', contextWindow: 200000, deprecated: true },
  'claude-sonnet-5': { label: 'Sonnet 5 (200K)', description: 'Previous Sonnet generation, 200K context window (Sonnet 5.5 preferred)', icon: '⚡', contextWindow: 200000, deprecated: true },
  'claude-opus-4-7': { label: 'Opus 4.7 (200K)', description: 'Previous Opus generation, 200K context window (1M variant preferred)', icon: '🧠', contextWindow: 200000, deprecated: true },
  opus: { label: 'Opus (legacy)', description: 'Legacy alias — prefer Opus 5.5 [1M]', icon: '🧠', contextWindow: 200000, deprecated: true },
  'claude-opus-4-6': { label: 'Opus 4.6', description: 'Older Opus generation (retained for existing agents)', icon: '🧠', contextWindow: 200000, deprecated: true },
};

/** Model and reasoning effort preselected for every new Claude agent. */
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-opus-5-5[1m]';
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'high';

// Models removed from Tide Commander. Agents persisted with one of these are
// moved to its successor on load (and on any API update) instead of silently
// losing their model and falling back to the CLI default.
const RETIRED_CLAUDE_MODELS: Readonly<Record<string, ClaudeModel>> = {
  'claude-opus-4-8': 'claude-opus-5-5',
  'claude-opus-4-8[1m]': 'claude-opus-5-5[1m]',
};

/** The successor of a retired model id, or the id unchanged. */
export function migrateRetiredClaudeModel(model: string): string {
  return RETIRED_CLAUDE_MODELS[model] ?? model;
}

// Claude Effort Level - how much reasoning effort Claude puts into responses.
// 'xHigh' (extra high) sits between 'high' and 'max' and is supported from
// Opus 4.7 onward (including Opus 5 and 5.5).
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xHigh' | 'max';

export const CLAUDE_EFFORTS: Record<ClaudeEffort, { label: string; description: string; icon: string }> = {
  low: { label: 'Low', description: 'Minimal reasoning, fastest responses', icon: '🏃' },
  medium: { label: 'Medium', description: 'Balanced reasoning effort', icon: '⚖️' },
  high: { label: 'High', description: 'Deep reasoning for complex tasks (default)', icon: '🔬' },
  xHigh: { label: 'X-High', description: 'Extra-high reasoning (Opus 4.7+)', icon: '🧪' },
  max: { label: 'Max', description: 'Maximum reasoning, most thorough', icon: '🧠' },
};

// Model IDs that should be hidden from the "new agent" model picker.
// They remain valid ClaudeModel values so existing agents keep working.
export function isDeprecatedClaudeModel(model: ClaudeModel): boolean {
  return CLAUDE_MODELS[model]?.deprecated === true;
}

// ============================================================================
// Context & Usage Stats
// ============================================================================

// Detailed context statistics from Claude's /context command
export interface ContextStats {
  // Model info
  model: string;                 // Model name
  contextWindow: number;         // Model's context window size (e.g., 200000)

  // Total usage
  totalTokens: number;           // Total tokens used
  usedPercent: number;           // Percentage of context used

  // Category breakdown (from /context command)
  categories: {
    systemPrompt: { tokens: number; percent: number };
    systemTools: { tokens: number; percent: number };
    messages: { tokens: number; percent: number };
    freeSpace: { tokens: number; percent: number };
    autocompactBuffer: { tokens: number; percent: number };
  };

  // Timestamp
  lastUpdated: number;
}

// ============================================================================
// Agent Todo List (latest TodoWrite snapshot)
// ============================================================================

export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentTodoItem {
  /** Stable id when the provider supports merge updates (e.g. Grok todo_write). */
  id?: string;
  content: string;
  status: AgentTodoStatus;
  activeForm?: string;
}

// ============================================================================
// Agent State
// ============================================================================

/**
 * A live model swap the API performed without asking: `requestedModel` is what
 * the session was started with, `servedModel` is what actually answered.
 * Labels are precomputed so every surface (terminal chip, agent card, mobile)
 * renders the same wording.
 */
export interface ModelFallbackInfo {
  requestedModel: string;
  servedModel: string;
  requestedLabel: string;
  servedLabel: string;
  /** True when the swap crossed model families (e.g. Fable → Opus). */
  tierChanged: boolean;
  /** When the swap was first observed. */
  detectedAt: number;
}

export interface Agent {
  id: string;
  name: string;
  class: AgentClass;
  status: AgentStatus;
  provider: AgentProvider;

  // Position on battlefield (3D coordinates)
  position: { x: number; y: number; z: number };

  // Claude Code session
  sessionId?: string;
  // Set on a forked agent until its first run: the SOURCE session id to resume +
  // fork from (Claude --fork-session / Codex thread/fork / OpenCode --fork). Cleared once the fork's
  // own new session id is captured. See handleForkAgent.
  forkSourceSessionId?: string;
  cwd: string;
  useChrome?: boolean; // Start with --chrome flag
  permissionMode: PermissionMode; // How permissions are handled
  model?: ClaudeModel; // Claude model to use (sonnet, opus, haiku)
  effort?: ClaudeEffort; // Reasoning effort level (low, medium, high, max)
  codexModel?: CodexModel; // Codex model to use (for provider='codex')
  codexConfig?: CodexConfig; // Codex CLI config (only for provider='codex')
  opencodeModel?: OpencodeModel; // OpenCode model to use (for provider='opencode')
  grokModel?: GrokModel; // Grok model to use (for provider='grok')
  piModel?: PiModel; // Pi model to use (for provider='pi', 'provider/model' pattern)
  /** Actual model provider reported by Pi (needed when piModel uses Pi's configured default). */
  piModelProvider?: string;

  // Resources
  tokensUsed: number;
  contextUsed: number;      // Current context window usage
  contextLimit: number;     // Model's context limit (default 200k)

  // Detailed context stats (from Claude's stream-json modelUsage)
  contextStats?: ContextStats;

  // Current task
  currentTask?: string;
  currentTool?: string;

  // Last runtime error message (set alongside status='error'; shown on hover
  // over the status badge). Cleared automatically when the agent recovers to
  // any non-error status. See runtime-events handleError / agent-service updateAgent.
  lastError?: string;

  // Set while the API is serving this agent a DIFFERENT model than the one it
  // was configured with (silent Anthropic fallback — see shared/model-fallback.ts).
  // Cleared as soon as a turn comes back on the requested model again.
  modelFallback?: ModelFallbackInfo;

  // Model id the CLI reported in its session init (e.g. 'claude-opus-5').
  // When `model` is unset the CLI resolves its own default, and this is the
  // only truthful source for the UI — refreshed at every turn init.
  detectedModel?: string;

  // Latest TodoWrite snapshot for this agent (most recent task list)
  latestTodos?: AgentTodoItem[];

  // Detached mode - true when the Claude process is running but not attached to Tide Commander
  // (e.g., after server restart while agent was working)
  isDetached?: boolean;

  // Last assigned task - the original user prompt/task (persists even when idle)
  lastAssignedTask?: string;
  lastAssignedTaskTime?: number;

  // Brief task label (max 5 words) for display in 2D/3D scenes
  taskLabel?: string;
  trackingStatus?: AgentTrackingStatus | null;
  trackingStatusDetail?: string;
  trackingStatusTimestamp?: number;

  // Task counter - number of user messages/commands sent to this agent
  taskCount: number;

  // Timestamps
  createdAt: number;
  lastActivity: number;
  // Last time the agent actually transitioned into/out of active work
  // (working/waiting/waiting_permission). Unlike lastActivity — which every
  // updateAgent restamps, clicks included — this only moves with real work,
  // so clients can trust it for "recently active" ordering and stay in sync
  // across browsers/APK that never observed the work live.
  lastWorkedAt?: number;

  // Boss-specific fields
  isBoss?: boolean;                    // True if this agent can manage subordinates
  subordinateIds?: string[];           // IDs of agents under this boss
  bossId?: string;                     // ID of the boss this agent reports to (if any)

  // Custom instructions appended to the agent's class system prompt
  customInstructions?: string;

  // Per-agent custom system prompt. Edited from Settings → System Prompt with a
  // specific agent selected, and injected by buildAppendedProjectInstructions()
  // under "System-Level Custom Prompt". Coexists with the global prompt (the
  // "All Agents (Global)" picker entry, stored via system-prompt-service), which
  // is injected before it for every agent.
  customPrompt?: string;

  // Per-agent persistent memory — agent's own notes/lessons/preferences.
  // Maintained by the agent itself via /api/agents/:id/memory and injected
  // into the system prompt by buildAppendedProjectInstructions().
  memory?: string;

  // Global keyboard shortcut to open guake terminal for this agent (e.g. 'ctrl+1', 'alt+a')
  shortcut?: string;

  // Silence this agent's audio only: no notification chime, no completion cue,
  // and its questions never start the repeating alert. Everything visual stays
  // exactly as before — toasts, phone notifications and the board are
  // untouched. Intended for chatty agents you still want to watch.
  soundsMuted?: boolean;

  // 待岗（Standby）：用户手动的可逆停用态。置位时进程被停止、所有派发/命令
  // 通路拒绝（见 server/services/agent-standby.ts），但档案、会话与层级都保留；
  // 仅用户可从面板恢复。刻意做成布尔标志而非新 AgentStatus 值——status 是运行时
  // 计算态（启动时会被重置），标志不会被 runtime sync 覆盖。
  // 只存 true 或省略，不写 false（避免 agents.json 抖动）。
  standby?: boolean;

  // Auto-collapse: when enabled, the agent's context is collapsed (/compact runs,
  // waiting for idle if busy) on a recurring cron schedule. Intended for unattended
  // agents (slack channels, log-supervising cronjobs) whose context grows indefinitely.
  autoCollapse?: boolean;          // Master enable/disable flag
  autoCollapseCron?: string;       // 5-field cron expression, e.g. '0 3 * * *' (3am daily)
  autoCollapseTz?: string;         // IANA timezone for the cron, e.g. 'America/Mexico_City'
  autoCollapsePrompt?: string;     // Optional prompt sent to the agent after each scheduled collapse completes
}

// ============================================================================
// Subagent Types (Claude Code Task tool spawned agents)
// ============================================================================

// Virtual subagent status
export type SubagentStatus = 'spawning' | 'working' | 'completed' | 'failed';

// Virtual subagent - represents a Task tool subagent spawned by Claude Code
export interface Subagent {
  id: string;                        // Generated ID for this virtual subagent
  parentAgentId: string;             // The TC agent that spawned this subagent
  toolUseId: string;                 // The tool_use_id that created this subagent
  name: string;                      // Name from Task input (e.g., "UX Analyst")
  description: string;               // Description from Task input
  subagentType: string;              // e.g., "general-purpose", "Explore", "Bash"
  model?: string;                    // Model used (e.g., "opus", "sonnet")
  status: SubagentStatus;
  startedAt: number;
  completedAt?: number;
  // Position near parent agent
  position?: { x: number; y: number; z: number };
  // Real-time activity tracking
  activities?: SubagentActivity[];
  // Streaming content from JSONL file
  streamEntries?: SubagentStreamEntry[];
  // Completion stats
  stats?: {
    durationMs: number;
    tokensUsed: number;
    toolUseCount: number;
  };
}

export interface SubagentActivity {
  toolName: string;
  description: string;
  timestamp: number;
}

// An active background task inside an agent's CLI process: a Bash command
// launched with run_in_background, a slow Bash command promoted to the
// background at its timeout, or an async Task/Agent launch. Tracked from its
// launch stub / task_started event until its <task-notification> completion.
export interface AgentBackgroundTask {
  agentId: string;
  key: string;                      // Stable identity: toolUseId, else taskId
  taskId?: string;                  // CLI-assigned short id (names the .output file)
  toolUseId?: string;               // tool_use block that launched it
  toolName?: string;                // 'Bash' | 'Task' | 'Agent' | ...
  description?: string;             // Bash description param / subagent description
  command?: string;                 // Bash command line
  outputFile?: string;              // /tmp/claude-*/.../tasks/<taskId>.output when known
  startedAt: number;
}

// Streaming entry from subagent JSONL file
export interface SubagentStreamEntry {
  type: 'text' | 'tool_use' | 'tool_result';
  timestamp: string;
  text?: string;                    // For text entries (assistant messages)
  toolName?: string;                // For tool_use entries
  toolKeyParam?: string;            // Key param (e.g., file path, command, query)
  toolUseId?: string;               // Claude's tool_use_id
  resultPreview?: string;           // For tool_result entries (truncated output)
  isError?: boolean;                // For tool_result error status
}

// ============================================================================
// Boss Agent Types
// ============================================================================

// 任务卡状态机（改造点⑦，Spec §4.7）：pending → running → done；
// 任务 15·B（全局并发配额）扩展 queued：pending → queued → running（超预算先排队，出队再开工）；
// 任务 16（⑬ 撤回）扩展 cancelled 终态：pending/queued/running → cancelled；
// done / cancelled 均为终态，不接任何出边（done 天然拒回退 = done 拒撤）。
export type TaskCardStatus = 'pending' | 'queued' | 'running' | 'done' | 'cancelled';

// 任务卡优先级（P0 最高 —— P3 最低；解析时也接受 high/medium/low 归一化）
export type TaskCardPriority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * 任务卡（改造点⑦）：委托层增强，把「派一句话」升级为「派一张卡」。
 * - 由 Boss 的 delegation 块可选携带 `taskCard` 字段，随委派史落盘；
 * - 纯文本委托（无卡）保持原行为，卡字段全部可有可无（objective 除外）；
 * - projectId 供 ⑪ 记忆卡 / ⑬ 撤回做数据源；sourceProject 记跨项目来源。
 */
export interface TaskCard {
  objective: string;                // 目标（一句话说清要做什么）
  acceptanceCriteria: string[];     // 验收标准（可判定「做完没」的条目；空数组=未提供）
  dependencies: string[];           // 前置依赖（任务/文件/条件；空数组=无）
  priority?: TaskCardPriority;      // 优先级
  projectId?: string;               // 项目归属（⑪/⑬ 数据源）
  sourceProject?: string;           // 跨项目任务的来源项目
  status: TaskCardStatus;           // 状态机当前态（落卡即 pending）
  statusUpdatedAt?: number;         // 状态最近迁移时间（⑦ 观测点：迁移 + 时间）
  due?: string;                     // 截止日（任务17·A2；date-only 'YYYY-MM-DD'，与 Bolba 同形）
}

/**
 * ⑧ 病历：完成事件（改造点⑧，Spec §4.8，任务11）。
 * 完成入口（completeDelegation）在清理委派追踪前固化写回；旧 delegation-history
 * 记录无此字段，读取方（⑦ 查询路径等）一律按「无完成事件」处理 —— 纯可选加法。
 */
export interface DelegationCompletion {
  /** 完成时刻（epoch 毫秒，完成入口传入） */
  completedAt: number;
  /** 耗时 = completedAt − 委派决策 timestamp（毫秒；时钟回拨时钳为 0） */
  durationMs: number;
  /** 终态结果（按完成入口 success 迁移） */
  result: 'completed' | 'failed';
  /** 产出摘要（report-task 入口的 req.body.summary；runtime 入口无可得来源 → 缺省） */
  summary?: string;
  /** 产出位置（文件/目录/链接；当前两个入口均不可得 → 缺省，来源限制见任务11 报告） */
  outputLocation?: string;
  /** 验收自检逐条打勾（任务17·A3；report-task 入口回传，旧记录无此字段 → 按「未提供」处理） */
  acceptance?: Array<{ item: string; done: boolean }>;
  /** 触发原因：report-task / turn-complete 等 */
  reason?: string;
}

/** ⑧ 病历：用户评价（满意/不满意）——回写 API 交付，自然语言入口延后（任务16 同批）。 */
export type DelegationUserRating = 'satisfied' | 'unsatisfied';

// Delegation decision record - tracks how boss routed a command
export interface DelegationDecision {
  id: string;
  timestamp: number;
  bossId: string;
  userCommand: string;              // Original command from user
  selectedAgentId: string;
  selectedAgentName: string;
  reasoning: string;                // LLM's explanation for the choice
  alternativeAgents: string[];      // Other agents that were considered
  confidence: 'high' | 'medium' | 'low';
  status: 'pending' | 'sent' | 'completed' | 'failed';
  /** 派发链路 taskId（HC-B7：随决策落盘，重启后据此重建 activeDelegations 追踪；旧记录无此字段 → 重建时 taskId 缺省，仅靠 decisionId 关联） */
  taskId?: string;
  taskCard?: TaskCard;              // ⑦ 任务卡（旧记录无此字段，读取方按「无卡」处理）
  completion?: DelegationCompletion; // ⑧ 病历完成事件（任务11；旧记录无此字段 → 按「未完成」处理）
  userRating?: DelegationUserRating; // ⑧ 病历用户评价（任务11；旧记录无此字段）
  ratedAt?: number;                  // ⑧ 病历评价时刻（epoch 毫秒）
}

// Context about a subordinate for delegation decision
export interface SubordinateContext {
  id: string;
  name: string;
  class: AgentClass;
  status: AgentStatus;
  currentTask?: string;
  lastAssignedTask?: string;
  contextPercent: number;            // Context usage percentage
  tokensUsed: number;
  profile?: AgentProfileCard;        // B1 人事档案卡（任务18·B1；旧调用方无此字段 → 按无卡处理）
  standby?: boolean;                 // 待岗标志：不参与派活，缺人时由 Boss 向用户请示
}

// ============================================================================
// Agent Profile Card (B1 人事档案卡, 任务18 / Spec §10.3 B1)
// ============================================================================

/**
 * agent 人事档案卡：技能摘要 + 历史表现，注入 Boss 快照（buildBossContext TEAM 段）
 * 让主管选人时看到「谁会什么、干得怎样」。
 *
 * 数据诚实性（硬约束）：
 * - 无样本 → completionRate / avgDurationMs 为 null（渲染 n/a），不硬造数字；
 * - reworkRate 全仓无「返工」事件采集（任务17 验收自检 done:false 不属于返工）→ 恒为
 *   null，缺源如实登记，禁编造。
 * - 聚合逻辑（纯函数）在 server/services/agent-profile-service.ts；本类型只描述形态。
 */
export interface AgentProfileCard {
  /** 该 agent 当前生效的技能总数（含 class/wildcard 命中，disabled 不计）。 */
  skillCount: number;
  /** 摘要展示的技能名（有界：≤ 渲染上限 K；按码点序稳定排序）。 */
  skillNames: string[];
  /** 未进入摘要的技能数（skillCount − skillNames.length）。 */
  hiddenSkillCount: number;
  /** 时间窗内与该 agent 相关的委派记录总数（含未终态）。 */
  totalDelegations: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  /** 终态样本数 = completed + failed + cancelled。 */
  terminalCount: number;
  /**
   * 完成率 = completed / terminalCount（0..1；终态 = 完成 + 失败 + 撤回）。
   * 无终态样本 → null（n/a），不写 0 冒充。
   */
  completionRate: number | null;
  /** 完成/失败记录的 durationMs 均值（毫秒，四舍五入）；无样本 → null。 */
  avgDurationMs: number | null;
  /** 返工率：无数据源，恒为 null（缺源登记，禁编造）。 */
  reworkRate: null;
  /**
   * 任务22 编制注记（如「观察中：连续失败 3 次」/「归档候选：闲置 35 天」）；
   * 由 agent-ledger-service.buildRosterNote 产生，keep / 无证据时缺省不输出。
   */
  rosterNote?: string | null;
}

// Boss context delimiters - used to inject subordinate context at the beginning of user messages
// The frontend detects these to collapse/hide the context section in the UI
export const BOSS_CONTEXT_START = '<<<BOSS_CONTEXT_START>>>';
export const BOSS_CONTEXT_END = '<<<BOSS_CONTEXT_END>>>';

// ============================================================================
// Work Plan Types (Boss Agent Planning)
// ============================================================================

// Task priority levels
export type TaskPriority = 'high' | 'medium' | 'low';

// Task status in a work plan
export type WorkPlanTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

// Phase execution mode
export type PhaseExecutionMode = 'sequential' | 'parallel';

// Individual task within a work plan phase
export interface WorkPlanTask {
  id: string;
  description: string;
  suggestedClass: AgentClass;           // Recommended agent class for this task
  assignedAgentId: string | null;       // Assigned agent (null = auto-assign)
  assignedAgentName?: string;           // Name of assigned agent (for display)
  priority: TaskPriority;
  blockedBy: string[];                  // Task IDs that must complete first
  status: WorkPlanTaskStatus;
  result?: string;                      // Summary of task outcome when completed
  startedAt?: number;
  completedAt?: number;
}

// Phase within a work plan (groups related tasks)
export interface WorkPlanPhase {
  id: string;
  name: string;
  description?: string;
  execution: PhaseExecutionMode;        // How tasks in this phase run
  dependsOn: string[];                  // Phase IDs that must complete first
  tasks: WorkPlanTask[];
  status: WorkPlanTaskStatus;
  startedAt?: number;
  completedAt?: number;
}

// Complete work plan created by Boss agent
export interface WorkPlan {
  id: string;
  name: string;
  description: string;
  phases: WorkPlanPhase[];
  createdBy: string;                    // Boss agent ID
  createdAt: number;
  updatedAt: number;
  status: 'draft' | 'approved' | 'executing' | 'paused' | 'completed' | 'cancelled';
  // Summary fields for quick overview
  totalTasks: number;
  completedTasks: number;
  parallelizableTasks: string[];        // Task IDs that can run in parallel
}

// Analysis request - Boss asks scouts to explore codebase
export interface AnalysisRequest {
  id: string;
  targetAgentId: string;                // Scout agent to perform analysis
  targetAgentName?: string;
  query: string;                        // What to analyze
  focus?: string[];                     // Specific areas to focus on
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;                      // Analysis results when completed
  requestedAt: number;
  completedAt?: number;
}

// Work plan created from Boss response (parsed from ```work-plan block)
export interface WorkPlanDraft {
  name: string;
  description: string;
  phases: {
    id: string;
    name: string;
    execution: PhaseExecutionMode;
    dependsOn: string[];
    tasks: {
      id: string;
      description: string;
      suggestedClass: string;
      assignToAgent: string | null;     // Agent ID or null for auto-assign
      priority: TaskPriority;
      blockedBy: string[];
    }[];
  }[];
}

// Analysis request from Boss response (parsed from ```analysis-request block)
export interface AnalysisRequestDraft {
  targetAgent: string;                  // Agent ID
  query: string;
  focus?: string[];
}

// ============================================================================
// Session History
// ============================================================================

/** A single past session entry for an agent. */
export interface SessionHistoryEntry {
  sessionId: string;
  summary: string;        // Brief description (from taskLabel, falls back to lastAssignedTask)
  startedAt: number;      // Timestamp when session was first used
  endedAt: number;        // Timestamp when session was cleared/replaced
  messageCount?: number;  // Approximate message count at time of archival
  fileExists?: boolean;   // Computed at request time - true if the provider session still exists on disk
  /** Provider/cwd at archive time. Older entries omit these and are detected from disk. */
  provider?: AgentProvider;
  cwd?: string;
}

// ============================================================================
// Runtime (harness) migration — any provider → any provider
// ============================================================================

export type SessionTransferMode = 'smart' | 'full' | 'fresh';

/**
 * Runtimes whose native session store Commander knows how to write, so a
 * conversation can be imported into them (Smart Context / Visible Transcript).
 * Every provider can still be a migration TARGET via Fresh Start, and every
 * provider is a valid SOURCE because the session loader reads all of them.
 */
export type SessionTransferTarget = 'claude' | 'codex' | 'grok' | 'pi';

export const SESSION_TRANSFER_TARGETS: readonly SessionTransferTarget[] = ['claude', 'codex', 'grok', 'pi'];

export function supportsSessionImport(
  provider?: AgentProvider | string | null,
): provider is SessionTransferTarget {
  return (SESSION_TRANSFER_TARGETS as readonly string[]).includes(String(provider));
}

export interface SessionTransferSummary {
  sourceProvider: AgentProvider;
  targetProvider: AgentProvider;
  sourceSessionId?: string;
  targetSessionId?: string;
  mode: SessionTransferMode;
  sourceMessageCount: number;
  importedTurnCount: number;
  droppedTurnCount: number;
  droppedToolResultBodies: number;
  estimatedTokens: number;
  contextLimit: number;
  warnings: string[];
}

export interface SessionTransferResponse {
  agent: Agent;
  transfer: SessionTransferSummary;
}
