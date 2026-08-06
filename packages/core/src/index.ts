// Benchmark harness
export { extractSessionMetrics, type SessionMetrics } from "./bench/metrics"
export {
  type BenchDeps,
  type BenchSummary,
  type BenchTask,
  DEFAULT_SUITE,
  runBenchSuite,
  runBenchTask,
} from "./bench/run"
// Config
export {
  ButterflyConfig,
  type ConfigHooksSource,
  type HookToggleResult,
  loadConfig,
  loadRawConfig,
  locateHooksSource,
  mergeConfigs,
  type PermissionWriteResult,
  parseJsonc,
  saveGlobalConfig,
  setHookEnabled,
  setPermissionRule,
  substituteEnv,
} from "./config/config"
// Context
export {
  AGENTS_MD_FRAGMENT_CAP_CHARS,
  AGENTS_MD_TOTAL_BUDGET_CHARS,
  type AgentsMdFragment,
  type AgentsMdReconcileResult,
  agentsMdAncestors,
  extractTouchedFiles,
  loadAgentsMdFragment,
  reconcileAgentsMd,
  renderAgentsMdBlock,
} from "./context/agents-md"
export {
  type DoctorCatalog,
  type DoctorDeps,
  type DoctorJournalInfo,
  type DoctorLintIssue,
  type DoctorLintKind,
  type DoctorMcpHub,
  type DoctorMcpServer,
  type DoctorPrefixBreakdown,
  type DoctorReport,
  doctor,
  type RenderDoctorOptions,
  renderDoctorReport,
} from "./context/doctor"
export {
  FRECENCY_CAP,
  type FrecencyEntry,
  frecencyScore,
  frecencyStorePath,
  loadFrecency,
  rankByFrecency,
  touchFrecency,
  withFrecencyTouch,
} from "./context/frecency"
export {
  IMAGE_EXTENSIONS,
  type ImageRef,
  isImagePath,
  type LoadedImagePart,
  loadImagePart,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  mediaTypeForPath,
  type PrepareImagesResult,
  prepareImageAttachments,
  strippedImagePart,
} from "./context/media"
export {
  type ExpandedMention,
  expandMentions,
  extractMentions,
  listMentionCandidates,
  MENTION_CONTEXT_MAX_CHARS,
  renderMentionBlock,
} from "./context/mentions"
export { buildSystem, selectPromptFamily } from "./context/system"
export { estimateTokens } from "./context/tokens"
// Edit pipeline
export { applyEdit } from "./edit/apply"
// Graph engine
export { type DefRow, GraphDb, type RefRow } from "./graph/db"
export { createExploreTool } from "./graph/explore-tool"
export { languageForPath } from "./graph/languages"
export { rankedDefinitions, rankFiles } from "./graph/rank"
export { disposeScanners, scanFile, type Tag } from "./graph/scan"
export { buildSkeleton, DEFAULT_SKELETON_TOKENS } from "./graph/skeleton"
export { syncRepo } from "./graph/sync"
// Loop orchestration
export { type Gate, type GateRunResult, runGates } from "./loop/gates"
export { type LoopTask, MAX_ATTEMPTS, type TaskStatus, WorkQueue } from "./loop/queue"
export {
  DEFAULT_LOOP_ITERATIONS,
  type LoopDeps,
  type LoopEvent,
  type LoopOutcome,
  type LoopProgress,
  runLoop,
  type StopReason,
} from "./loop/supervisor"
export { McpHub, type McpServerConfig, type McpToolInfo } from "./mcp/hub"
export { createMcpTool } from "./mcp/mcp-tool"
export { type EpisodicHit, EpisodicIndex } from "./memory/episodic"
export {
  applyMemoryOp,
  loadMemory,
  type MemoryPaths,
  memoryPaths,
  PROJECT_MEMORY_CAP,
  scanForInjection,
  USER_MEMORY_CAP,
} from "./memory/files"
export { createMemoryTool } from "./memory/memory-tool"
export { REVIEWER_PROMPT, reviewTurn } from "./memory/reviewer"
export { createSkillTool } from "./memory/skill-tool"
export { listSkills, promotedSkills, readSkill, recordSkillRun, skillsIndex } from "./memory/skills"
// Permissions
export {
  computeAllowPattern,
  planQuickAdd,
  type QuickAddPlan,
} from "./permission/quick-add"
export { type PermissionDecision, type PermissionRules, resolvePermission } from "./permission/tree"
export {
  defaultAssetCacheRoot,
  type EmbeddedAssetSource,
  type ExtractCacheOptions,
  extractEmbeddedAsset,
  isCompiledExecutable,
} from "./platform/embedded-assets"
// Provider port + adapter
export { AiSdkProvider, mapFinishReason, mapUsage } from "./provider/aisdk-adapter"
export {
  createModelResolver,
  type ModelResolver,
  parseModelRef,
  presetEnvKey,
} from "./provider/hub"
export { fetchProviderModels, type ProviderModel } from "./provider/list-models"
export { OfflineMockProvider } from "./provider/mock-provider"
export {
  type CatalogCacheStatus,
  type CatalogEntry,
  catalogCacheStatus,
  fetchOllamaModels,
  ModelsCatalog,
} from "./provider/models-catalog"
export type {
  ChatMessage,
  ChatMessagePart,
  FinishReason,
  ProviderPort,
  ReasoningEffort,
  ToolCallPart,
  ToolSpec,
  TurnEvent,
  TurnRequest,
} from "./provider/port"
export { computeCostUSD, formatUSD, type ModelCost } from "./provider/pricing"
export { assemble } from "./session/assembly"
// Session
export {
  type AttentionAction,
  type AttentionConfig,
  type AttentionEvent,
  type AttentionState,
  clearProgressOsc,
  decideAttention,
  type FocusState,
  type NotifyAction,
  type ProgressAction,
  type TitleAction,
} from "./session/attention"
export {
  buildCommitMessagePrompt,
  COMMIT_MSG_PROMPT,
  type GenerateCommitMessageOptions,
  type GenerateCommitMessageResult,
  generateCommitMessage,
  recentLogSubjects,
  stageAllTracked,
  writeCommitMessageFile,
} from "./session/commit-msg"
export {
  COMPACTION_PROMPT,
  compactSession,
  VERBATIM_TAIL_TOKENS,
  needsCompaction,
  planCompaction,
} from "./session/compaction"
export { JournalHeader, now, SessionEvent, type Usage } from "./session/events"
export {
  consumeHandoff,
  formatHandoffAge,
  HANDOFF_MAX_CHARS,
  HANDOFF_PROMPT,
  HANDOFF_TRUNCATION_MARKER,
  type HandoffJournalSink,
  type HandoffPaths,
  type HandoffTurnResult,
  handoffPaths,
  type PreloadHandoffOptions,
  type PreloadHandoffResult,
  preloadHandoff,
  type RunHandoffTurnDeps,
  renderHandoffPreload,
  runHandoffTurn,
  type SaveHandoffResult,
  saveHandoff,
  truncateHandoffDoc,
} from "./session/handoff"
export {
  HOOK_EVENTS,
  type HookConfig,
  type HookEvent,
  type HookRunRecord,
  hookMatches,
  runHooks,
} from "./session/hooks"
export { SessionJournal } from "./session/journal"
export {
  foldTimeline,
  PRUNED_PLACEHOLDER,
  type ProjectedState,
  project,
  safeRewindIndex,
} from "./session/projector"
export { DEFAULT_PRUNE_WINDOW_TOKENS, planPrune } from "./session/prune"
export {
  buildReviewPrompt,
  describeGitFailure,
  describeReviewScope,
  type GatherDiffOptions,
  type GatheredDiff,
  GIT_STDERR_MAX_CHARS,
  type GitFailure,
  gatherDiff,
  journalReview,
  parseReviewArg,
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_RUBRIC,
  type ReviewEvent,
  type ReviewResult,
  runReview,
} from "./session/review"
export {
  DEFAULT_MAX_STEPS,
  type RunnerDeps,
  type RunnerEvent,
  type RunUserTurnOptions,
  runUserTurn,
  type TurnOutcome,
} from "./session/runner"
export {
  exportSessionMarkdown,
  forkSession,
  listSessions,
  type SessionSummary,
} from "./session/sessions"
export { createSnapshot, listUntracked, restoreSnapshot } from "./session/snapshot"
// Tools
export {
  BG_LOG_CAP_BYTES,
  BG_LOG_CHECK_INTERVAL_MS,
  BG_LOG_ENV,
  BG_TASKS_STATE_KEY,
  type BgTaskJournalSink,
  type BgTaskRecord,
  BgTaskRegistry,
  type BgTaskRegistryOptions,
  type BgTaskStatus,
  reapAllBackgroundTasks,
  wrapBackgroundCommand,
} from "./tool/bg-tasks"
export { type ToolContext, type ToolDefinition, ToolRegistry } from "./tool/registry"
export { DEFAULT_MODEL_OUTPUT_CHARS, settle } from "./tool/settle"
export {
  killTree,
  resolveShell,
  runCommand,
  type ShellFamily,
  type ShellResolution,
} from "./tool/shell"
export { bashTool } from "./tool/tools/bash"
export { editTool } from "./tool/tools/edit"
export { globTool } from "./tool/tools/glob"
export { grepTool } from "./tool/tools/grep"
export { readTool } from "./tool/tools/read"
export {
  createTaskTool,
  mergeWorktreeRules,
  mutatingSubagentRegistry,
  runSubagentTurn,
  type SubagentTurnOptions,
  type SubagentTurnResult,
  TASK_RULES,
  type TaskToolOptions,
  WORKTREE_RULES,
} from "./tool/tools/task"
export { todoTool } from "./tool/tools/todo"
export {
  type CreateWorktreeResult,
  countActiveWorktrees,
  createWorktree,
  MAX_CONCURRENT_WORKTREES,
  type RemoveWorktreeResult,
  removeWorktree,
  type WorktreeStatus,
  worktreeStatus,
  worktreesRoot,
} from "./tool/worktree"
export { VERSION } from "./version"
// Web (search + fetch)
export type {
  SearchBackend,
  SearchBackendName,
  SearchResult,
  WebHit,
} from "./web/backends"
export type { FetchBackend, FetchBackendName, FetchResult } from "./web/extract"
export { isPrivateOrReservedHost, SsrfError, validateFetchUrl } from "./web/ssrf"
export {
  buildWebBackends,
  type CreateWebToolOptions,
  createWebTool,
  type WebBackends,
  type WebConfig,
  webToolInput,
} from "./web/web-tool"
