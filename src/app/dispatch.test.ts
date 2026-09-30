import { describe, expect, it, vi } from 'vitest';
import { APP_API_METHODS } from '../shared/api';
import { createDispatcher, type AppMethods } from './dispatch';

// Core APIs may be plain objects or class instances (methods on the prototype); both must work.
class ClassApi {
  private secret = 'x';
  async getCounts() {
    return { all: 3 };
  }
  _internal() {
    return this.secret;
  }
  async setSettings(patch: unknown) {
    return patch;
  }
  async listJobs() {
    return [{ jobId: 'core' }];
  }
  cancelJob = vi.fn();
}

function setup(api: object) {
  const app = Object.fromEntries(
    APP_API_METHODS.map((m) => [m, vi.fn(() => `app:${m}`)]),
  ) as unknown as AppMethods<string>;
  const exportsApi = {
    cancel: vi.fn((id: string) => id === 'export-1'),
    list: vi.fn(() => [{ jobId: 'export-1' }] as never[]),
  };
  const onSettingsChanged = vi.fn();
  const dispatch = createDispatcher<string>({ api, app, exports: exportsApi, onSettingsChanged });
  return { dispatch, app, exportsApi, onSettingsChanged };
}

describe('dispatcher', () => {
  it('sends AppApi names to the app, with the calling window, and the rest to the core', async () => {
    const { dispatch, app } = setup(new ClassApi());
    expect(await dispatch('win1', 'copyText', ['hi'])).toBe('app:copyText');
    expect(app.copyText).toHaveBeenCalledWith('win1', 'hi');
    expect(await dispatch('win1', 'getCounts', [])).toEqual({ all: 3 });
  });

  it('refuses anything that is not a real core method', async () => {
    const { dispatch } = setup(new ClassApi());
    for (const name of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      '_internal',
      'secret',
      'nope',
    ]) {
      await expect(dispatch('w', name, []), name).rejects.toThrow(/Unknown method/);
    }
    await expect(dispatch('w', 42, [])).rejects.toThrow(/not understood/);
    await expect(dispatch('w', 'getCounts', 'nope')).rejects.toThrow(/not understood/);
  });

  it('keeps export jobs out of the core: cancelJob and listJobs know about them', async () => {
    const api = new ClassApi();
    const { dispatch, exportsApi } = setup(api);
    await dispatch('w', 'cancelJob', ['export-1']);
    expect(exportsApi.cancel).toHaveBeenCalledWith('export-1');
    expect(api.cancelJob).not.toHaveBeenCalled();
    await dispatch('w', 'cancelJob', ['core-job']); // not ours: the core gets it
    expect(api.cancelJob).toHaveBeenCalledWith('core-job');
    expect(await dispatch('w', 'listJobs', [])).toEqual([{ jobId: 'core' }, { jobId: 'export-1' }]);
  });

  it('tells the app when settings changed', async () => {
    const { dispatch, onSettingsChanged } = setup(new ClassApi());
    await dispatch('w', 'setSettings', [{ mcpEnabled: false }]);
    expect(onSettingsChanged).toHaveBeenCalledOnce();
  });
});
