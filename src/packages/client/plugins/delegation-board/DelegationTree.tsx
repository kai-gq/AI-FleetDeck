import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { formatTimeAgo } from '../../utils/formatting';
import {
  classifyOutputPath,
  extractOutputPath,
  formatBoardDuration,
  type BoardEntry,
  type BoardEntryStatus,
  type TreeBossNode,
  type TreeDelegationNode,
  type TreeTaskNode,
} from './boardModel';

/** 树组件与视图的交互回调（视图侧 useMemo 保证引用稳定）。 */
export interface DelegationTreeCallbacks {
  statusLabel: (status: BoardEntryStatus) => string;
  isExpanded: (key: string, defaultExpanded: boolean) => boolean;
  onToggle: (key: string, defaultExpanded: boolean) => void;
  /** 点主管/下属行名 → 打开该智能体对话（视图侧 selectAgent + setTerminalOpen）。 */
  onOpenAgent: (agentId: string) => void;
  /** 回执区「详情」→ 面板内详情（验收/五要素/标识）。 */
  onOpenDetails: (entry: BoardEntry) => void;
  /** 回执区「查看产出」（文件→查看器 / 目录→文件浏览器，视图侧分派）。 */
  onOpenOutput: (entry: BoardEntry) => void;
  agentExists: (agentId: string) => boolean;
}

interface RowProps<T> {
  node: T;
  cb: DelegationTreeCallbacks;
}

function Caret({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="delegation-tree-row__caret" onClick={onToggle}>
      <Icon name={expanded ? 'caret-down' : 'caret-right'} size={10} />
    </button>
  );
}

/** 行时间戳：完成时刻优先；委派时刻为 0（服务端在办合成条目）→ 不显示。 */
function entryTimestamp(entry: BoardEntry): number | undefined {
  if (entry.when.completedAt) return entry.when.completedAt;
  return entry.when.delegatedAt > 0 ? entry.when.delegatedAt : undefined;
}

const TaskRow = memo(function TaskRow({ node, cb }: RowProps<TreeTaskNode>) {
  const { t } = useTranslation(['terminal', 'common']);
  const expanded = cb.isExpanded(node.key, true);
  return (
    <div className="delegation-tree-task">
      <button
        type="button"
        className="delegation-tree-row is-task"
        onClick={() => cb.onToggle(node.key, true)}
      >
        <Icon
          name={expanded ? 'caret-down' : 'caret-right'}
          size={10}
          className="delegation-tree-row__caret-icon"
        />
        <span className={`delegation-tree-row__dot is-${node.statusGroup}`} />
        <span className="delegation-tree-row__name is-strong" title={node.label}>
          {node.label}
        </span>
        <span className="delegation-tree-row__badge">
          {t('terminal:delegationBoard.tree.delegationCount', {
            defaultValue: '{{count}} delegations',
            count: node.delegationCount,
          })}
        </span>
        <span className="delegation-tree-row__meta">{formatTimeAgo(node.latestAt)}</span>
      </button>
      {expanded && (
        <div className="delegation-tree-children">
          {node.bosses.map((boss) => (
            <BossRow key={boss.key} node={boss} cb={cb} />
          ))}
        </div>
      )}
    </div>
  );
});

const BossRow = memo(function BossRow({ node, cb }: RowProps<TreeBossNode>) {
  const { t } = useTranslation(['terminal', 'common']);
  const expanded = cb.isExpanded(node.key, true);
  const canOpen = cb.agentExists(node.bossId);
  return (
    <div className="delegation-tree-boss">
      <div className="delegation-tree-row is-boss">
        <Caret expanded={expanded} onToggle={() => cb.onToggle(node.key, true)} />
        <Icon name="user-circle" size={11} className="delegation-tree-row__icon" />
        <button
          type="button"
          className="delegation-tree-row__name is-link"
          disabled={!canOpen}
          title={
            canOpen
              ? t('terminal:delegationBoard.tree.openConversation', { defaultValue: 'Open conversation' })
              : undefined
          }
          onClick={() => cb.onOpenAgent(node.bossId)}
        >
          {node.bossName}
        </button>
        <span className="delegation-tree-row__badge is-boss">
          {t('terminal:delegationBoard.tree.boss', { defaultValue: 'Boss' })}
        </span>
        <span className="delegation-tree-row__meta">
          <span className={`delegation-tree-row__dot is-${node.statusGroup}`} />
          {node.delegations.length}
        </span>
      </div>
      {expanded && (
        <div className="delegation-tree-children">
          {node.delegations.map((delegation) => (
            <DelegationRow key={delegation.key} node={delegation} cb={cb} />
          ))}
        </div>
      )}
    </div>
  );
});

