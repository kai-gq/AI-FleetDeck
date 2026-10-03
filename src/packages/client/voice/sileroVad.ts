/**
 * Silero VAD 浏览器胶水层(懒加载,失败绝不打断聆听)。
 *
 *   - 模型:`public/silero_vad.onnx`(官方 silero-vad v5,16k 输入 576 样本,见同目录 README);
 *   - 运行时:onnxruntime-web 的 wasm 构建,单线程(numThreads=1,不需要 COOP/COEP 跨源隔离),
 *     WASM 二进制路径经 Vite `?url` 解析(dev/build 都指向正确的静态资源);
 *   - 加载是模块级单例:首次调用真正下载与初始化,之后秒回;失败会清掉缓存的 Promise,
 *     下次启动可重试(瞬态网络问题不写死);也有 8s 超时兜底;
 *   - 加载后做契约自检(输入/输出名)+ 全零冒烟推理,防止「文件坏了但会话能建」的假就绪;
 *   - 纯计算核心在 sileroVadCore.ts(可单测),这里只做 ort 接线与 PCM 转换;
 *   - 状态可订阅(设置面板显示「就绪/加载中/已回退能量」)。
 */

import { SILERO_INPUT_SIZE, SILERO_STATE_SIZE, createSileroVadCore } from './sileroVadCore';

/** ort 模块/会话/张量:仅类型位置引用,静态零运行时依赖。 */
type OrtModule = typeof import('onnxruntime-web');
type OrtSession = import('onnxruntime-web').InferenceSession;
type OrtTensor = import('onnxruntime-web').Tensor;

export interface SileroStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** state=failed 时的原因(展示用)。 */
  error?: string;
}

export interface SileroRunner {
  /** 推入一帧 16k PCM16(ArrayBuffer,480 样本);返回最近完成的语音概率(null = 尚无)。 */
  pushFrame(pcm16: ArrayBuffer): number | null;
  reset(): void;
}

const LOAD_TIMEOUT_MS = 8000;
/** 期望的模型接口(smoke 实测确认;不匹配说明文件不对,直接判失败)。 */
const NEEDED_INPUTS = ['input', 'state', 'sr'];
const NEEDED_OUTPUTS = ['output', 'stateN'];

let ortRef: OrtModule | null = null;
let sessionRef: OrtSession | null = null;
let loadPromise: Promise<void> | null = null;
let status: SileroStatus = { state: 'idle' };
const listeners = new Set<(s: SileroStatus) => void>();

function setStatus(next: SileroStatus): void {
  status = next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      /* 订阅方异常不影响加载 */
    }
  }
}

export function getSileroStatus(): SileroStatus {
  return status;
}

export function subscribeSileroStatus(fn: (s: SileroStatus) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 一次全零冒烟推理:接口能跑、概率在 [0,1] 才认为模型可用。 */
async function smokeInfer(ort: OrtModule, session: OrtSession): Promise<void> {
  const feeds: Record<string, OrtTensor> = {
    input: new ort.Tensor('float32', new Float32Array(SILERO_INPUT_SIZE), [1, SILERO_INPUT_SIZE]),
    state: new ort.Tensor('float32', new Float32Array(SILERO_STATE_SIZE), [2, 1, 128]),
    sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
  };
  const out = await session.run(feeds);
  const prob = Number((out[session.outputNames[0]].data as Float32Array)[0]);
  if (!Number.isFinite(prob) || prob < 0 || prob > 1) {
    throw new Error(`冒烟推理结果异常(${prob})`);
  }
}

/** 懒加载模型与运行时(幂等;失败可重试)。 */
export async function loadSileroVad(): Promise<void> {
  if (status.state === 'ready') return;
  if (loadPromise) return loadPromise;
  setStatus({ state: 'loading' });
  loadPromise = (async () => {
    try {
      const ort = await import('onnxruntime-web/wasm');
      // 单线程:免 COOP/COEP;必须在创建会话前设置
      ort.env.wasm.numThreads = 1;
      const wasmUrl = (await import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url')).default;
      ort.env.wasm.wasmPaths = { wasm: wasmUrl };

      const modelUrl = `${import.meta.env.BASE_URL}silero_vad.onnx`;
      const session = await withTimeout(
        ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] }),
        LOAD_TIMEOUT_MS,
        '小模型加载超时',
      );

      const missing = NEEDED_INPUTS.filter((n) => !session.inputNames.includes(n)).concat(
        NEEDED_OUTPUTS.filter((n) => !session.outputNames.includes(n)),
      );
      if (missing.length > 0) {
        throw new Error(`模型接口不匹配(缺 ${missing.join('/')})`);
      }
      await smokeInfer(ort, session);

      ortRef = ort;
      sessionRef = session;
      setStatus({ state: 'ready' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ state: 'failed', error: message });
      loadPromise = null; // 下次启动可重试
      throw err instanceof Error ? err : new Error(message);
    }
  })();
  return loadPromise;
}

/** 建一个独立状态的推理 runner(每次聆听会话新建;模型未就绪返回 null)。 */
export function createSileroRunner(): SileroRunner | null {
  const ort = ortRef;
  const session = sessionRef;
  if (!ort || !session) return null;

  const core = createSileroVadCore(async (input, state) => {
    const feeds: Record<string, OrtTensor> = {
      input: new ort.Tensor('float32', input, [1, SILERO_INPUT_SIZE]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
    };
    const out = await session.run(feeds);
    const prob = Number((out[session.outputNames[0]].data as Float32Array)[0]);
    const nextState = out[session.outputNames[1]].data as Float32Array;
    return {
      prob: Number.isFinite(prob) ? prob : 0,
      state: nextState.slice(0, SILERO_STATE_SIZE),
    };
  });

  return {
    pushFrame(pcm16: ArrayBuffer): number | null {
      const i16 = new Int16Array(pcm16);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      return core.push(f32);
    },
    reset: () => core.reset(),
  };
}
