import { registerBuiltinPlugin, registerPluginSidebarView } from '../registry';
import { boardT } from './boardI18n';
import { DelegationBoardView } from './DelegationBoardView';

const PLUGIN_ID = 'delegation-board';
let registered = false;

/** 任务24：注册委派看板内置插件（只读侧栏视图；无命令/无模态/无写入口）。 */
export function registerDelegationBoardPlugin(): void {
  if (registered) return;
  registered = true;
  registerBuiltinPlugin(PLUGIN_ID);
  registerPluginSidebarView({
    pluginId: PLUGIN_ID,
    id: 'board',
    // Getter: the tab label is read at render time so it follows the UI language.
    get title() { return boardT('delegationBoard.viewTitle', 'Delegation board'); },
    icon: 'tree',
    component: DelegationBoardView,
  });
}
