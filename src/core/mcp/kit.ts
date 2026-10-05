// Shared plumbing for the MCP tools: per-host state, who is calling, and tool registration.
import type {
  CallToolResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { CoreApi } from '../../shared/api';
import type { Actor, AgentActivity, KnownLibrary, LibraryState } from '../../shared/types';
import type { CoreHost } from '../contracts';
import { libraryRef } from '../libraryId';
import { UserError } from './errors';
import { PlanStore } from './plans';

/** The slice of Standard Schema (with its JSON Schema extension) the SDK reads from a tool schema. */
interface StandardSchemaV1 {
  '~standard': {
    validate: (value: unknown) => unknown;
    vendor: string;
    version: 1;
    jsonSchema: Record<'input' | 'output', (opts: unknown) => Record<string, unknown>>;
  };
}

/**
 * State that must outlive one HTTP request. The SDK builds a fresh server per request, so plans,
 * the agent activity list and what Pause needs live here, one per CoreHost.
 */
export class McpState {
  readonly plans = new PlanStore(() => this.now());
  now: () => number = () => Date.now();
  private activity = new Map<string, AgentActivity>();
  private counter = 0;
  /** Agent name -> the client it came from (see pausedAs). Newest last. */
  private clients = new Map<string, string>();
  /** Paused agents with nothing running, still shown in the strip so the user can resume them. */
  private held = new Set<string>();
  private recheck: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly host: CoreHost) {}

  private paused(name: string): boolean {
    return this.host.isAgentPaused?.(name) ?? false;
  }

  /**
   * The paused name this call answers to, or null. The user pauses the name they saw in the strip,
   * and a client could simply call itself something else next time. So a pause also holds every
   * name seen from the same client, meaning the same User-Agent product: the agent itself can't
   * change that between calls, only the program it runs in can. Limits: all agents share one token,
   * so nothing stronger tells them apart. Two programs with the same User-Agent are paused together
   * (the safe side), and a program that changes its User-Agent and its name gets through. The hard
   * stop is turning the MCP server off in Settings.
   */
  pausedAs(call: Call): string | null {
    if (this.paused(call.actor.name)) return call.actor.name;
    for (const [name, client] of this.clients)
      if (client === call.client && this.paused(name)) return name;
    return null;
  }

  /** Remember which client an agent name came from (a bounded list; paused names are kept). */
  noteClient(call: Call): void {
    this.clients.delete(call.actor.name);
    this.clients.set(call.actor.name, call.client);
    if (this.clients.size <= 200) return;
    for (const name of this.clients.keys()) {
      if (this.paused(name)) continue;
      this.clients.delete(name);
      break;
    }
  }

  /** A write refused because of Pause: keep the agent in the strip, paused, until it is resumed. */
  hold(name: string): void {
    this.held.add(name);
    this.publish();
  }

  /** Show an agent's long batch in the app's status strip. Call `end()` when it is over. */
  startActivity(
    name: string,
    label: string,
    total: number,
  ): { progress(done: number): void; end(): void } {
    const key = `${name}#${++this.counter}`;
    const entry: AgentActivity = { name, label, done: 0, total, paused: false };
    this.activity.set(key, entry);
    this.publish();
    return {
      progress: (done) => {
        entry.done = done;
        this.publish();
      },
      end: () => {
        this.activity.delete(key);
        // The user paused it while it ran: it stays in the strip, with Resume.
        if (this.paused(name)) this.held.add(name);
        this.publish();
      },
    };
  }

  publish(): void {
    for (const name of this.held) if (!this.paused(name)) this.held.delete(name);
    // One entry per agent: the strip keys its list by name, and agents make parallel calls.
    const live = new Map<string, AgentActivity>();
    for (const a of this.activity.values()) {
      const had = live.get(a.name);
      live.set(
        a.name,
        had
          ? { ...had, label: a.label, done: had.done + a.done, total: had.total + a.total }
          : { ...a, paused: this.paused(a.name) },
      );
    }
    const idle = [...this.held]
      .filter((name) => !live.has(name))
      .map((name) => ({ name, label: `${name} paused`, done: 0, total: 0, paused: true }));
    this.host.setAgentActivity([...live.values(), ...idle]);
    this.watchResume();
  }

  /** Resume happens in the app, which doesn't tell us: while a paused agent is shown, look every second. */
  private watchResume(): void {
    if (this.recheck || !this.held.size) return;
    this.recheck = setTimeout(() => {
      this.recheck = null;
      if ([...this.held].some((name) => !this.paused(name))) this.publish();
      else this.watchResume();
    }, 1000);
    this.recheck.unref?.();
  }

  dispose(): void {
    this.plans.clear();
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = null;
    this.clients.clear();
    if (this.activity.size || this.held.size) {
      this.activity.clear();
      this.held.clear();
      this.publish();
    }
  }
}

