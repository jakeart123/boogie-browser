// What the user hears when a background job ends: a toast, or the dialog that has the details.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (p: unknown) => void>());
vi.mock('../../lib/api', () => ({
  api: { listJobs: async () => [], cancelJob: async () => {} },
  on: (event: string, fn: (p: unknown) => void) => (handlers.set(event, fn), () => {}),
  inElectron: false,
}));

import { ui } from '../../lib/stores/ui.svelte';
import type { JobProgress } from '../../../shared/types';
import { jobText, jobs } from './jobs.svelte';

const job = (over: Partial<JobProgress>): JobProgress => ({
  jobId: 'j1',
  kind: 'import',
  label: '',
  done: 0,
  total: 0,
  state: 'running',
  error: null,
  ...over,
});
const emit = (j: JobProgress) => handlers.get('job')!(j);

beforeEach(() => {
  ui.dialog = null;
  ui.toasts = [];
});

describe('job text', () => {
  it('says how far along it is', () => {
    expect(jobText(job({ done: 12, total: 40 }))).toBe('Importing 12 of 40');
    expect(jobText(job({ kind: 'index', done: 1200, total: 85000 }))).toBe(
      'Indexing 1,200 of 85,000',
    );
    expect(jobText(job({ kind: 'dupes' }))).toBe('Finding duplicates…');
  });
  it('shows the stage the core reports while it reads other libraries', () => {
    expect(
      jobText(job({ kind: 'dupes', label: 'Reading Course Library', done: 5, total: 50 })),
    ).toBe('Reading Course Library, 5 of 50');
  });
});

describe('when a job ends', () => {
  jobs.init();

  it("leaves duplicates as a toast with a way in, so an agent's import never covers the screen", () => {
    emit(job({ jobId: 'a', state: 'running' }));
    emit(
      job({
        jobId: 'a',
        state: 'done',
        done: 3,
        total: 3,
        result: { added: ['x'], duplicates: [{ source: '/a.png', existingId: 'e1' }], failed: [] },
      }),
    );
    expect(ui.dialog).toBeNull();
    expect(ui.toasts[0]).toMatchObject({
      kind: 'warn',
      text: 'Imported 1 item, 1 already in the library',
    });
    ui.toasts[0].action?.run();
    expect(ui.dialog).toEqual({ kind: 'import', props: { jobId: 'a' } });
  });
  it('says nothing extra while the import dialog already shows the result', () => {
    ui.openDialog('import', { jobId: 'b' });
    emit(
      job({
        jobId: 'b',
        state: 'done',
        result: { added: ['x'], duplicates: [{ source: '/a.png', existingId: 'e1' }], failed: [] },
      }),
    );
    expect(ui.dialog?.kind).toBe('import');
    expect(ui.toasts).toEqual([]);
  });
  it('counts files added only as icons as something to review', () => {
    emit(
      job({
        jobId: 'w',
        state: 'done',
        result: {
          added: ['x', 'y'],
          duplicates: [],
          failed: [],
          warnings: [{ source: '/broken.jpg', reason: 'Couldn’t read it as a picture' }],
        },
      }),
    );
    expect(ui.toasts[0]).toMatchObject({
      kind: 'warn',
      text: 'Imported 2 items, 1 only as an icon',
    });
    ui.toasts[0].action?.run();
    expect(ui.dialog).toEqual({ kind: 'import', props: { jobId: 'w' } });
  });
  it('reports a clean import with a plain toast', () => {
    emit(
      job({ jobId: 'c', state: 'done', result: { added: ['x', 'y'], duplicates: [], failed: [] } }),
    );
    expect(ui.toasts[0]).toMatchObject({ kind: 'ok', text: 'Imported 2 items' });
  });
  it('tells you a job failed, once, even if the event repeats', () => {
    emit(job({ jobId: 'd', kind: 'dupes', state: 'failed', error: 'disk is full' }));
    emit(job({ jobId: 'd', kind: 'dupes', state: 'failed', error: 'disk is full' }));
    expect(ui.toasts.map((t) => t.text)).toEqual(['The duplicate search failed. disk is full']);
  });
  it('offers the results of a finished duplicate search', () => {
    emit(job({ jobId: 'e', kind: 'dupes', state: 'done', result: [{}, {}] }));
    expect(ui.toasts[0].text).toBe('Found 2 groups of duplicates');
    ui.toasts[0].action?.run();
    expect(ui.dialog).toEqual({ kind: 'duplicates', props: { jobId: 'e' } });
  });
});
