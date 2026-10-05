/**
 * 语音伙伴 · 常驻 claude 通道(任务18·秘书常驻化)
 *
 * 背景:秘书(voice-companion-service)原先每回合 spawn 一次性 `claude --print`
 * (callClaudeOnce),每次冷启动。本模块提供「进程跨回合存活 + stdin 复用」的
 * 轻量常驻通道 —— 机制对齐 claude/runner.ts(claude 后端 stdin 在回合同保持可写,
 * stream-json 输入协议接受追加的 {type:"user",…} 行),但**不复用 ClaudeRunner**
 * (runtime/agent 记录耦合 + bypass 缺省 = 安全姿态漂移)。
 *
 * 设计约束(任务18 冻结边界):
 * - **每回合 args 与今日逐字同构**:spawn 参数、shell:true、--system-prompt-file
 *   (进程建立时写入一次)、--resume 语义全部照旧;仅「生命周期/收发环」变化。
 * - **权限姿态不变**:不引入 --dangerously-skip-permissions 等任何新权限参数。
 * - **回合结束判定**:收到 `result` 事件即本回合完成(进程保持存活等下一轮);
 *   若进程先 close(旧一次性行为 / 假子进程 harness / 崩溃),按 close 语义结算
 *   —— 与 callClaudeOnce 同口径(文本三源优先取一、code!==0 且无文本 → 抛错)。
 * - **崩溃重启**:进程非预期退出 → 下一轮自动 respawn + `--resume` 续会话
 *   (由调用方传入 state.sessionId)。
 * - **进程卫生(Windows)**:PID 落盘(voice-companion.json 旁)+ 服务启动时清扫
 *   残留 + 进程退出钩子 + shell:true 下 taskkill /T /F 树杀(SIGTERM 只达 cmd.exe)。
 * - **回退开关**:TC_JARVIS_COMPANION_RESIDENT=0 → 调用方直走一次性 callClaudeOnce
 *   (本模块不被触碰)。
 * - **W3 预热点火**:prewarmCompanionProcess 提前建好进程(用户开口/回合收尾补建),
 *   幂等 + 失败静默;TC_VOICE_PREWARM=0 关。
 *
 * 回合内协议(与 callClaudeOnce 相同):
 *   stdin: {"type":"user","message":{"role":"user","content":<文本+REMINDER>}}\n
 *   stdout: system/init(带 session_id)→ [stream_event text_delta] → assistant → result
 */

import { execFile, spawn, spawnSync, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeBackend } from '../claude/index.js';
import { logger, sanitizeUnicode } from '../utils/index.js';

const log = logger.server;

// ============================================================================
// 开关 / 类型
// ============================================================================

/** 常驻化回退开关(缺省开;'0' = 逐字回退今日一次性 spawn 行为)。 */
export const COMPANION_RESIDENT_ENV = 'TC_JARVIS_COMPANION_RESIDENT';

export function isCompanionResidentEnabled(): boolean {
  return process.env[COMPANION_RESIDENT_ENV] !== '0';
}

/** W3 预热点火回退开关(缺省开;'0' = 关,排障用;常驻通道关时一并无效)。 */
export const COMPANION_PREWARM_ENV = 'TC_VOICE_PREWARM';

export function isCompanionPrewarmEnabled(): boolean {
  return isCompanionResidentEnabled() && process.env[COMPANION_PREWARM_ENV] !== '0';
}

/** result 事件里采到的上下文占用(秘书侧原先全丢;任务18 起用于 80% 压缩判定)。 */
export interface CompanionContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** CLI modelUsage 里的上下文窗口;缺失为 null,调用方用配置兜底。 */
  contextWindow: number | null;
}

export interface CompanionTurnRequest {
  systemPrompt: string;
  userContent: string;
  model: string;
  resumeId: string | null;
  timeoutMs: number;
  reminder?: boolean;
  /** 增量文本(累计值):分句流式播报用它边生成边切句。 */
  onTextDelta?: (fullText: string) => void;
  /** 中止信号:abort 时树杀进程并以 makeAbortError() 拒绝。 */
  signal?: AbortSignal;
  /** abort 错误工厂(vcs 注入 VoiceCompanionAbortedError,保 instanceof 兼容)。 */
  makeAbortError: () => Error;
}

