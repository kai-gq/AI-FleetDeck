import {
  registerBuiltinPlugin,
  registerPluginOutputRenderer,
  registerPluginSlashCommand,
} from '../registry';
import { JiraTicketsCard } from './JiraTicketsCard';

const PLUGIN_ID = 'jira-tickets';
let registered = false;

export function registerJiraTicketsPlugin(): void {
  if (registered) return;
  registered = true;
  registerBuiltinPlugin(PLUGIN_ID);
  registerPluginSlashCommand({
    pluginId: PLUGIN_ID,
    pluginName: 'Jira Tickets',
    name: '/jira',
    aliases: ['/tickets', '/ticket', '/jira-tickets'],
    summary: 'Show pending tickets or search: /jira [PROJ-123|search text|pending 20]',
    handler: 'show-jira-tickets',
    renderer: 'jira-ticket-list',
  });
  registerPluginOutputRenderer({
    pluginId: PLUGIN_ID,
    id: 'jira-ticket-list',
    component: JiraTicketsCard,
  });
}
