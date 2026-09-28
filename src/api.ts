/** Typed client for the local console API.
 *
 * One place knows the wire format, so a shape change breaks the build instead of
 * rendering "undefined" in a card somewhere.
 */

const tokenMeta = document.querySelector<HTMLMetaElement>('meta[name="hermes-web-token"]');

export const TOKEN: string = tokenMeta?.content ?? "";

/** Set only in `npm run dev` when the Python server could not be reached. */
const TOKEN_ERROR: string =
  document.querySelector<HTMLMetaElement>('meta[name="hermes-web-token-error"]')?.content ?? "";

if (TOKEN_ERROR) {
  // Fail loudly and specifically. Without this the page renders and every call
  // returns a 403, which reads as a broken app rather than a missing server.
  console.error(
    `Hermes Console: no session token (${TOKEN_ERROR}). Start the backend with: ` +
      `python3 server.py --port 8787 --no-open`,
  );
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        "X-Hermes-Token": TOKEN,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ApiError(0, `Cannot reach the console server. Is it still running? (${String(cause)})`);
  }
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return payload as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------- shapes
export interface SystemInfo {
  version: string;
  upstream: string;
  install_dir: string;
  python: string;
  platform: string;
  hermes_home: string;
  config: {
    model?: string | null;
    provider?: string | null;
    base_url?: string | null;
    interface?: string | null;
    plugins_enabled: string[];
    path: string;
  };
  env_keys: number;
  disk_free_gb: number;
  disk_total_gb: number;
  uptime_s: number;
  skills_count: number;
}

export interface Skill {
  name: string;
  description: string;
  category: string;
  folder: string;
  path: string;
  abs_path: string;
  bytes: number;
}

export interface SkillsResponse {
  total: number;
  shown: number;
  categories: { name: string; count: number }[];
  skills: Skill[];
}

export interface SkillBody {
  path: string;
  content: string;
  lines: number;
}

export interface Plugin {
  name?: string;
  status?: string;
  version?: string;
  description?: string;
  source?: string;
  author?: string;
  path?: string;
  provides_tools?: string[];
  provides_commands?: string[];
  hooks?: string[];
  error?: string;
}

export interface PluginsResponse {
  total: number;
  enabled: number;
  source: string;
  confirmed_by_cli: boolean;
  cli_error: string;
  plugins: Plugin[];
}

export interface ToolEntry {
  name: string;
  enabled: boolean;
  label: string;
}

export interface ToolsResponse {
  builtin: ToolEntry[];
  plugin: ToolEntry[];
  enabled_count: number;
  total: number;
  error: string;
}

export interface SessionRow {
  id: string;
  title: string | null;
  display_name: string | null;
  model: string | null;
  source: string | null;
  profile_name: string | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number | null;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  archived: number;
  pinned: number;
}

export interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_name: string | null;
  tool_calls: string | null;
  timestamp: number;
  active: number;
  compacted: number;
}

export interface SessionDetail {
  session: Record<string, unknown> | null;
  messages: MessageRow[];
  error?: string;
}

export interface CronJob {
  id?: string;
  name?: string;
  schedule?: unknown;
  prompt?: string;
  enabled?: boolean;
  paused?: boolean;
  next_run_at?: number;
  last_run_at?: number;
  deliver?: string;
  repeat?: number;
  run_count?: number;
}

export interface CronResponse {
  total: number;
  jobs: CronJob[];
}

export interface ActivityEvent {
  ts: number;
  type: string;
  session?: string;
  tool?: string;
  brief?: string;
  model?: string;
  dur?: number;
  chars?: number;
  prompt?: string;
  reason?: string;
  call?: number;
  reply_chars?: number;
  completed?: boolean;
  platform?: string;
  usage?: { in?: number; out?: number; total?: number };
  [key: string]: unknown;
}

export interface ActivityResponse {
  events: ActivityEvent[];
  now: number;
}

export interface RunEvent {
  ts: number;
  kind: string;
  text?: string;
  session_id?: string;
  code?: number;
  session?: string;
  message?: string;
}

export interface RunSnapshot {
  id: string;
  session: string;
  session_id: string | null;
  message: string;
  status: "running" | "done" | "error" | "stopped";
  exit_code: number | null;
  reply: string;
  error: string;
  started_at: number;
  ended_at: number | null;
  events: RunEvent[];
}

export interface CustomProvider {
  name: string;
  base_url: string;
  default_model: string;
  models: string[];
  env_key: string;
  key_present: boolean;
}

export interface BuiltinProvider {
  id: string;
  name: string;
  models: string[];
  env_keys: string[];
  key_present: boolean;
}

