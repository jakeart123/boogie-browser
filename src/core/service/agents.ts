// Pausing an agent's work from the status strip. The MCP server asks `isPaused` between chunks of
// a long job and waits while it is true; the status shows the flag on the agent's activity.

export class AgentPauses {
  private readonly paused = new Set<string>();

  constructor(private readonly changed: () => void) {}

  set(name: string, paused: boolean): void {
    const key = name.trim();
    if (!key) throw new Error('Which agent?');
    if (paused === this.paused.has(key)) return;
    if (paused) this.paused.add(key);
    else this.paused.delete(key);
    this.changed();
  }

  isPaused(name: string): boolean {
    return this.paused.has(name.trim());
  }
}
