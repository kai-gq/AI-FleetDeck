/**
 * 空态常用口语指令（B-32 起；B-33 由 3 条扩到 7 条）：键 → 兜底文案；
 * 点击即向大脑发一条文本（走既有 /process 流式通道）。
 * B-34 起「秘书能做什么」弹窗共用同一份清单（i18n 键为单一来源，两处文案不漂移）。
 */
export const VOICE_CHIPS: Array<{ key: string; fallback: string }> = [
  { key: 'fleetHome.voice.chip.progress', fallback: '念下今日进展' },
  { key: 'fleetHome.voice.chip.roster', fallback: '团队里都有谁' },
  { key: 'fleetHome.voice.chip.inFlight', fallback: '现在有哪些在办任务' },
  { key: 'fleetHome.voice.chip.doneToday', fallback: '今天完成了什么' },
  { key: 'fleetHome.voice.chip.decisions', fallback: '有什么需要我拍板的吗' },
  { key: 'fleetHome.voice.chip.failures', fallback: '有哪些失败的委派' },
  { key: 'fleetHome.voice.chip.news', fallback: '有什么新消息吗' },
];
