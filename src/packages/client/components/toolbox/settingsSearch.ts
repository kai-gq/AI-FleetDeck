export interface SettingsSearchSection {
  readonly id: string;
  readonly title: string;
  readonly keywords: readonly string[];
}

/**
 * Shared index for Settings search surfaces.
 *
 * Keep this list aligned with the sections rendered by ConfigSection. Both the
 * Settings panel and Spotlight use it so a query produces the same sections in
 * either place.
 */
export const SETTINGS_SEARCH_SECTIONS: readonly SettingsSearchSection[] = [
  // Keywords are matched in every UI language — keep the English terms, the
  // Spanish ones already here, and the zh-CN terms appended below so a query
  // typed in any of them reveals the same sections.
  { id: 'plugins', title: 'Plugins', keywords: ['plugin', 'plugins', 'extensions', 'install', 'enable', 'disable', 'trusted', 'local', 'slash commands', 'sidebar', 'modal', 'renderer', '插件', '扩展', '安装', '启用', '禁用'] },
  { id: 'general', title: 'General', keywords: ['history', 'hide costs', 'grid', 'fps', 'power saving', 'low power', 'battery', 'bajo consumo', 'performance', 'limit', 'editor', 'external editor', 'language', 'idioma', '语言', 'vibration', 'haptic', 'intensity', 'tab title', 'tmux', 'process persistence', 'interactive', 'tui', 'terminal', 'experimental', 'claude', 'stream', 'streaming', 'word by word', 'live text', 'grok', 'codex', 'app-server', 'app server', 'opencode', 'serve', 'pi', 'rpc', 'steer', 'steering', 'mid-turn', 'mid turn', 'hover', 'preview', 'tooltip', 'ctrl', 'popup', 'vista previa', 'sound', 'sounds', 'sonido', 'sonidos', 'notification', 'notifications', 'notificacion', 'notificaciones', 'volume', 'volumen', 'tone', 'tones', 'tono', 'chime', 'alert', 'cue', 'audio', 'mute', 'silence', 'dock', 'activity', 'recent', 'notification sound', 'silenciar', 'custom sound', 'upload sound', 'alerta', 'file search', 'excluded folders', 'node_modules', 'vendor', 'git', 'spotlight', 'ignore', '通用', '历史', '省电', '低功耗', '性能', '震动', '通知', '声音', '音量', '终端', '预览'] },
  { id: 'agentNames', title: 'Agent Names', keywords: ['agent', 'names', 'custom', 'characters', 'rename', '智能体', '名称', '角色', '重命名', '智能体名称'] },
  { id: 'defaultClass', title: 'Default Spawn Class', keywords: ['default', 'class', 'spawn', 'agent', 'scout', 'builder', 'random', '默认', '创建', '职业', '类型', '默认创建类别'] },
  { id: 'defaultSkills', title: 'Default Agent Skills', keywords: ['skills', 'default', 'default skills', 'default agent skills', 'spawn', 'agent', 'preselect', 'pre-selected', 'tracking', 'label', 'context', 'prompt', 'overhead', 'new agent', 'habilidades', '技能', '默认技能', '智能体', '预选', '提示词', '智能体默认技能'] },
  { id: 'appearance', title: 'Appearance', keywords: ['theme', 'appearance', 'color', 'dark', 'light', 'style', 'look', '外观', '主题', '颜色', '深色', '浅色'] },
  { id: 'connection', title: 'Connection', keywords: ['backend', 'url', 'auth', 'token', 'reconnect', 'server', 'api', 'connect', 'codex', 'opencode', 'binary', 'path', '连接', '后端', '地址', '令牌', '重连', '服务器'] },
  { id: 'scene', title: 'Scene', keywords: ['character', 'size', 'indicator', 'scale', 'time', 'dawn', 'day', 'dusk', 'night', 'auto', '场景', '角色', '大小', '指示器', '时间'] },
  { id: 'terrain', title: 'Terrain', keywords: ['trees', 'bushes', 'house', 'lamps', 'grass', 'clouds', 'fog', 'brightness', 'floor', 'sky', 'color', 'environment', 'battlefield', 'size', 'grid', 'simple', 'minimal', 'dark', 'clean', '地形', '树木', '灌木', '房屋', '草地', '云', '天空', '环境', '战场'] },
  { id: 'modelStyle', title: 'Agent Model Style', keywords: ['saturation', 'roughness', 'metalness', 'glow', 'emissive', 'reflections', 'wireframe', 'color mode', 'material', 'shader', '模型', '风格', '材质', '颜色', '智能体模型样式'] },
  { id: 'animations', title: 'Animations', keywords: ['idle', 'working', 'animation', 'walk', 'run', 'sprint', 'jump', 'sit', 'crouch', '动画', '待机', '行走', '奔跑'] },
  { id: 'secrets', title: 'Secrets', keywords: ['secrets', 'api', 'key', 'password', 'credentials', 'env', 'environment', '密钥', '密码', '环境变量', '凭据'] },
  { id: 'claudeAccounts', title: 'Claude Accounts', keywords: ['claude', 'accounts', 'credentials', 'oauth', 'rate limit', 'session', 'david', 'profile', 'switch account', 'subscription', '账号', '凭据', '订阅', '切换账号', 'Claude 账号'] },
  { id: 'grokAccounts', title: 'Grok Accounts', keywords: ['grok', 'xai', 'x.ai', 'accounts', 'credentials', 'oauth', 'session', 'profile', 'switch account', 'subscription', '账号', '凭据', '订阅', '切换账号', 'Grok 账号'] },
  { id: 'codexAccounts', title: 'Codex Accounts', keywords: ['codex', 'openai', 'chatgpt', 'accounts', 'credentials', 'oauth', 'session', 'profile', 'switch account', 'subscription', '账号', '凭据', '订阅', '切换账号', 'Codex 账号'] },
  { id: 'systemPrompt', title: 'System Prompt', keywords: ['system', 'prompt', 'global', 'instructions', 'ai', 'agent', 'rules', 'guidelines', '系统提示词', '全局', '指令', '规则'] },
  { id: 'data', title: 'Data', keywords: ['export', 'import', 'backup', 'restore', 'save', 'load', 'json', '数据', '导出', '导入', '备份', '恢复'] },
  { id: 'integrations', title: 'Integrations', keywords: ['integrations', 'integraciones', 'gmail', 'slack', 'jira', 'calendar', 'docx', 'email', 'whatsapp', 'notifications', 'notification', 'baileys', 'history', 'historial', 'chat', 'messages', 'inbox', 'config', 'setup', '集成', '邮件', '日历', '聊天'] },
  { id: 'workflows', title: 'Workflows', keywords: ['workflow', 'automation', 'state machine', 'editor', 'actions', 'transitions', 'pipeline', '工作流', '自动化', '编辑器', '动作'] },
  { id: 'triggers', title: 'Triggers', keywords: ['trigger', 'event', 'webhook', 'cron', 'slack', 'email', 'jira', 'matching', 'fire', '触发器', '事件', '定时', '匹配'] },
  { id: 'monitoring', title: 'Monitoring', keywords: ['monitoring', 'logs', 'triggers', 'events', 'history', 'workflow', 'traces', 'audit', 'timeline', '监控', '日志', '审计'] },
  { id: 'statistics', title: 'Statistics', keywords: ['statistics', 'stats', 'usage', 'tokens', 'token', 'claude', 'chart', 'graph', 'pie', 'cost', '统计', '用量', '图表', '成本'] },
  { id: 'voiceCompanion', title: 'Voice Companion', keywords: ['voice companion', 'companion', 'voice', 'listening', 'continuous listening', 'always on', 'microphone', 'wake word', 'end words', 'silence', 'vad', 'barge in', 'barge-in', 'interrupt', 'volcengine', 'streaming', 'real-time', 'real time', 'asr', 'speech recognition', 'proactive', 'memory', 'recall', 'haiku', 'sonnet', 'effort', 'thinking', 'reasoning', 'silero', 'onnx', 'local model', 'app id', 'access token', 'api key', 'credential', 'credentials', 'resource id', 'endpoint', '能量', '小模型', '判停引擎', '确认时长', '语音伙伴', '伙伴', '持续聆听', '常开', '聆听', '麦克风', '唤醒词', '结束词', '静音', '判停', '断句', '抢话', '打断', '火山引擎', '流式', '实时', '语音识别', '转写', '主动汇报', '汇报', '巡查', '记忆', '上下文', '凭据', '密钥', '资源 ID', '端点', '思考档位', '思考', '档位'] },
  { id: 'experimental', title: 'Experimental', keywords: ['experimental', '2d', 'view', 'voice', 'speech', 'tts', 'text to speech', 'echo', 'prompt', 'duplicate', '实验', '语音', '语音合成', '回声', '实验性'] },
  { id: 'about', title: 'About', keywords: ['about', 'version', 'update', 'credits', 'github', 'releases', '关于', '版本', '更新', '发布'] },
];

/** Match sections with the same substring behavior used by the Settings panel. */
export function searchSettingsSections(query: string): readonly SettingsSearchSection[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return SETTINGS_SEARCH_SECTIONS;

  return SETTINGS_SEARCH_SECTIONS.filter((section) => (
    section.title.toLowerCase().includes(normalizedQuery)
    || section.keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery))
  ));
}
