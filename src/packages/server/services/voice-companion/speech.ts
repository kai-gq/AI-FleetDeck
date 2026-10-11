/**
 * 语音伙伴服务 — 流式播报管线(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * hop1/hop2 文本增量 → 契约 JSON 字符串流切句 → action 语义门控(SpeechGate)→ 逐句回调;
 * 悬尾标点宽限 flush 与「垫话后过渡句抑制窗」常量在此(消费方:processVoiceInput)。
 */
import { createJsonStringStream, findStringField, type JsonStringStream, type SentenceChunkerOptions } from '../../voice/contract-stream.js';
import { SpeechGate, type GateAction, type SentenceMeta } from '../../voice/speech-gate.js';
import { COMPANION_ACTIONS, type CompanionAction } from './types.js';

interface SpeechPipeline {
  onHop1Delta: (fullText: string) => void;
  onHop2Delta: (fullText: string) => void;
  setHop1Action: (action: CompanionAction) => void;
  releaseHop1: (meta?: SentenceMeta) => void;
  discardHop1: () => void;
  /** 收尾:取消宽限 flush 定时器(避免请求结束后残留计时器)。 */
  dispose: () => void;
  readonly spoke: boolean;
}

const GATE_ACTIONS = new Set<string>(COMPANION_ACTIONS);

/**
 * 悬尾标点宽限 flush(P5,180ms):模型把「第一句。」写完后若在句号处停顿
 * (继续写别的字段),正常切句会等下一个字符才吐句 —— 白白拖慢首句合成。
 * 每次增量后若没有新句产出就重新计时,静默满 180ms 才强吐「已带终结符」
 * 的悬尾句;未终结的余量不受影响(切句语义不变)。
 */
const GRACE_FLUSH_MS = 180;

/**
 * 垫话反冲抑制窗(2026-10-07,用户真麦反馈「垫语出现两次」):慢档垫话刚出过声
 * 后的这个窗口内,query 过渡句(「在,我去看一眼」)不再放行 —— 一回合连出两句
 * 短垫听起来像复读(实测:「好嘞」3.0s 出声,过渡句 6.1s 紧随,隔 3.1s)。
 * W5 的「hop1 首字节即取消」只堵在途垫话:静态档零生成、emitMs 到点即吐,
 * 早于 hop1 首字节,取消永远来不及;这里才是最后一道出口闸。
 * 超窗(hop1 拖长、又静了一段)过渡句恢复出声价值,照常放行。
 */
export const PRE_ACK_SUPPRESS_AFTER_FILLER_MS = 5_000;

/**
 * 分句流式播报管线:把 hop1/hop2 的文本增量变成「可播报的整句」,
 * 经 action 语义门控(SpeechGate)后逐句回调。无 onSentence 时返回全套
 * no-op —— 旧的整段返回路径零开销、行为不变。
 */
export function createSpeechPipeline(onSentence?: (sentence: string, meta?: SentenceMeta) => void, chunker: SentenceChunkerOptions = {}): SpeechPipeline {
  if (!onSentence) {
    return {
      onHop1Delta: () => {},
      onHop2Delta: () => {},
      setHop1Action: () => {},
      releaseHop1: () => {},
      discardHop1: () => {},
      dispose: () => {},
      get spoke() { return false; },
    };
  }

  const gate = new SpeechGate(onSentence);
  const hop1Stream = createJsonStringStream('responseToUser', chunker);
  let actionSeen = false;

  // hop2 的回复没有 action 字段(答案即可播内容):独立闸门,直接放行。
  const hop2Gate = new SpeechGate(onSentence);
  hop2Gate.setAction('general_response');
  const hop2Stream = createJsonStringStream('responseToUser', chunker);

  /** 给一条流挂宽限 flush 计时器(见 GRACE_FLUSH_MS 注释)。 */
  const makeGraceFlusher = (stream: JsonStringStream, emit: (s: string) => void) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return {
      afterPush(sentences: string[]) {
        cancel();
        if (sentences.length > 0) return; // 已有整句吐出:余量必然无「可切终结符」
        timer = setTimeout(() => {
          timer = null;
          for (const s of stream.flushTerminated()) emit(s);
        }, GRACE_FLUSH_MS);
      },
      cancel,
    };
  };
  const hop1Grace = makeGraceFlusher(hop1Stream, (s) => gate.push(s));
  const hop2Grace = makeGraceFlusher(hop2Stream, (s) => hop2Gate.push(s));

  return {
    onHop1Delta(fullText: string) {
      if (!actionSeen) {
        // action 在契约最前面、枚举又短,通常第一句句号落下前就已确定;
        // 它没确定前句子先被 gate 缓冲,不会抢跑。
        const hit = findStringField(fullText, 'action');
        if (hit?.complete && GATE_ACTIONS.has(hit.value)) {
          actionSeen = true;
          gate.setAction(hit.value as GateAction);
        }
      }
      const sentences = hop1Stream.pushRaw(fullText);
      for (const s of sentences) gate.push(s);
      hop1Grace.afterPush(sentences);
    },
    onHop2Delta(fullText: string) {
      const sentences = hop2Stream.pushRaw(fullText);
      for (const s of sentences) hop2Gate.push(s);
      hop2Grace.afterPush(sentences);
    },
    setHop1Action(action: CompanionAction) {
      actionSeen = true;
      gate.setAction(action);
    },
    releaseHop1(meta?: SentenceMeta) {
      gate.release(meta);
    },
    discardHop1() {
      gate.discard();
    },
    dispose() {
      hop1Grace.cancel();
      hop2Grace.cancel();
    },
    get spoke() {
      return gate.spoke || hop2Gate.spoke;
    },
  };
}