const DelegationRow = memo(function DelegationRow({ node, cb }: RowProps<TreeDelegationNode>) {
  const { t } = useTranslation(['terminal', 'common']);
  const { entry } = node;
  const expanded = cb.isExpanded(node.key, false); // 回执默认收起
  const canOpen = cb.agentExists(entry.who.agentId);
  const durationText =
    entry.when.durationMs !== undefined
      ? formatBoardDuration(entry.when.durationMs)
      : node.liveElapsedMs !== null
        ? formatBoardDuration(node.liveElapsedMs)
        : '';
  const timestamp = entryTimestamp(entry);
  return (
    <div className="delegation-tree-delegation">
      <div className="delegation-tree-row is-delegation">
        <Caret expanded={expanded} onToggle={() => cb.onToggle(node.key, false)} />
        <span className={`delegation-tree-row__dot is-${node.statusGroup}`} />
        <button
          type="button"
          className="delegation-tree-row__name is-link"
          disabled={!canOpen}
          title={
            canOpen
              ? t('terminal:delegationBoard.tree.openConversation', { defaultValue: 'Open conversation' })
              : undefined
          }
          onClick={() => cb.onOpenAgent(entry.who.agentId)}
        >
          {entry.who.agentName}
        </button>
        <span className={`delegation-tree-row__status is-${node.statusGroup}`}>
          {cb.statusLabel(entry.what.status)}
        </span>
        <span className="delegation-tree-row__meta">
          {durationText && (
            <>
              {durationText}
              {timestamp ? ' · ' : ''}
            </>
          )}
          {timestamp ? formatTimeAgo(timestamp) : null}
        </span>
      </div>
      {expanded && <Receipt entry={entry} cb={cb} />}
    </div>
  );
});

/** 回执行（默认收起）：摘要 / 验收 / 产出位置（可跳转）/ 评价 / 详情入口。 */
const Receipt = memo(function Receipt({ entry, cb }: { entry: BoardEntry; cb: DelegationTreeCallbacks }) {
  const { t } = useTranslation(['terminal', 'common']);
  const notRecorded = t('terminal:delegationBoard.notRecorded', { defaultValue: 'Not recorded' });
  const outputPath = extractOutputPath(entry.where.outputLocation);
  const outputKind = classifyOutputPath(entry.where.outputLocation);
  const acceptance = entry.outcome.acceptance;
  const criteria = entry.outcome.acceptanceCriteria;
  const ratingLabel =
    entry.outcome.rating === 'satisfied'
      ? t('terminal:delegationBoard.rating.satisfied', { defaultValue: 'Satisfied' })
      : entry.outcome.rating === 'unsatisfied'
        ? t('terminal:delegationBoard.rating.unsatisfied', { defaultValue: 'Unsatisfied' })
        : null;
  return (
    <div className="delegation-tree-receipt">
      {entry.where.summary && <p className="delegation-tree-receipt__summary">{entry.where.summary}</p>}
      {acceptance && acceptance.length > 0 ? (
        <ul className="delegation-board-details__acceptance">
          {acceptance.map((item) => (
            <li key={item.item} className={item.done ? 'is-done' : 'is-open'}>
              <Icon name={item.done ? 'check' : 'close'} size={10} />
              <span>{item.item}</span>
            </li>
          ))}
        </ul>
      ) : criteria && criteria.length > 0 ? (
        <ul className="delegation-board-details__acceptance">
          {criteria.map((item) => (
            <li key={item} className="is-unknown">
              <Icon name="question" size={10} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="delegation-tree-receipt__output">
        {outputKind === 'unknown' ? (
          <span className="delegation-tree-receipt__text">
            {entry.where.outputLocation?.trim() || notRecorded}
          </span>
        ) : (
          <>
            <code className="delegation-board-details__path" title={outputPath ?? undefined}>
              {outputPath}
            </code>
            <button
              type="button"
              className="delegation-tree-receipt__open"
              onClick={() => cb.onOpenOutput(entry)}
            >
              <Icon name="folder" size={10} />
              {t('terminal:delegationBoard.tree.viewOutput', { defaultValue: 'View output' })}
            </button>
          </>
        )}
      </div>
      <div className="delegation-tree-receipt__footer">
        {ratingLabel && (
          <span className={`delegation-tree-receipt__rating is-${entry.outcome.rating === 'satisfied' ? 'success' : 'danger'}`}>
            {ratingLabel}
          </span>
        )}
        <button
          type="button"
          className="delegation-tree-receipt__more"
          onClick={() => cb.onOpenDetails(entry)}
        >
          {t('terminal:delegationBoard.tree.details', { defaultValue: 'Details' })}
        </button>
      </div>
    </div>
  );
});

/** 委派树（任务 → Boss → 每次委派 → 回执）；纯展示,全部交互经 cb 回视图。 */
export function DelegationTree({ tasks, cb }: { tasks: TreeTaskNode[]; cb: DelegationTreeCallbacks }) {
  return (
    <div className="delegation-tree">
      {tasks.map((task) => (
        <TaskRow key={task.key} node={task} cb={cb} />
      ))}
    </div>
  );
}