export interface CompanionTurnResult {
  text: string;
  sessionId: string | null;
  stderr: string;
  /** 本回合 result 事件里的上下文占用(无 usage 事件时 null)。 */
  context: CompanionContextUsage | null;
  /** W6 观测:本回合复用常驻进程(true)还是新建(false)。 */
  reused: boolean;
}

/** W3 预热点火请求:进程建立只需这三样(与真实回合解耦,不带 turn)。 */
export interface CompanionPrewarmRequest {
  systemPrompt: string;
  model: string;
  resumeId: string | null;
}

/** 常驻进程台账(PID 落盘;进程卫生三件套的凭据)。 */
export interface CompanionPidRecord {
  /** 拥有该子进程的 server 进程 pid:server 死 → 子进程视为残留,启动清扫时树杀。 */
  serverPid: number;
  childPid: number | null;
  startedAt: number;
  /** 诊断用:最近一次进程活动时间(不作为清扫判据,避免误杀闲置实例)。 */
  heartbeatAt: number;
  model: string;
}

export interface CompanionRunnerStats {
  /** 新建常驻进程次数(L3 冷启动口径)。 */
  spawns: number;
  /** 复用次数(与 `process reused: pid=` 埋点同源)。 */
  reuses: number;
  lastReusePid: number | null;
}

// ============================================================================
// PID 落盘(与 voice-companion.json 同目录,XDG 可重定向)
// ============================================================================

const PID_FILE = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'tide-commander',
  'voice-companion-process.json',
);

/** 测试断言用:常驻进程台账文件路径(XDG 沙箱内)。 */
export function getCompanionPidFilePath(): string {
  return PID_FILE;
}

function removePidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) fs.rmSync(PID_FILE, { force: true });
  } catch { /* 忽略:进程卫生绝不打断主链路 */ }
}

