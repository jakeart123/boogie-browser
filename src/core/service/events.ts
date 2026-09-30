import type { BoogieEventName, BoogieEvents } from '../../shared/api';

type Listener = (payload: unknown) => void;

/** Typed event bus. A throwing listener never breaks the core. */
export class Bus {
  private listeners = new Map<BoogieEventName, Set<Listener>>();

  on<K extends BoogieEventName>(event: K, fn: (payload: BoogieEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    this.listeners.set(event, set);
    const listener = fn as Listener;
    set.add(listener);
    return () => set.delete(listener);
  }

  emit<K extends BoogieEventName>(event: K, payload: BoogieEvents[K]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[boogie] listener for "${event}" threw`, e);
      }
    }
  }

  has(event: BoogieEventName): boolean {
    return (this.listeners.get(event)?.size ?? 0) > 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
