/**
 * 语音「打开X」本地直达指令 —— 语音转文字终稿在进大脑(hop1)之前的固定触发层。
 *
 * 命中规则(严格档,用户拍板;宁缺毋滥):
 *   「打开 + 名字」:名字与某个智能体的显示名精确相等(容忍句尾标点、
 *   「吧/啊」类语气词、ASR 插入的空格如「打开 小陈」);
 *   「打开指挥官」「打开指挥官视图」 → 指挥官视图。
 *   不命中一律返回 null,调用方原样进大脑 —— 本模块对原链路零影响。
 *
 * 执行(executeOpenCommand):
 *   agent = Spotlight 同款动作(selectAgent + 非 flat 视图下 requestTerminalExpand);
 *   指挥官 = 派发 tide:open-commander 事件桥(App.tsx 监听后 commanderModal.open())。
 *   返回确认语 OPEN_COMMAND_ACK(「已打开」,短句求快),由调用方出声播报
 *   (用户拍板:命中要出声确认;VoiceCompanion 在 partial 阶段用同一常量预热音频)。
 *
 * 边界(明确不做,见 2026-10-07 计划):「帮我打开」「打开一下」「打开X的聊天框」
 * 等变体;关闭类指令;其他动词(切换/看看)。查询类(「打开小陈的日志」)一律不命中。
 */

import { store } from '../store';

export type OpenCommand =
  | { kind: 'agent'; agentId: string; name: string }
  | { kind: 'commander' };

/**
 * 命中后的固定确认语。刻意最短(用户拍板「直接说已打开」):
 * 短的合成快、播得也快;VoiceCompanion 在 ASR partial 以「打开」开头时
 * 用同一常量预热 TTS 缓存 → 命中瞬间直接播,省掉关键路径的合成段。
 */
export const OPEN_COMMAND_ACK = '已打开';

/** 指挥官视图的固定别名(「指挥官是视图」,优先于同名 agent)。 */
const COMMANDER_ALIASES = ['指挥官', '指挥官视图'];

/** 句尾标点(中英)与空白。 */
const TRAILING_NOISE_RE = /[\s。！？!?~～、,，.·…]+$/;
/** 句尾语气词(ASR 常带;一次剥一个)。 */
const TRAILING_PARTICLE_RE = /[吧呗啊呀哦哈]$/;

const stripTrailingNoise = (s: string): string => s.replace(TRAILING_NOISE_RE, '').trim();

/**
 * 提取候选目标串(按「保守 → 归一」排序):
 *   「打开小陈。」→ 小陈;「打开小陈吧」→ [小陈吧, 小陈]。
 * 先试保守串(名字本身以语气词结尾的极端情况可原样命中),再试剥语气词后的串。
 */
function targetCandidates(raw: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const conservative = stripTrailingNoise(raw);
  push(conservative);
  push(stripTrailingNoise(conservative.replace(TRAILING_PARTICLE_RE, '')));
  return out;
}

/**
 * 匹配「打开X」指令。
 * @param agents 智能体列表(id + 显示名),取调用时的实时快照。
 * @returns 命中 → 指令;未命中 → null(调用方原样进大脑)。
 */
export function matchOpenCommand(
  text: string,
  agents: Iterable<{ id: string; name: string }>,
): OpenCommand | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('打开')) return null;
  const raw = trimmed.slice(2).trim();

  for (const target of targetCandidates(raw)) {
    if (COMMANDER_ALIASES.includes(target)) return { kind: 'commander' };
    for (const agent of agents) {
      const name = (agent.name ?? '').trim();
      if (name && name === target) {
        return { kind: 'agent', agentId: agent.id, name };
      }
    }
  }
  return null;
}

/**
 * 执行指令并返回确认语(固定 OPEN_COMMAND_ACK)。
 * 副作用:agent → 选中 + 展开终端面板;指挥官 → 派发 tide:open-commander。
 */
export function executeOpenCommand(cmd: OpenCommand): string {
  if (cmd.kind === 'agent') {
    store.selectAgent(cmd.agentId);
    if (store.getState().viewMode !== 'flat') {
      store.requestTerminalExpand();
    }
    return OPEN_COMMAND_ACK;
  }
  window.dispatchEvent(new CustomEvent('tide:open-commander'));
  return OPEN_COMMAND_ACK;
}