function writePidRecord(proc: ResidentProcess): void {
  try {
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const record: CompanionPidRecord = {
      serverPid: process.pid,
      childPid: proc.pid,
      startedAt: proc.startedAt,
      heartbeatAt: Date.now(),
      model: proc.model,
    };
    const tmp = `${PID_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, PID_FILE);
  } catch (err) {
    log.warn(`[VoiceCompanion] 常驻进程 PID 落盘失败(忽略): ${(err as Error).message}`);
  }
}

// ============================================================================
// 进程判活 / 树杀
// ============================================================================

/** PID 是否活着(Windows 亦支持 signal 0;EPERM = 存在但无权限,按活处理)。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** shell:true 下 SIGTERM 只达 cmd.exe 包装层——Windows 用 taskkill /T /F 杀整棵树。 */
function killPidTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* pid 已退出时非 0,预期 */ });
    } catch { /* 忽略 */ }
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 忽略 */ }
  }
}

// ============================================================================
// 启动清扫(残留进程)
// ============================================================================

export interface CompanionSweepDeps {
  isAlive?: (pid: number) => boolean;
  killTree?: (pid: number) => void;
}

export interface CompanionSweepResult {
  swept: boolean;
  reason: string;
  childPid?: number;
}

/**
 * 清扫上一次 server 留下的常驻进程(PID 文件里 serverPid 已死 → 子进程为孤儿)。
 * 判据只用 owner(server)存活状态:同一 XDG 目录下有活着的 server 时不误杀
 * (双实例场景交给各自退出钩子)。
 */
export function sweepStaleCompanionProcess(deps: CompanionSweepDeps = {}): CompanionSweepResult {
  let raw: string;
  try {
    if (!fs.existsSync(PID_FILE)) return { swept: false, reason: 'no-file' };
    raw = fs.readFileSync(PID_FILE, 'utf-8');
  } catch {
    return { swept: false, reason: 'unreadable' };
  }

  let record: CompanionPidRecord | null = null;
  try {
    record = JSON.parse(raw) as CompanionPidRecord;
  } catch {
    record = null;
  }
  if (!record || typeof record !== 'object' || typeof record.serverPid !== 'number') {
    removePidFile();
    return { swept: false, reason: 'corrupt' };
  }

  const isAlive = deps.isAlive ?? isProcessAlive;
  // serverPid === 本进程 pid:pid 不可能被两个活进程共用 → 必为上一代实例的残留。
  const ownerAlive = record.serverPid !== process.pid && isAlive(record.serverPid);
  if (ownerAlive) return { swept: false, reason: 'owner-alive' };

  const childPid = typeof record.childPid === 'number' ? record.childPid : undefined;
  if (childPid != null && isAlive(childPid)) {
    (deps.killTree ?? killPidTree)(childPid);
    log.log(`[VoiceCompanion] 清扫残留常驻进程: pid=${childPid}(owner pid=${record.serverPid} 已消失)`);
  }
  removePidFile();
  return childPid != null ? { swept: true, reason: 'killed', childPid } : { swept: true, reason: 'stale-file' };
}

// ============================================================================
// 常驻进程单例
// ============================================================================

interface ActiveTurn {
  settled: boolean;
  resolve: (r: CompanionTurnResult) => void;
  reject: (e: Error) => void;
  userContent: string;
  reminder: boolean;
  makeAbortError: () => Error;
  onTextDelta?: (fullText: string) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout: ReturnType<typeof setTimeout> | null;
  timeoutMs: number;
  assistantText: string;
  deltaText: string;
  resultText: string;
  stderrBuf: string;
  context: CompanionContextUsage | null;
  /** W6 观测:复用/新建(见 CompanionTurnResult.reused)。 */
  reused: boolean;
}

interface ResidentProcess {
  child: ChildProcess;
  pid: number | null;
  model: string;
  startedAt: number;
  /** 由 close/error 维护(不读 child.exitCode:FakeChild/极端时序下不可靠)。 */
  exited: boolean;
  sessionId: string | null;
  decoder: StringDecoder;
  buffer: string;
  /** 系统提示词临时文件(照旧在回合结算时清理,失败隔离)。 */
  promptFile: string | null;
  /** spawn 事件是否已到(新建进程在 spawn 后才写 stdin,与旧一次性行为对齐)。 */
  spawned: boolean;
  turn: ActiveTurn | null;
}

let resident: ResidentProcess | null = null;
let hygieneDone = false;
let exitHookInstalled = false;

const stats: CompanionRunnerStats = { spawns: 0, reuses: 0, lastReusePid: null };

export function getCompanionRunnerStats(): CompanionRunnerStats {
  return { ...stats };
}

export function getCompanionProcessInfo(): { pid: number | null; model: string; startedAt: number; sessionId: string | null } | null {
  if (!resident || resident.exited) return null;
  return { pid: resident.pid, model: resident.model, startedAt: resident.startedAt, sessionId: resident.sessionId };
}

/** 服务启动时清扫残留 + 装退出钩子(幂等)。挂载点:attachVoiceCompanionStream。 */
export function initCompanionProcessHygiene(): void {
  if (hygieneDone) return;
  hygieneDone = true;
  installExitHook();
  try {
    sweepStaleCompanionProcess();
  } catch (err) {
    log.warn(`[VoiceCompanion] 残留进程清扫失败(忽略): ${(err as Error).message}`);
  }
}

/** 进程退出钩子:清掉常驻子进程整棵树(server 崩溃/被杀也不留孤儿)。 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    const proc = resident;
    resident = null;
    if (!proc || proc.exited) return;
    const pid = proc.pid;
    if (process.platform === 'win32' && pid != null) {
      try {
        // exit 钩子必须同步:spawnSync 是唯一能在进程退出前完成 taskkill 的方式。
        // 必须先树杀再补信号(顺序理由同 killResidentProcess)。
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } catch { /* 忽略 */ }
    }
    try { proc.child.kill('SIGKILL'); } catch { /* 忽略 */ }
    removePidFile();
  });
}

/** 测试用:复位单例/统计/台账(不触任务18 的产品语义)。 */
export function resetCompanionRunnerForTests(): void {
  const proc = resident;
  resident = null;
  if (proc && !proc.exited) killResidentProcess(proc);
  removePidFile();
  stats.spawns = 0;
  stats.reuses = 0;
  stats.lastReusePid = null;
}

/**
 * 主动停掉常驻进程(会话轮换/人设切换/重置时调用;下一次调用会重新 spawn)。
 * 不抛错、不阻塞:进程整棵树立即树杀,close 事件做余下清理。
 */
export function stopCompanionProcess(reason: string): void {
  const proc = resident;
  resident = null;
  removePidFile();
  if (!proc) return;
  if (!proc.exited) {
    log.log(`[VoiceCompanion] 常驻进程停止: pid=${proc.pid ?? 'unknown'} reason=${reason}`);
    killResidentProcess(proc);
  }
  cleanupPromptFile(proc);
}

// ============================================================================
// 回合入口
// ============================================================================

/**
 * 执行一回合 callClaude 收发。首轮/崩溃后自动 spawn;随后复用同一进程写 stdin。
 * 入参语义与 callClaudeOnce 一致(见 CompanionTurnRequest)。
 */
export function runCompanionTurn(req: CompanionTurnRequest): Promise<CompanionTurnResult> {
  if (req.signal?.aborted) return Promise.reject(req.makeAbortError());
  initCompanionProcessHygiene();

  let proc = getReusableProcess(req.model);
  const reused = !!proc;
  if (proc) {
    stats.reuses += 1;
    stats.lastReusePid = proc.pid;
    log.log(`[VoiceCompanion] process reused: pid=${proc.pid ?? 'unknown'}`);
  } else {
    try {
      proc = spawnResidentProcess(req);
    } catch (err) {
      return Promise.reject(err);
    }
    stats.spawns += 1;
  }
  return beginTurn(proc, req, reused);
}

/** W3:是否有活着的常驻进程(空闲/回合中都算;预热幂等判定用)。 */
export function hasLiveCompanionProcess(): boolean {
  return !!resident && !resident.exited;
}

/**
 * W3 预热点火:提前建好常驻进程,把冷启动(进程 spawn + CLI 引导)藏到用户还在
 * 说话/回合刚结束的空档;真实回合到来时经既有 stdin 复用直接开跑。
 *
 * - 幂等:已有活进程且模型一致 → 跳过(回合进行中也不打扰);
 * - 模型变更 → 停旧建新(与 getReusableProcess 同口径,下一回合 args 即刻生效);
 * - 失败静默:spawn 异常一律吞掉 —— 预热只是加成,主链路不受影响(下一次真实
 *   回合自会按老路 spawn,行为与无预热逐字一致)。
 * - resumeId 传「下一次 spawn 会用」的当前 state.sessionId(与 runHop1 同源);
 *   null 时新进程不带 --resume,与常规首轮相同。
 */
export function prewarmCompanionProcess(req: CompanionPrewarmRequest): boolean {
  if (!isCompanionPrewarmEnabled()) return false;
  initCompanionProcessHygiene();
  const live = resident;
  if (live && !live.exited) {
    if (live.turn) return false;
    if (live.model === req.model) return false;
    stopCompanionProcess(`prewarm-model-changed->${req.model}`);
  }
  try {
    const proc = spawnResidentProcess(req);
    stats.spawns += 1;
    log.log(`[VoiceCompanion] 预热点火:常驻进程就绪 pid=${proc.pid ?? 'unknown'} model=${req.model}`);
    return true;
  } catch (err) {
    log.warn(`[VoiceCompanion] 预热失败(静默): ${(err as Error).message}`);
    return false;
  }
}

/** 可复用的常驻进程:存活 + stdin 可写 + 模型未变(配置换模型时重建,args 随之生效)。 */
function getReusableProcess(model: string): ResidentProcess | null {
  const proc = resident;
  if (!proc) return null;
  if (proc.exited) {
    resident = null;
    return null;
  }
  if (proc.turn) {
    // 互斥队列下不应发生;若发生(乱序调用)宁可再生进程也不并发写 stdin。
    log.warn(`[VoiceCompanion] 常驻进程仍在回合中被复用请求命中,重建进程`);
    stopCompanionProcess('busy');
    return null;
  }
  const stdin = proc.child.stdin;
  if (!stdin || stdin.writable === false) {
    stopCompanionProcess('stdin-closed');
    return null;
  }
  if (proc.model !== model) {
    stopCompanionProcess(`model-changed->${model}`);
    return null;
  }
  return proc;
}

function spawnResidentProcess(req: CompanionPrewarmRequest): ResidentProcess {
  const claudeBackend = new ClaudeBackend();
  const executable = claudeBackend.getExecutablePath();
  const args = [
    '--print',
    '--verbose',
    '--model', req.model,
    '--output-format', 'stream-json',
    // 增量事件(text_delta)——分句流水线的前提。
    '--include-partial-messages',
    '--input-format', 'stream-json',
  ];

  const systemPromptFile = path.join(os.tmpdir(), `voice-companion-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(systemPromptFile, req.systemPrompt);
  args.push('--system-prompt-file', systemPromptFile);
  if (req.resumeId) args.push('--resume', req.resumeId);

  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      // 主运行器在 Windows 用 shell:true 启动(cmd.exe 才能执行 .cmd 安装的 claude);
      // 参数均无空格/特殊字符,无需转义。
      shell: process.platform === 'win32',
      windowsHide: true,
    });
  } catch (err) {
    cleanupFile(systemPromptFile);
    throw err;
  }

  const proc: ResidentProcess = {
    child,
    pid: typeof child.pid === 'number' ? child.pid : null,
    model: req.model,
    startedAt: Date.now(),
    exited: false,
    sessionId: null,
    decoder: new StringDecoder('utf8'),
    buffer: '',
    promptFile: systemPromptFile,
    spawned: false,
    turn: null,
  };
  resident = proc;

  child.stdout?.on('data', (data: Buffer) => handleStdout(proc, data));
  child.stderr?.on('data', (data: Buffer) => {
    const turn = proc.turn;
    if (!turn) return;
    turn.stderrBuf += proc.decoder.write(data);
    if (turn.stderrBuf.length > 4_000) turn.stderrBuf = turn.stderrBuf.slice(-4_000);
  });
  child.on('close', (code) => handleClose(proc, code));
  child.on('error', (err) => handleProcessError(proc, err));
  child.on('spawn', () => {
    proc.spawned = true;
    // 进程建立后 CLI 已读取提示词文件;文件仍留到回合结算再删(与一次性路径同口径,
    // 也便于 harness 在回合内读取验证)。
    if (proc.turn) writeTurnInput(proc, proc.turn);
  });

  writePidRecord(proc);
  log.log(`[VoiceCompanion] 常驻进程启动: pid=${proc.pid ?? 'unknown'} model=${req.model}${req.resumeId ? ` resume=${req.resumeId}` : ''}`);
  return proc;
}

