/**
 * 设置节内的「关系说明」小条:本页设置还被哪些功能消费 + 互跳入口。
 *
 * 刻意不走 HighlightText(不参与搜索高亮):说明文字是导航辅助,
 * 混进 settingsSearch 守卫解析器的标签集合只会让关键词表更难维护。
 */

import React from 'react';

export interface ConfigRelationLink {
  label: string;
  /** 目标节 id(对应 shouldShowSection 的 id / config-section-<id> 锚点)。 */
  target: string;
}

export interface ConfigRelationItem {
  text: string;
  links?: ConfigRelationLink[];
}

export function ConfigRelationNote({
  items,
  onJump,
}: {
  items: ConfigRelationItem[];
  onJump?: (target: string) => void;
}) {
  return (
    <div className="config-relation-note">
      {items.map((item, index) => (
        <div key={index} className="config-relation-line">
          <span>{item.text}</span>
          {(item.links ?? []).map((link) => (
            <button
              key={link.target}
              type="button"
              className="config-relation-link"
              onClick={() => onJump?.(link.target)}
            >
              {link.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
