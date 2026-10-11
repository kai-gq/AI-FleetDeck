import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => ({
  skills: [] as unknown[],
  defaultSlugs: [] as string[],
}));

vi.mock('../data/index.js', () => ({
  loadSkills: () => stored.skills,
  saveSkills: vi.fn(),
}));
vi.mock('../integrations/integration-registry.js', () => ({ getIntegrationSkills: () => [] }));
vi.mock('./instruction-refresh.js', () => ({ markInstructionsDirty: vi.fn() }));
vi.mock('./default-agent-skills-service.js', () => ({
  getDefaultAgentSkillSlugs: () => stored.defaultSlugs,
  renameDefaultAgentSkillSlug: vi.fn(),
}));

const now = Date.now();
const skill = (id: string, slug: string) => ({
  id, name: id, slug, description: '', content: '', allowedTools: [],
  assignedAgentIds: [], assignedAgentClasses: [], enabled: true, createdAt: now, updatedAt: now,
});

describe('resolveInitialSkillIdsForCreate', () => {
  beforeEach(() => {
    vi.resetModules();
    stored.skills = [skill('skill-a-id', 'alpha'), skill('skill-b-id', 'beta')];
    stored.defaultSlugs = ['alpha', 'beta'];
  });

  it('passes an explicit list through verbatim — including an empty one', async () => {
    const svc = await import('./skill-service.js');
    svc.initSkills();
    expect(svc.resolveInitialSkillIdsForCreate(['custom-1'])).toEqual(['custom-1']);
    expect(svc.resolveInitialSkillIdsForCreate([])).toEqual([]);
  });

  it('falls back to the installation defaults when the list is missing', async () => {
    const svc = await import('./skill-service.js');
    svc.initSkills();
    expect(svc.resolveInitialSkillIdsForCreate(undefined)).toEqual(['skill-a-id', 'skill-b-id']);
    expect(svc.resolveInitialSkillIdsForCreate()).toEqual(['skill-a-id', 'skill-b-id']);
  });

  it('skips default slugs that match no installed skill', async () => {
    stored.defaultSlugs = ['alpha', 'ghost-slug', 'beta'];
    const svc = await import('./skill-service.js');
    svc.initSkills();
    expect(svc.resolveInitialSkillIdsForCreate(undefined)).toEqual(['skill-a-id', 'skill-b-id']);
  });
});