function beginTurn(proc: ResidentProcess, req: CompanionTurnRequest, reused: boolean): Promise<CompanionTurnResult> {
  return new Promise<CompanionTurnResult>((resolve, reject) => {
    const turn: ActiveTurn = {
      settled: false,
      resolve,
      reject,
      userContent: req.userContent,
      reminder: !!req.reminder,
      makeAbortError: req.makeAbortError,
      onTextDelta: req.onTextDelta,
      signal: req.signal,
      timeout: null,
      timeoutMs: req.timeoutMs,
      assistantText: '',
      deltaText: '',
      resultText: '',
      stderrBuf: '',
      context: null,
      reused,
    };
    proc.turn = turn;

    turn.timeout = setTimeout(() => {
      settleTurn(proc, turn, { kind: 'timeout' });
    }, req.timeoutMs);

    if (req.signal) {
      const onAbort = () => settleTurn(proc, turn, { kind: 'abort' });
      turn.onAbort = onAbort;
      req.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (proc.spawned) {
      writeTurnInput(proc, turn);
    }
    // else:等 spawn 事件(与一次性路径一致:spawn 后才写 stdin)。
  });
}

/** 组装并写入本回合的 user 消息(与 callClaudeOnce 逐字同构;不 end stdin)。 */
function writeTurnInput(proc: ResidentProcess, turn: ActiveTurn): void {
  const reminder = turn.reminder ? '\n\n[REMINDER: Output ONLY the JSON object. No explanations.]' : '';
  const stdinMessage = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: sanitizeUnicode(turn.userContent) + reminder },
  });
  try {
    proc.child.stdin?.write(`${stdinMessage}\n`, (err?: Error | null) => {
      if (err) log.warn(`[VoiceCompanion] 常驻进程 stdin 写入失败: ${err.message}`);
    });
  } catch (err) {
    settleTurn(proc, turn, { kind: 'error', error: err as Error });
  }
}

