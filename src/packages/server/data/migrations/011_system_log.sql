-- Migration 011: System Log（⑭ 日志地基①，Spec §4.14）
-- 所有关键行为（对话/播报/委派/系统活动/决策）的统一事件流。append-only：
-- 仅通过 logEvent() 追加，不 UPDATE 既有行；删旧行仅由保留期清理（event-retention-service，90 天可配）。
--
-- category 约定（可扩展）：dialog 对话 / broadcast 播报 / delegation 委派 / system 系统活动
-- level 约定：debug | info | warn | error（决策与错误 warn+ 全量；高频 info 通道按采样率降频）
-- ts 为写入时刻（epoch 毫秒）；task_id / session_id 用于串出完整链路时间线（验收 1）。

CREATE TABLE system_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  category    TEXT NOT NULL,
  source      TEXT,
  agent_id    TEXT,
  project_id  TEXT,
  session_id  TEXT,
  task_id     TEXT,
  level       TEXT NOT NULL DEFAULT 'info',
  body        TEXT
);

CREATE INDEX idx_system_log_ts ON system_log(ts);
CREATE INDEX idx_system_log_category ON system_log(category);
CREATE INDEX idx_system_log_level ON system_log(level);
CREATE INDEX idx_system_log_agent ON system_log(agent_id);
CREATE INDEX idx_system_log_project ON system_log(project_id);
-- 链路时间线查询（按 taskId / sessionId 串时间线，验收 1）
CREATE INDEX idx_system_log_session ON system_log(session_id, ts);
CREATE INDEX idx_system_log_task ON system_log(task_id, ts);
