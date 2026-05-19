import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CategoryService, MatchResult } from '../category.service.js';
import type { CategoryRepository, UserCategory } from '../category.repository.js';

function fakeCat(id: number, name: string, usage = 0): UserCategory {
  return { id, userId: 1, kind: 'expense', name, usageCount: usage, lastUsedAt: null };
}

describe('CategoryService.match', () => {
  let repo: CategoryRepository;
  let svc: CategoryService;

  beforeEach(() => {
    repo = {
      findByName: vi.fn(),
      create: vi.fn(),
      topN: vi.fn(),
      listActive: vi.fn(),
      bump: vi.fn(),
    } as unknown as CategoryRepository;
    svc = new CategoryService(repo);
  });

  it('returns matched category when input matches case-insensitively (intent=exact)', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(fakeCat(7, 'Semillas', 3));
    const r = await svc.match(1, 'expense', 'semillas', 'exact');
    expect(r).toEqual<MatchResult>({ kind: 'matched', category: fakeCat(7, 'Semillas', 3) });
  });

  it('returns needs-confirmation when input has no match and intent=unknown', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(null);
    vi.mocked(repo.topN).mockResolvedValue([fakeCat(1, 'Semillas'), fakeCat(2, 'Insumos')]);
    const r = await svc.match(1, 'expense', 'flete', 'unknown');
    expect(r.kind).toBe('needs-confirmation');
    if (r.kind === 'needs-confirmation') {
      expect(r.suggestions.map(c => c.name)).toEqual(['Semillas', 'Insumos']);
    }
  });

  it('creates a new category when intent=new and name is unique', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(null);
    vi.mocked(repo.create).mockResolvedValue(fakeCat(99, 'Cosecha 2026'));
    const r = await svc.match(1, 'expense', 'Cosecha 2026', 'new');
    expect(r).toEqual<MatchResult>({ kind: 'matched', category: fakeCat(99, 'Cosecha 2026') });
  });

  it('treats intent=new but existing name as a match (does not create duplicate)', async () => {
    vi.mocked(repo.findByName).mockResolvedValue(fakeCat(7, 'Semillas', 3));
    const r = await svc.match(1, 'expense', 'semillas', 'new');
    expect(r).toEqual<MatchResult>({ kind: 'matched', category: fakeCat(7, 'Semillas', 3) });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('falls back to needs-confirmation when no category was provided at all', async () => {
    vi.mocked(repo.topN).mockResolvedValue([fakeCat(1, 'Semillas')]);
    const r = await svc.match(1, 'expense', null, 'unknown');
    expect(r.kind).toBe('needs-confirmation');
  });
});

describe('CategoryService.bootstrapDefaults', () => {
  let repo: CategoryRepository;
  let svc: CategoryService;

  beforeEach(() => {
    repo = {
      listActive: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation((u, k, name) => Promise.resolve(fakeCat(1, name))),
    } as unknown as CategoryRepository;
    svc = new CategoryService(repo);
  });

  it('seeds 9 expense defaults on first call when listActive is empty', async () => {
    await svc.bootstrapDefaults(1, 'expense');
    expect(repo.create).toHaveBeenCalledTimes(9);
    const inserted = vi.mocked(repo.create).mock.calls.map(([, , n]) => n);
    expect(inserted).toContain('Semillas');
    expect(inserted).toContain('Combustible');
    expect(inserted).toContain('Otros');
  });

  it('does nothing when the user already has categories', async () => {
    vi.mocked(repo.listActive).mockResolvedValue([fakeCat(1, 'Semillas')]);
    await svc.bootstrapDefaults(1, 'expense');
    expect(repo.create).not.toHaveBeenCalled();
  });
});