// ============================================================================
// stdout 事件解析
// ============================================================================

function handleStdout(proc: ResidentProcess, data: Buffer): void {
  proc.buffer += proc.decoder.write(data);
  const lines = proc.buffer.split('\n');
  proc.buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 忽略非 JSON 行
    }
    handleEvent(proc, event);
  }
}

function handleEvent(proc: ResidentProcess, event: Record<string, unknown>): void {
  if (event.type === 'system' && typeof event.session_id === 'string') proc.sessionId = event.session_id;

  const turn = proc.turn;
  if (!turn || turn.settled) return;

  if (event.type === 'assistant' && event.message && typeof event.message === 'object') {
    const content = (event.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string' && text) turn.assistantText += text;
        }
      }
    }
  }

  if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
    const streamEvent = event.event as { type?: unknown; delta?: { type?: unknown; text?: unknown } };
    if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
      const text = streamEvent.delta.text;
      if (typeof text === 'string' && text) {
        turn.deltaText += text;
        turn.onTextDelta?.(turn.deltaText);
      }
    }
  }

  if (event.type === 'result') {
    if (typeof event.result === 'string') turn.resultText = event.result;
    const usage = extractContextUsage(event, proc.model);
    if (usage) turn.context = usage;
    // result = 本回合结束的协议信号:文本三源已齐 → 立即结算,进程保持存活等下一轮。
    const textOutput = turn.assistantText || turn.deltaText || turn.resultText;
    if (textOutput) {
      settleTurn(proc, turn, { kind: 'result' });
    } else {
      // 空 result(异常/无输出):与一次性路径 close 时同口径降级,不让回合悬到超时。
      settleTurn(proc, turn, { kind: 'close-error', code: 0, message: 'No response from Claude' });
    }
  }
}

