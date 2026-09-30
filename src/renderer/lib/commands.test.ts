// A held-down Enter must act once: its repeats run no command and don't click the focused button
// (the first press often opens a confirm whose button has focus: "Merge tags", a bulk edit).
import { describe, expect, it, vi } from 'vitest';
import { commands, enterMode, installKeyHandler, registerCommands } from './commands.svelte';

function keyTarget() {
  let handler: ((e: KeyboardEvent) => void) | null = null;
  const target = {
    addEventListener: (_: string, fn: (e: KeyboardEvent) => void) => (handler = fn),
    removeEventListener: () => {},
  } as unknown as Window;
  installKeyHandler(target);
  return (key: string, opts: { repeat?: boolean; on?: string } = {}) => {
    const e = {
      key,
      code: key,
      repeat: !!opts.repeat,
      isComposing: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      target: { tagName: opts.on ?? 'BUTTON', isContentEditable: false },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    handler!(e as unknown as KeyboardEvent);
    return e;
  };
}

describe('held Enter', () => {
  it('runs its command once and blocks the repeats, also on a focused button', () => {
    const press = keyTarget();
    const run = vi.fn();
    const off = registerCommands([{ id: 't.enter', title: 'Open', keys: ['Enter'], run }]);
    press('Enter', { on: 'DIV' });
    expect(run).toHaveBeenCalledTimes(1);
    const repeat = press('Enter', { repeat: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(repeat.preventDefault).toHaveBeenCalled(); // no click on the focused confirm button
    // Typing in a text field keeps its own Enter handling (a text area's new lines).
    expect(press('Enter', { repeat: true, on: 'TEXTAREA' }).preventDefault).not.toHaveBeenCalled();
    off();
  });
});

describe('held keys', () => {
  it('run a writing command once, and repeat only commands made for holding', () => {
    const press = keyTarget();
    const trash = vi.fn();
    const next = vi.fn();
    const off = registerCommands([
      { id: 't.trash', title: 'Trash', keys: ['X'], run: trash },
      { id: 't.next', title: 'Next', keys: ['ArrowRight'], repeat: true, run: next },
    ]);
    press('X', { on: 'DIV' });
    for (let i = 0; i < 6; i++) press('X', { repeat: true, on: 'DIV' });
    expect(trash).toHaveBeenCalledTimes(1);
    press('ArrowRight', { on: 'DIV' });
    for (let i = 0; i < 6; i++) press('ArrowRight', { repeat: true, on: 'DIV' });
    expect(next).toHaveBeenCalledTimes(7);
    off();
  });
});

describe('full-window modes', () => {
  it('let through only what the top mode keeps, plus overlay and dialog close keys', () => {
    const press = keyTarget();
    const behind = vi.fn();
    const own = vi.fn();
    const close = vi.fn();
    const off = registerCommands([
      { id: 'folder.new', title: 'New folder', keys: ['Ctrl+Shift+N', 'N'], run: behind },
      { id: 'triage.skip', title: 'Skip', keys: ['S'], run: own },
      { id: 'overlay.escape', title: 'Close', keys: ['Escape'], anyMode: true, run: close },
    ]);
    const leave = enterMode('triage', (c) => c.id.startsWith('triage.'));
    press('N', { on: 'DIV' });
    press('S', { on: 'DIV' });
    press('Escape', { on: 'DIV' });
    expect([behind.mock.calls.length, own.mock.calls.length, close.mock.calls.length]).toEqual([
      0, 1, 1,
    ]);
    // The palette lists what the mode keeps, and can't run the rest by id either.
    const ids = commands.enabled({ region: 'other' }).map((c) => c.id);
    expect(ids).toContain('triage.skip');
    expect(ids).not.toContain('folder.new');
    // A dialog over the mode keeps nothing of either.
    const leaveDialog = enterMode('dialog', () => false);
    press('S', { on: 'DIV' });
    expect(own).toHaveBeenCalledTimes(1);
    leaveDialog();
    leave();
    press('N', { on: 'DIV' });
    expect(behind).toHaveBeenCalledTimes(1);
    off();
  });
});
