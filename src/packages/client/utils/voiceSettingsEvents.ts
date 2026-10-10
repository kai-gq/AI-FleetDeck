/**
 * 语音设置弹窗(VoiceSettingsModal)的外部打开事件。
 *
 * 派发:设置面板「已迁出」跳转条(ConfigSection);
 * 监听:App 层(监听常驻,弹窗懒加载未挂载时入口也有效)。
 * 单独成模块:App 不能静态 import VoiceSettingsModal(会破坏懒加载分包)。
 */
export const VOICE_SETTINGS_OPEN_EVENT = 'tide-open-voice-settings';
