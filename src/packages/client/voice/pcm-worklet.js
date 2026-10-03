/**
 * 语音伙伴 · PCM 采集 AudioWorklet
 *
 * 以 ?url 资源方式被 useContinuousListening.ts 加载(ctx.audioWorklet.addModule)。
 * 输入:麦克风浮点帧(浏览器按渲染量子 128 samples/次调用 process);
 * 输出:每 ~30ms 通过 port 发一包 { rms, pcm16, samples }:
 *   - rms    —— 该包 RMS(浮点算,VAD 用);
 *   - pcm16  —— 16kHz / 单声道 / 小端 Int16 的 ArrayBuffer(transfer 零拷贝,
 *              WS 流式通道与批量回退都直接用它)。
 * 降采样:线性插值(输入采样率 → targetRate),避免 WebAudio 侧再补重采样节点。
 *
 * 说明:此文件不进打包器转换(以 URL 形式加载),保持无 import/无 TS 的自包含写法;
 * 逻辑镜像见 useContinuousListening.ts 里的 createDownsampler(ScriptProcessor 回退)。
 */

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    // 每包样本数:默认 30ms(480 samples @16k)
    this.chunkSamples = Math.max(64, Math.round((this.targetRate * (opts.frameMs || 30)) / 1000));
    const inputRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000;
    this.step = this.targetRate / inputRate; // 每个输出样本跨过的输入样本数(>1 为降采样)
    this.running = true;

    // 插值状态:pos ∈ [0,1),last = 上一个输入样本
    this.pos = 0;
    this.last = 0;
    this.acc = new Float32Array(this.chunkSamples);
    this.accLen = 0;

    this.port.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'stop') this.running = false;
      else if (msg.type === 'start') this.running = true;
    };
  }

  process(inputs) {
    if (!this.running) return true;
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      const cur = channel[i];
      while (this.pos < 1) {
        this.acc[this.accLen++] = this.last + (cur - this.last) * this.pos;
        if (this.accLen >= this.chunkSamples) this.flush();
        this.pos += this.step;
      }
      this.pos -= 1;
      this.last = cur;
    }
    return true;
  }

  flush() {
    const frame = this.acc;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);

    const pcm16 = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] < -1 ? -1 : frame[i] > 1 ? 1 : frame[i];
      pcm16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    this.port.postMessage({ rms, pcm16: pcm16.buffer, samples: frame.length }, [pcm16.buffer]);

    this.acc = new Float32Array(this.chunkSamples);
    this.accLen = 0;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