function handleProcessError(proc: ResidentProcess, err: Error): void {
  proc.exited = true;
  if (resident === proc) {
    resident = null;
    removePidFile();
  }
  const turn = proc.turn;
  if (turn) settleTurn(proc, turn, { kind: 'error', error: err });
  cleanupPromptFile(proc);
}

function handleClose(proc: ResidentProcess, code: number | null): void {
  proc.exited = true;
  if (resident === proc) {
    resident = null;
    removePidFile();
  }
  const turn = proc.turn;
  if (!turn || turn.settled) return;

  // 收尾:与 callClaudeOnce 同口径——残余半行只认 session_id(不采信半行文本)。
  try {
    const remaining = proc.buffer + proc.decoder.end();
    if (remaining.trim()) {
      const event = JSON.parse(remaining) as { type?: string; session_id?: string };
      if (event.type === 'system' && event.session_id) proc.sessionId = event.session_id;
    }
  } catch { /* 忽略 */ }
  proc.buffer = '';

  const textOutput = turn.assistantText || turn.deltaText || turn.resultText;
  if (code !== 0 && !textOutput) {
    settleTurn(proc, turn, { kind: 'close-error', code, message: `Claude exited with code ${code}` });
  } else if (!textOutput) {
    settleTurn(proc, turn, { kind: 'close-error', code, message: 'No response from Claude' });
  } else {
    settleTurn(proc, turn, { kind: 'close-ok', code });
  }
}

// ============================================================================
// 回合结算
// ============================================================================

type SettleOutcome =
  | { kind: 'result' }
  | { kind: 'close-ok'; code: number | null }
  | { kind: 'close-error'; code: number | null; message: string }
  | { kind: 'timeout' }
  | { kind: 'abort' }
  | { kind: 'error'; error: Error };