export interface ModelsResponse {
  current: { model?: string | null; provider?: string | null; base_url?: string | null };
  custom_providers: CustomProvider[];
  builtin_providers: BuiltinProvider[];
  usable_builtin: number;
  config_path: string;
  error?: string;
}

export interface SetModelResult {
  ok: boolean;
  applied?: boolean;
  backup?: string;
  now?: { model?: string | null; provider?: string | null; base_url?: string | null };
  note?: string;
  error?: string;
}

export interface AddProviderResult {
  ok: boolean;
  added?: string;
  env_key?: string;
  models_parsed?: number;
  key_present?: boolean;
  backup?: string;
  note?: string;
  error?: string;
}

// ---------------------------------------------------------------- calls
export const api = {
  system: () => request<SystemInfo>("/api/system"),
  skills: (params: { q?: string; category?: string; force?: boolean }) =>
    request<SkillsResponse>(`/api/skills${qs({ q: params.q, category: params.category, force: params.force ? 1 : undefined })}`),
  skill: (absPath: string) => request<SkillBody>(`/api/skill${qs({ path: absPath })}`),
  plugins: (force = false) => request<PluginsResponse>(`/api/plugins${qs({ force: force ? 1 : undefined })}`),
  tools: () => request<ToolsResponse>("/api/tools"),
  sessions: (params: { q?: string; limit?: number }) =>
    request<{ total: number; sessions: SessionRow[] }>(`/api/sessions${qs({ q: params.q, limit: params.limit })}`),
  session: (id: string) => request<SessionDetail>(`/api/session${qs({ id })}`),
  cron: () => request<CronResponse>("/api/cron"),
  activity: (since = 0) => request<ActivityResponse>(`/api/activity${qs({ since })}`),
  models: () => request<ModelsResponse>("/api/models"),
  setModel: (payload: { model: string; provider?: string; base_url?: string; env_key?: string }) =>
    request<SetModelResult>("/api/model/set", { method: "POST", body: JSON.stringify(payload) }),
  addProvider: (payload: { name: string; base_url: string; api_key: string; default_model?: string; models?: string }) =>
    request<AddProviderResult>("/api/provider/add", { method: "POST", body: JSON.stringify(payload) }),
  runs: () => request<{ runs: RunSnapshot[] }>("/api/runs"),
  run: (id: string) => request<RunSnapshot>(`/api/run${qs({ id })}`),
  chat: (session: string, message: string) =>
    request<{ run_id: string; status: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ session, message }),
    }),
  stopRun: (id: string) =>
    request<{ ok: boolean }>("/api/run/stop", { method: "POST", body: JSON.stringify({ id }) }),
};

export function streamActivity(since: number, handlers: {
  onEvent: (event: ActivityEvent) => void;
  onState: (state: "open" | "reconnecting") => void;
}): () => void {
  const source = new EventSource(`/api/stream${qs({ since, token: TOKEN })}`);
  source.addEventListener("activity", (raw) => {
    try {
      handlers.onEvent(JSON.parse((raw as MessageEvent<string>).data) as ActivityEvent);
    } catch {
      /* skip a malformed frame */
    }
  });
  source.addEventListener("ping", () => handlers.onState("open"));
  source.onopen = () => handlers.onState("open");
  source.onerror = () => handlers.onState("reconnecting");
  return () => source.close();
}

/** Subscribe to a run's output. Returns a disposer. */
export function streamRun(runId: string, handlers: {
  onEvent: (event: RunEvent) => void;
  onEnd: (final: { status: string; exit_code: number | null; reply: string; error: string; session_id: string | null }) => void;
  onError: (message: string) => void;
}): () => void {
  // EventSource cannot set request headers, so the token rides in the query
  // string here. The server is loopback-bound and answers with
  // Referrer-Policy: no-referrer, so it does not leak.
  const source = new EventSource(`/api/run/events${qs({ id: runId, token: TOKEN })}`);
  let closed = false;

  source.addEventListener("event", (raw) => {
    try {
      handlers.onEvent(JSON.parse((raw as MessageEvent<string>).data) as RunEvent);
    } catch {
      /* a malformed frame is not worth tearing the stream down for */
    }
  });
  source.addEventListener("end", (raw) => {
    try {
      handlers.onEnd(JSON.parse((raw as MessageEvent<string>).data));
    } catch {
      handlers.onEnd({ status: "error", exit_code: null, reply: "", error: "Malformed stream end.", session_id: null });
    }
    closed = true;
    source.close();
  });
  source.addEventListener("ping", () => { /* keeps the connection warm */ });
  source.onerror = () => {
    if (closed) return;
    closed = true;
    source.close();
    handlers.onError("The stream to the server dropped.");
  };
  return () => {
    closed = true;
    source.close();
  };
}
