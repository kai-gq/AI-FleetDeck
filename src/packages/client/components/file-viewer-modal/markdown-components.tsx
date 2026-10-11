/**
 * Markdown 渲染组件表(自 FileViewerModal 迁出)。
 *
 * 自 FileViewerModal.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { extractCodeText, getCodeLanguage } from './helpers';
import React from 'react';
import { type Components } from 'react-markdown';
import { PlantUmlDiagram } from '../PlantUmlDiagram';

/**
 * Markdown renderer overrides for the file viewer:
 *  - fenced ```plantuml blocks render as actual diagrams (PlantUmlDiagram)
 *  - all other code blocks and inline code keep rendering normally
 */
export const MARKDOWN_COMPONENTS: Components = {
  code({ node: _node, className, children, ...rest }) {
    if (getCodeLanguage(className) === 'plantuml') {
      return <PlantUmlDiagram source={extractCodeText(children).replace(/\n$/, '')} />;
    }
    return <code className={className} {...rest}>{children}</code>;
  },
  pre({ children }) {
    // PlantUmlDiagram renders its own block container, so unwrap the <pre> for
    // plantuml blocks to avoid invalid <pre><div> nesting. Other blocks keep <pre>.
    const child = Array.isArray(children) ? children[0] : children;
    const childClass =
      React.isValidElement<{ className?: string }>(child) ? child.props.className : undefined;
    if (getCodeLanguage(childClass) === 'plantuml') {
      return <>{children}</>;
    }
    return <pre>{children}</pre>;
  },
};