function settleTurn(proc: ResidentProcess, turn: ActiveTurn, outcome: SettleOutcome): void {
  if (turn.settled) return;
  turn.settled = true;
  if (proc.turn === turn) proc.turn = null;

  if (turn.timeout) clearTimeout(turn.timeout);
  turn.timeout = null;
  if (turn.signal && turn.onAbort) {
    turn.signal.removeEventListener('abort', turn.onAbort);
    turn.onAbort = undefined;
  }
  cleanupPromptFile(proc);

  const result = (): CompanionTurnResult => ({
    text: turn.assistantText || turn.deltaText || turn.resultText,
    sessionId: proc.sessionId,
    stderr: turn.stderrBuf,
    context: turn.context,
    reused: turn.reused,
  });

  switch (outcome.kind) {
    case 'result':
    case 'close-ok':
      touchPidHeartbeat(proc);
      turn.resolve(result());
      return;
    case 'close-error': {
      const err = new Error(outcome.message) as Error & { stderr?: string };
      err.stderr = turn.stderrBuf;
      turn.reject(err);
      return;
    }
    case 'timeout': {
      // 超时进程已不可信:树杀并作废(下一轮 respawn + --resume 续会话)。
      if (resident === proc) {
        resident = null;
        removePidFile();
      }
      killResidentProcess(proc);
      const err = new Error(`Claude timed out after ${turn.timeoutMs}ms`);
      err.name = 'VoiceCompanionTimeout';
      turn.reject(err);
      return;
    }
    case 'abort': {
      if (resident === proc) {
        resident = null;
        removePidFile();
      }
      killResidentProcess(proc);
      turn.reject(turn.makeAbortError());
      return;
    }
    case 'error':
      turn.reject(outcome.error);
      return;
  }
}

/**
 * 树杀常驻进程。Windows 上顺序是关键:shell:true 的直接子进程是 cmd.exe,
 * `child.kill('SIGTERM')` 只会 TerminateProcess cmd.exe —— 若先杀 cmd,node/claude
 * 孙子进程会成孤儿且 taskkill 再也找不到树。因此有 pid 时**只走 taskkill /T /F**
 * (一次收整棵树);无 pid 的会话(测试垫片)才退回信号,保 harness 可观测。
 */
function killResidentProcess(proc: ResidentProcess): void {
  if (proc.exited) return;
  if (process.platform === 'win32') {
    if (proc.pid != null) {
      killPidTree(proc.pid);
    } else {
      try { proc.child.kill('SIGTERM'); } catch { /* 忽略 */ }
    }
  } else {
    try { proc.child.kill('SIGTERM'); } catch { /* 忽略 */ }
    killPidTree(proc.pid ?? 0);
  }
  const killTimer = setTimeout(() => {
    try { proc.child.kill('SIGKILL'); } catch { /* 忽略 */ }
    killPidTree(proc.pid ?? 0);
  }, 5_000);
  killTimer.unref?.();
}

/** 回合成功结算即刷新台账心跳(诊断用;不参与清扫判据)。 */
function touchPidHeartbeat(proc: ResidentProcess): void {
  if (proc.exited || resident !== proc) return;
  writePidRecord(proc);
}

function cleanupPromptFile(proc: ResidentProcess): void {
  if (!proc.promptFile) return;
  cleanupFile(proc.promptFile);
  proc.promptFile = null;
}

function cleanupFile(file: string): void {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* 忽略 */ }
}

// ============================================================================
// usage 采集(result 事件)
// ============================================================================

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 从 result 事件抽上下文占用:usage(输入/缓存) + modelUsage 的 contextWindow。
 * modelUsage 可能多模型计费——优先取与请求 model 匹配的键,否则取第一项。
 */
export function extractContextUsage(event: Record<string, unknown>, requestedModel?: string): CompanionContextUsage | null {
  const usage = event.usage && typeof event.usage === 'object'
    ? event.usage as Record<string, unknown>
    : null;
  if (!usage) return null;
  const inputTokens = toNumber(usage.input_tokens);
  const outputTokens = toNumber(usage.output_tokens);
  const cacheReadInputTokens = toNumber(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = toNumber(usage.cache_creation_input_tokens);
  if (inputTokens + cacheReadInputTokens + cacheCreationInputTokens <= 0 && outputTokens <= 0) return null;

  let contextWindow: number | null = null;
  const modelUsage = event.modelUsage && typeof event.modelUsage === 'object'
    ? event.modelUsage as Record<string, unknown>
    : null;
  if (modelUsage) {
    const keys = Object.keys(modelUsage);
    const preferred = requestedModel
      ? keys.find((key) => key.includes(requestedModel)) ?? keys[0]
      : keys[0];
    const chosen = preferred ? modelUsage[preferred] : undefined;
    if (chosen && typeof chosen === 'object') {
      const window = (chosen as { contextWindow?: unknown }).contextWindow;
      if (typeof window === 'number' && window > 0) contextWindow = window;
    }
  }
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, contextWindow };
}