const states = new WeakMap<CoreHost, McpState>();
export function stateFor(host: CoreHost): McpState {
  let s = states.get(host);
  if (!s) states.set(host, (s = new McpState(host)));
  return s;
}

/** Everything a tool handler needs about the current call. */
export interface Call {
  host: CoreHost;
  state: McpState;
  /**
   * CoreApi whose writes are attributed to this agent in History. For a tool with a `library`
   * argument it is bound to that library for the whole call, whatever the user has open.
   */
  api: CoreApi;
  actor: Actor;
  /** The HTTP client's User-Agent product, lowercased ('' when none): what Pause keys on. */
  client: string;
}

/** Machine names of clients that don't send a display title (older protocol, User-Agent only). */
const CLIENT_TITLES: Record<string, string> = {
  'claude-code': 'Claude Code', // User-Agent "claude-code/2.1.284 (sdk-cli)", checked 2026-09-29
  'claude-ai': 'Claude',
  codex: 'Codex',
  'codex-mcp-client': 'Codex',
};

/** Client names come from the caller: keep them short, one line, printable, and readable. */
export function cleanName(raw: unknown, fallback = 'Agent'): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return CLIENT_TITLES[s.toLowerCase()] ?? (s || fallback);
}

/** A tool result carrying content the handler built itself (images). */
export class Raw {
  constructor(readonly result: CallToolResult) {}
}

type Handler<I> = (args: I, call: Call) => Promise<Record<string, unknown> | Raw>;

export type ToolKind =
  /** Reads only. */
  | 'read'
  /** Writes that add or set things; idempotent unless the tool says otherwise. */
  | 'additive'
  /** Writes that remove or overwrite things: plan-then-apply. */
  | 'changing';

export interface ToolDef<I extends z.ZodType> {
  title: string;
  description: string;
  input: I;
  kind: ToolKind;
  /** Defaults: read = true, additive = true, changing = false. */
  idempotent?: boolean;
  /** True for tools that reach outside this computer (URL downloads). */
  openWorld?: boolean;
}

function annotationsFor(def: ToolDef<z.ZodType>): ToolAnnotations {
  const readOnly = def.kind === 'read';
  const a: ToolAnnotations = {
    readOnlyHint: readOnly,
    openWorldHint: def.openWorld ?? false,
  };
  if (!readOnly) {
    a.destructiveHint = def.kind === 'changing';
    // false is the spec's default, so only a true value is sent.
    if (def.idempotent ?? def.kind === 'additive') a.idempotentHint = true;
  }
  return a;
}

