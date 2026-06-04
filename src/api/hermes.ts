import type { ConnectionProfile, CronJob, McpServer, SessionSummary, SkillInfo, ToolsetInfo } from '../types';

type RpcHandler = (event: any) => void;

export type AuthProviderInfo = {
  name: string;
  display_name?: string;
  supports_password?: boolean;
};

export type GatewayProbe = {
  baseUrl: string;
  status: any;
  authRequired: boolean;
  providers: AuthProviderInfo[];
  injectedToken?: string;
};

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function buildWsUrl(baseUrl: string, token: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export function buildWsTicketUrl(baseUrl: string, ticket: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}

export function buildWsUrlForProfile(profile: ConnectionProfile): string {
  if (profile.wsTicket) return buildWsTicketUrl(profile.baseUrl, profile.wsTicket);
  return buildWsUrl(profile.baseUrl, profile.token || '');
}

export function extractInjectedSessionToken(html: string): string {
  const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/);
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return ''; }
}

export function parsePairingPayload(input: string): Partial<ConnectionProfile> | null {
  const raw = input.trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.url === 'string') return { baseUrl: obj.url, token: String(obj.token ?? '') };
  } catch {}
  try {
    const url = new URL(raw);
    const baseUrl = url.searchParams.get('url') || url.searchParams.get('baseUrl') || (url.protocol.startsWith('http') ? raw : '');
    const token = url.searchParams.get('token') || '';
    if (baseUrl) return { baseUrl, token };
  } catch {}
  return null;
}

