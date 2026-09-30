import { describe, expect, it } from 'vitest';
import { clampInt, mcpCommand } from './settings';

describe('settings helpers', () => {
  it('builds the exact command that connects Claude Code', () => {
    expect(mcpCommand(41597)).toBe(
      'claude mcp add --transport http boogie http://127.0.0.1:41597/mcp --header "Authorization: Bearer $(cat ~/.config/boogie-browser/api-token)"',
    );
  });
  it('keeps typed numbers inside their range and refuses non-numbers', () => {
    expect(clampInt('99999', 1024, 65535)).toBe(65535);
    expect(clampInt(' 500 ', 1, 1000)).toBe(500);
    expect(clampInt('12.6', 1, 1000)).toBe(13);
    expect(clampInt('', 1, 1000)).toBeNull();
    expect(clampInt('abc', 1, 1000)).toBeNull();
  });
});