function result(out: Record<string, unknown> | Raw): CallToolResult {
  if (out instanceof Raw) return out.result;
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** 2026-07-28 clients name themselves on every request; `title` is the human one ("Claude Code"). */
function envelopeClientName(ctx: ServerContext): string | undefined {
  const env = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = env?.[CLIENT_INFO_META_KEY] as { name?: unknown; title?: unknown } | undefined;
  for (const v of [info?.title, info?.name]) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

/** Keys that only restate validation limits (zod still enforces them and says so on a bad call). */
const NOISE = new Set(['$schema', 'minLength', 'maxLength', 'minItems']);

function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // Plain .int() adds +-MAX_SAFE_INTEGER bounds.
    const unbounded =
      (k === 'maximum' || k === 'minimum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER;
    if (!NOISE.has(k) && !unbounded) out[k] = prune(v);
  }
  return out;
}

/**
 * The input schema as tools/list sends it: zod's JSON Schema without the lines that only repeat
 * validation limits. Validation itself is still zod's. (Every agent session pays for tools/list.)
 */
function advertised(schema: z.ZodType): StandardSchemaV1 {
  const std = schema['~standard'] as StandardSchemaV1['~standard'];
  const lean = (io: 'input' | 'output') => (opts: unknown) =>
    prune(std.jsonSchema[io](opts)) as Record<string, unknown>;
  return { '~standard': { ...std, jsonSchema: { input: lean('input'), output: lean('output') } } };
}

/**
 * Returns `tool(name, def, handler)`. Every tool gets honest annotations, a JSON text copy of its
 * structured result (for clients that only read text), and errors as `isError` results. No tool
 * declares an output schema: agents read the result itself, and the schemas were a third of the
 * tools/list size.
 */
export function toolRegistrar(server: McpServer, host: CoreHost, clientName: string, client = '') {
  const state = stateFor(host);
  const calls = new Map<string, Call>();

  function callFor(ctx: ServerContext): Call {
    // 2026-07-28 clients name themselves on every request; older ones only via the User-Agent fallback.
    const name = cleanName(envelopeClientName(ctx) ?? clientName);
    const actorName = `${name} (MCP)`;
    let call = calls.get(actorName);
    if (!call) {
      const actor: Actor = { kind: 'agent', name: actorName };
      call = { host, state, api: host.as(actor), actor, client };
      calls.set(actorName, call);
    }
    return call;
  }

  return function tool<I extends z.ZodType>(
    name: string,
    def: ToolDef<I>,
    run: Handler<z.infer<I>>,
  ): void {
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: advertised(def.input),
      annotations: annotationsFor(def),
    };
    const cb = async (args: z.infer<I>, ctx: ServerContext): Promise<CallToolResult> => {
      try {
        const call = callFor(ctx);
        state.noteClient(call);
        // Pause: every write (undo too) is refused at once, and nothing is held back to run
        // later: by then the library, or the agent's plan, may have moved on.
        const pausedAs = def.kind === 'read' ? null : state.pausedAs(call);
        if (pausedAs !== null) {
          state.hold(pausedAs);
          return errorResult(PAUSED);
        }
        const wanted = (args as { library?: unknown }).library;
        if (typeof wanted !== 'string') return result(await run(args, call));
        // The library the agent named, held open (in the background if the user isn't viewing it).
        const lib = await findLibrary(call.api, wanted);
        const bound = await host.forLibrary(lib.path, call.actor);
        try {
          return result(await run(args, { ...call, api: bound.api }));
        } finally {
          bound.release();
        }
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
    // The SDK's generics can't follow a schema passed through a wrapper; the schema is checked at runtime.
    (server.registerTool as (n: string, c: unknown, f: unknown) => unknown).call(
      server,
      name,
      config,
      cb,
    );
  };
}

export type Tool = ReturnType<typeof toolRegistrar>;

// ── Pause (the status strip's Pause button) ──

export const PAUSED =
  'The user paused this agent in Boogie Browser, so nothing was changed. Stop here and try again after they resume it.';

/** For long writes (imports, copies) to check between files. */
export const isPaused = (call: Call): boolean => call.state.pausedAs(call) !== null;

// ── Library access helpers ──

/** A known library by path, or by name when only one has it. */
export async function findLibrary(api: CoreApi, wanted: string): Promise<KnownLibrary> {
  const known = await api.listLibraries();
  const w = wanted.trim();
  const path = libraryRef(w).path;
  const byName = known.filter((l) => l.name.toLowerCase() === w.toLowerCase());
  const hit =
    known.find((l) => l.path === w || l.path === path) ??
    (byName.length === 1 ? byName[0] : undefined);
  if (!hit)
    throw new UserError(
      byName.length > 1
        ? `Several libraries are called "${w}". Pass the path from list_libraries.`
        : `No known library "${w}". list_libraries shows them; the user adds new ones in the app.`,
    );
  if (!hit.exists) throw new UserError(`"${hit.name}" isn't there right now (${hit.path}).`);
  return hit;
}

/** The library this call works on (its `library` argument). */
export async function openLibrary(call: Call): Promise<LibraryState> {
  const s = await call.api.getLibraryState();
  if (!s) throw new UserError('That library was closed. Try again.');
  return s;
}

export async function writableLibrary(call: Call): Promise<LibraryState> {
  const s = await openLibrary(call);
  if (s.readOnly) {
    throw new UserError(
      `This library is read-only (${s.readOnlyReason ?? 'no reason given'}), so nothing was changed. Tell the user if you need it writable.`,
    );
  }
  return s;
}

/** Appended to write tool descriptions, so the rules are in front of an agent that skips the server instructions. */
export const ADDITIVE_RULE = ' Over 50 items: dry run first, then apply with its plan_id.';
export const TWO_STEP =
  ' Two steps: the first call returns the changes and a plan_id; repeat it with plan_id to apply.';

export const iso = (ms: number | null | undefined): string | null =>
  ms ? new Date(ms).toISOString() : null;
export const uniq = <T>(list: T[]): T[] => [...new Set(list)];
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
