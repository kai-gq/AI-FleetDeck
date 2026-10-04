import type { BuiltinSkillDefinition } from './types.js';

export const reportTaskToBoss: BuiltinSkillDefinition = {
  slug: 'report-task-to-boss',
  name: 'Report Task to Boss',
  description: 'Notify your boss agent that a delegated task is finished so the boss can review and decide next steps.',
  allowedTools: ['Bash(curl:*)'],
  content: `# Delegation Report (MANDATORY when delegated)

If the task starts with \`[DELEGATED TASK from boss\`, your agent has a \`bossId\`, or a boss assigned the work, call this after all work—even trivial work—is done:

\`POST /api/agents/YOUR_AGENT_ID/report-task\` (use your ID, not the boss ID)

\`\`\`json
{"summary":"Work done and result; explain failures","status":"completed","outputLocation":"path or link to the deliverable","acceptance":[{"item":"acceptance criterion verified","done":true}]}
\`\`\`

Status is \`completed\` or \`failed\`. A \`completed\` report MUST include \`outputLocation\` (where the deliverable lives) and a non-empty \`acceptance\` array of \`{item, done}\` checkmarks; a report missing either is rejected with HTTP 400 and must be resent with both fields. \`failed\` reports do not require them — explain the failure in \`summary\`. This API call alone closes delegation; messages and notifications do not. It is the first end-of-turn call, before notification and tracking. If missed, send it as soon as noticed.`,
};