async function readJsonOrText(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

export class HermesRestClient {
  constructor(private profile: ConnectionProfile) {}

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string> | undefined) ?? {})
    };
    if (this.profile.token) headers['X-Hermes-Session-Token'] = this.profile.token;

    const res = await fetch(`${normalizeBaseUrl(this.profile.baseUrl)}${path}`, {
      ...options,
      credentials: 'include',
      headers
    });
    const data = await readJsonOrText(res);
    if (!res.ok) throw new Error(typeof data === 'string' ? data : data?.detail || data?.message || `${res.status} ${res.statusText}`);
    return data as T;
  }

  status() { return this.request<any>('/api/status'); }
  authProviders() { return this.request<{providers?: AuthProviderInfo[]}>('/api/auth/providers'); }
  authMe() { return this.request<any>('/api/auth/me'); }
  passwordLogin(provider: string, username: string, password: string) {
    return this.request<any>('/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ provider, username, password })
    });
  }
  wsTicket() { return this.request<{ticket: string}>('/api/auth/ws-ticket', { method: 'POST' }); }

  systemStats() { return this.request<any>('/api/system/stats'); }
  sessions(limit = 50) { return this.request<{sessions?: SessionSummary[]} | SessionSummary[]>(`/api/sessions?limit=${limit}&offset=0&archived=exclude&order=recent`); }
  sessionMessages(id: string) { return this.request<any>(`/api/sessions/${encodeURIComponent(id)}/messages`); }
  renameSession(id: string, title: string) { return this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }); }
  deleteSession(id: string) { return this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  modelInfo() { return this.request<any>('/api/model/info'); }
  modelOptions() { return this.request<any>('/api/model/options'); }
  setModel(provider: string, model: string) { return this.request('/api/model/set', { method: 'POST', body: JSON.stringify({ scope: 'main', provider, model }) }); }
  skills() { return this.request<SkillInfo[]>('/api/skills'); }
  toggleSkill(name: string, enabled: boolean) { return this.request('/api/skills/toggle', { method: 'PUT', body: JSON.stringify({ name, enabled }) }); }
  toolsets() { return this.request<ToolsetInfo[]>('/api/tools/toolsets'); }
  toggleToolset(name: string, enabled: boolean) { return this.request(`/api/tools/toolsets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ enabled }) }); }
  toolsetConfig(name: string) { return this.request<any>(`/api/tools/toolsets/${encodeURIComponent(name)}/config`); }
  cronJobs() { return this.request<CronJob[]>('/api/cron/jobs'); }
  createCronJob(body: any) { return this.request<CronJob>('/api/cron/jobs', { method: 'POST', body: JSON.stringify(body) }); }
  pauseCronJob(id: string) { return this.request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' }); }
  resumeCronJob(id: string) { return this.request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }); }
  triggerCronJob(id: string) { return this.request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger`, { method: 'POST' }); }
  deleteCronJob(id: string) { return this.request(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  mcpServers() { return this.request<McpServer[]>('/api/mcp/servers'); }
  mcpCatalog() { return this.request<any>('/api/mcp/catalog'); }
  installMcp(body: any) { return this.request('/api/mcp/catalog/install', { method: 'POST', body: JSON.stringify(body) }); }
  setMcpEnabled(name: string, enabled: boolean) { return this.request(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }); }
  profiles() { return this.request<any>('/api/profiles'); }
  logs(lines = 100) { return this.request<any>(`/api/logs?lines=${lines}`); }
  analytics(days = 7) { return this.request<any>(`/api/analytics/usage?days=${days}`); }
}

export async function probeGateway(baseUrl: string): Promise<GatewayProbe> {
  const clean = normalizeBaseUrl(baseUrl);
  const publicClient = new HermesRestClient({ id: 'probe', name: 'Probe', baseUrl: clean, token: '', createdAt: 0, lastUsedAt: 0 });
  const status = await publicClient.status();
  const authRequired = Boolean(status?.auth_required);
  let providers: AuthProviderInfo[] = [];
  if (authRequired) {
    try { providers = (await publicClient.authProviders()).providers || []; } catch { providers = []; }
  }
  let injectedToken = '';
  if (!authRequired) {
    const res = await fetch(`${clean}/`, { credentials: 'include' });
    const html = await res.text();
    injectedToken = extractInjectedSessionToken(html);
  }
  return { baseUrl: clean, status, authRequired, providers, injectedToken };
}

export async function prepareConnectionProfile(profile: ConnectionProfile): Promise<{ profile: ConnectionProfile; status: any; message: string }> {
  const probe = await probeGateway(profile.baseUrl);

  if (!probe.authRequired) {
    const token = profile.token || probe.injectedToken;
    if (!token) throw new Error('Dashboard is reachable but did not expose a session token. Make sure it is running in mobile-compatible local mode.');
    return {
      profile: { ...profile, baseUrl: probe.baseUrl, token, authMode: 'token', wsTicket: undefined },
      status: probe.status,
      message: profile.token ? 'Connected with saved session token.' : 'Auto-discovered dashboard session token from Hermes.'
    };
  }

  const passwordProvider = probe.providers.find(p => p.supports_password);
  const client = new HermesRestClient({ ...profile, baseUrl: probe.baseUrl, token: '' });
  if (passwordProvider && profile.username && profile.password) {
    await client.passwordLogin(passwordProvider.name, profile.username, profile.password);
  } else {
    try {
      await client.authMe();
    } catch {
      const providerList = probe.providers.map(p => p.display_name || p.name).join(', ') || 'no providers reported';
      if (passwordProvider) {
        throw new Error(`This dashboard requires login. Enter username/password for ${passwordProvider.display_name || passwordProvider.name}, then connect again.`);
      }
      throw new Error(`This dashboard requires browser OAuth (${providerList}). Native OAuth handoff is not implemented yet; use username/password auth or Tailnet Quick Connect.`);
    }
  }

  const ticket = await client.wsTicket();
  if (!ticket.ticket) throw new Error('Dashboard login worked, but /api/auth/ws-ticket did not return a ticket.');
  return {
    profile: { ...profile, baseUrl: probe.baseUrl, token: '', authMode: 'password', wsTicket: ticket.ticket },
    status: probe.status,
    message: 'Signed into protected dashboard and minted WebSocket ticket.'
  };
}

export class HermesRpcClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v:any)=>void; reject:(e:any)=>void; timer:any }>();
  private handlers = new Set<RpcHandler>();

  constructor(private profile: ConnectionProfile) {}

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  onEvent(handler: RpcHandler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }

  connect(): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(buildWsUrlForProfile(this.profile));
      this.ws = ws;
      const failTimer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 10000);
      ws.onopen = () => { clearTimeout(failTimer); resolve(); };
      ws.onerror = () => { clearTimeout(failTimer); reject(new Error('Could not connect to /api/ws. Ensure Hermes is running with --tui and that auth is valid.')); };
      ws.onmessage = event => this.handleMessage(String(event.data));
      ws.onclose = () => {
        for (const [id, req] of this.pending) { clearTimeout(req.timer); req.reject(new Error('Hermes WebSocket closed')); this.pending.delete(id); }
      };
    });
  }

  private handleMessage(raw: string) {
    for (const line of raw.split('\n').filter(Boolean)) {
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && this.pending.has(String(msg.id))) {
        const req = this.pending.get(String(msg.id))!;
        clearTimeout(req.timer);
        this.pending.delete(String(msg.id));
        if (msg.error) req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else req.resolve(msg.result);
        continue;
      }
      if (msg.method === 'event') {
        for (const h of this.handlers) h({ ...msg.params, receivedAt: Date.now() });
      } else if (msg.method === 'gateway.ready') {
        for (const h of this.handlers) h({ type: 'gateway.ready', payload: msg.params, receivedAt: Date.now() });
      }
    }
  }

  request<T=any>(method: string, params: Record<string, any> = {}, timeoutMs = 45000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Hermes WebSocket is not connected');
    const id = String(this.nextId++);
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(payload + '\n');
    });
  }

  createSession(cols = 80) { return this.request('session.create', { cols }); }
  resumeSession(session_id: string) { return this.request('session.resume', { session_id }); }
  sessionList(limit = 50) { return this.request('session.list', { limit }); }
  sessionHistory(session_id: string) { return this.request('session.history', { session_id }); }
  submitPrompt(session_id: string, text: string) { return this.request('prompt.submit', { session_id, text }); }
  interrupt(session_id: string) { return this.request('session.interrupt', { session_id }); }
  approval(session_id: string, choice: 'approve' | 'deny', all = false) { return this.request('approval.respond', { session_id, choice, all }); }
  clarify(request_id: string, answer: string) { return this.request('clarify.respond', { request_id, answer }); }
  close() { this.ws?.close(); this.ws = undefined; }
}
