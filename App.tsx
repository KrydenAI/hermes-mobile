import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { HermesRestClient, HermesRpcClient, normalizeBaseUrl, prepareConnectionProfile } from './src/api/hermes';
import { deleteProfile, loadProfiles, upsertProfile } from './src/storage';
import { colors, radius, shadow } from './src/theme';
import type { ConnectionProfile, CronJob, HermesEvent, McpCatalogEntry, McpServer, SessionSummary, SkillInfo, ToolsetInfo } from './src/types';

type Tab = 'home' | 'chat' | 'approvals' | 'artifacts' | 'ops' | 'settings';
type OpsScreen = 'hub' | 'skills' | 'mcp' | 'cron';
type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
type ToolStatus = 'running' | 'done' | 'error';
type NonTextPart = { kind: 'tool' | 'skill' | 'thought'; name: string; status: ToolStatus; summary: string; detail?: string };
type MessagePart =
  | { kind: 'text'; text: string }
  | NonTextPart;
type Message = { id: string; role: MessageRole; text: string; at: number; parts?: MessagePart[] };
type ArtifactKind = 'image' | 'file' | 'link';
type ArtifactItem = { session: string; kind: ArtifactKind; label: string; value: string; href: string; canOpen: boolean };
type Status = 'idle' | 'testing' | 'connected' | 'error';

const tabs: { id: Exclude<Tab, 'home'>; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline' },
  { id: 'approvals', label: 'Needs Me', icon: 'hand-left-outline' },
  { id: 'artifacts', label: 'Artifacts', icon: 'sparkles-outline' },
  { id: 'ops', label: 'Ops', icon: 'grid-outline' },
  { id: 'settings', label: 'Settings', icon: 'settings-outline' }
];

function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function sessionId(s: SessionSummary): string { return String(s.session_id || s.id || s.stored_session_id || ''); }
function titleOf(s: SessionSummary): string { return safeText(s.title || s.name || sessionId(s).slice(0, 8) || 'Untitled'); }
function shortId(id: string) { return id ? id.slice(0, 10) : 'new'; }
function sessionTime(s: SessionSummary): number {
  const raw = safeText(s.updated_at || s.created_at || (s as any).last_message_at || (s as any).last_updated || (s as any).timestamp);
  const parsed = raw ? Date.parse(raw) : 0;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const compactDate = `${sessionId(s)} ${titleOf(s)}`.match(/(20\d{2})(\d{2})(\d{2})(?:[_-](\d+))?/);
  if (compactDate) return Date.parse(`${compactDate[1]}-${compactDate[2]}-${compactDate[3]}T00:00:00Z`) + Number(compactDate[4] || 0);
  return 0;
}
function sessionMessageCount(s: SessionSummary): number { return Number(s.message_count ?? (s as any).messages_count ?? 0) || 0; }
function isEmptySession(s: SessionSummary): boolean { return sessionMessageCount(s) <= 0; }
function isCronSession(s: SessionSummary): boolean {
  const haystack = `${titleOf(s)} ${sessionId(s)} ${safeText(s.source)}`.toLowerCase();
  return /(^|\s|_)cron[_\s-]/.test(haystack) || haystack.includes(' cron_') || haystack.startsWith('cron_') || safeText(s.source).toLowerCase() === 'cron';
}
function isInternalAutomationSession(s: SessionSummary): boolean {
  const source = safeText(s.source).toLowerCase();
  const title = safeText(s.title || s.name).trim();
  const id = sessionId(s).toLowerCase();
  if (isEmptySession(s)) return true;
  if ((source === 'cli' || source === 'system') && !title) return true;
  if (/slack[-_\s]*(coordination|gate|classifier)/i.test(`${title} ${id}`)) return true;
  return false;
}
function isUserFacingSession(s: SessionSummary): boolean { return !isInternalAutomationSession(s); }

function safeText(value: any, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(v => safeText(v)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    for (const key of ['display', 'text', 'content', 'message', 'delta', 'summary', 'name', 'id']) {
      const candidate = value[key];
      if (candidate != null && candidate !== value) {
        const rendered = safeText(candidate);
        if (rendered) return rendered;
      }
    }
    try { return JSON.stringify(value, null, 2); } catch { return fallback; }
  }
  return String(value);
}

const SESSION_PAGE_SIZE = 50;
const ARTIFACT_SESSION_PAGE_SIZE = 20;
const DRAWER_MIN_VISIBLE_SESSIONS = 14;

function isNearScrollEnd(event: any): boolean {
  const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
  return layoutMeasurement.height + contentOffset.y >= contentSize.height - 160;
}

function appendUniqueSessions(existing: SessionSummary[], incoming: SessionSummary[]): SessionSummary[] {
  const seen = new Set(existing.map(sessionId).filter(Boolean));
  const next = [...existing];
  for (const s of incoming) {
    const id = sessionId(s);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(s);
  }
  return next;
}

function visibleSessionCount(rows: SessionSummary[], mode: 'chats' | 'cron'): number {
  return rows.filter(s => {
    if (!isUserFacingSession(s)) return false;
    return mode === 'cron' ? isCronSession(s) : !isCronSession(s);
  }).length;
}

function compactJson(value: any, max = 140): string {
  const text = safeText(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolKind(name: string): 'tool' | 'skill' {
  return /^skill_|^skills?|skill_view|skill_manage|skills_list/i.test(name) ? 'skill' : 'tool';
}

function toolTitle(name: string) {
  return name.replace(/^functions\./, '').replace(/_/g, ' ');
}

function toolSummary(name: string, args: any, result: any): string {
  if (name === 'terminal') return compactJson(args?.command || result?.command || 'shell command');
  if (name === 'read_file') return compactJson(args?.path || 'read file');
  if (name === 'write_file') return compactJson(args?.path || 'write file');
  if (name === 'patch') return compactJson(args?.path || args?.mode || 'patch');
  if (name === 'web_search') return compactJson(args?.query || 'web search');
  if (name === 'web_extract') return compactJson(args?.urls || 'web extract');
  if (name === 'skill_view') return compactJson(args?.name || 'load skill');
  if (name === 'skill_manage') return compactJson(`${args?.action || 'update'} ${args?.name || 'skill'}`);
  if (name === 'todo') return 'Update task list';
  return compactJson(args) || compactJson(result) || 'Running';
}

function parseMessageParts(content: any, role: MessageRole): MessagePart[] {
  const parts: MessagePart[] = [];
  const pushText = (value: any) => {
    const text = safeText(value).trim();
    if (text) parts.push({ kind: 'text', text });
  };

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') { pushText(part); continue; }
      const type = safeText(part.type).toLowerCase();
      const name = safeText(part.toolName || part.tool_name || part.name || part.function?.name || part.recipient_name);
      if (type.includes('tool') || name) {
        const status: ToolStatus = part.isError || part.error ? 'error' : part.result === undefined ? 'running' : 'done';
        const resultPreview = status === 'error' ? safeText(part.error || part.result).slice(0, 700) : undefined;
        parts.push({ kind: toolKind(name), name: name || 'tool call', status, summary: toolSummary(name, part.args || part.input || part.function?.arguments, part.result), detail: resultPreview });
        continue;
      }
      pushText(part.text ?? part.content ?? part.message ?? part.delta ?? part);
    }
    return parts;
  }

  if (role === 'tool' && content && typeof content === 'object') {
    const name = safeText(content.toolName || content.name || content.tool_name || 'tool result');
    parts.push({ kind: toolKind(name), name, status: content.error ? 'error' : 'done', summary: toolSummary(name, content.args, content.result || content), detail: content.error ? safeText(content.error) : undefined });
    return parts;
  }

  if (role === 'tool') {
    const text = safeText(content).trim();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    const name = safeText(parsed?.toolName || parsed?.tool_name || parsed?.name || parsed?.recipient_name || 'tool result');
    parts.push({ kind: toolKind(name), name, status: parsed?.error ? 'error' : 'done', summary: toolSummary(name, parsed?.args || parsed?.input, parsed || text), detail: parsed?.error ? safeText(parsed.error).slice(0, 700) : undefined });
    return parts;
  }

  pushText(content);
  return parts;
}

function isInternalContextBlob(text: string): boolean {
  const normalized = text.trim().replace(/^\uFEFF/, '');
  return /^\[CONTEXT COMPACTION\s+[—-]\s+REFERENCE ONLY\]/i.test(normalized)
    || /^Earlier turns were compacted into the summary below\./i.test(normalized)
    || /^--- END OF CONTEXT SUMMARY/i.test(normalized)
    || /You are Hermes's live Slack coordination gate/i.test(normalized)
    || (/Return ONLY valid compact JSON/i.test(normalized) && /Allowed actions:\s*ignore,\s*store_context,\s*reply/i.test(normalized))
    || /^\{\s*"action"\s*:\s*"(?:ignore|store_context|reply|act_locally|create_task|escalate_to_coop)"\s*,\s*"should_reply"/i.test(normalized);
}

function isVisibleMessage(message: Message): boolean {
  const text = message.text || message.parts?.filter(p => p.kind === 'text').map(p => (p as any).text).join('\n') || '';
  if (isInternalContextBlob(text)) return false;
  return !!(text.trim() || message.parts?.some(p => p.kind !== 'text'));
}

function messageFromRaw(raw: any, index: number): Message {
  const role = (['user', 'assistant', 'system', 'tool'].includes(raw?.role) ? raw.role : 'system') as MessageRole;
  const content = raw?.content ?? raw?.text ?? raw?.message ?? raw;
  const parts = parseMessageParts(content, role);
  const text = parts.filter(p => p.kind === 'text').map(p => (p as any).text).join('\n');
  return { id: String(raw?.id || `${index}-${makeId()}`), role, text, parts, at: raw?.created_at ? Date.parse(raw.created_at) || Date.now() : Date.now() };
}

function normalizeMessages(data: any): Message[] {
  const rows = Array.isArray(data) ? data : data?.messages || [];
  return rows.map((m: any, i: number) => messageFromRaw(m, i)).filter(isVisibleMessage);
}

function nonTextParts(message: Message): NonTextPart[] {
  const parts = message.parts?.length ? message.parts : parseMessageParts(message.text, message.role);
  return parts.filter(p => p.kind !== 'text') as NonTextPart[];
}

function isToolOnlyMessage(message: Message): boolean {
  const parts = message.parts?.length ? message.parts : parseMessageParts(message.text, message.role);
  const text = parts.filter(p => p.kind === 'text').map(p => (p as any).text).join('').trim();
  return !!parts.length && !text && parts.some(p => p.kind !== 'text');
}

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [opsScreen, setOpsScreen] = useState<OpsScreen>('hub');
  const [status, setStatus] = useState<Status>('idle');
  const [statusPayload, setStatusPayload] = useState<any>(null);
  const [error, setError] = useState('');
  const [events, setEvents] = useState<HermesEvent[]>([]);
  const [activeSession, setActiveSession] = useState('');
  const [activeRuntimeSession, setActiveRuntimeSession] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const rpcRef = useRef<HermesRpcClient | null>(null);

  const rest = useMemo(() => profile ? new HermesRestClient(profile) : null, [profile]);

  useEffect(() => {
    loadProfiles().then(p => { setProfiles(p); if (p[0]) setProfile(p[0]); }).catch(() => undefined);
    return () => rpcRef.current?.close();
  }, []);

  const connect = useCallback(async (target = profile) => {
    if (!target) return;
    setStatus('testing'); setError('');
    try {
      const prepared = await prepareConnectionProfile(target);
      const runtimeProfile = prepared.profile;
      setStatusPayload({ ...prepared.status, mobile_message: prepared.message });
      rpcRef.current?.close();
      const rpc = new HermesRpcClient(runtimeProfile);
      rpc.onEvent((event: HermesEvent) => {
        setEvents(prev => [{ ...event, receivedAt: Date.now() }, ...prev].slice(0, 80));
        if (event.type === 'message.delta') {
          const text = safeText(event.payload);
          if (isInternalContextBlob(text)) return;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && !last.parts?.some(p => p.kind !== 'text')) return [...prev.slice(0, -1), { ...last, text: last.text + text, parts: [{ kind: 'text', text: last.text + text }] }];
            return [...prev, { id: makeId(), role: 'assistant', text, parts: [{ kind: 'text', text }], at: Date.now() }];
          });
        }
        if (event.type === 'message.complete') {
          const parts = parseMessageParts(event.payload?.message?.content || event.payload?.content || event.payload?.message || event.payload, 'assistant');
          const text = parts.filter(p => p.kind === 'text').map(p => (p as any).text).join('\n');
          const completed: Message = { id: makeId(), role: 'assistant', text, parts, at: Date.now() };
          if (!isVisibleMessage(completed)) return;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && !last.parts?.some(p => p.kind !== 'text')) return [...prev.slice(0, -1), completed];
            if (prev.some(m => m.role === 'assistant' && m.text.trim() === text.trim())) return prev;
            return [...prev, completed];
          });
        }
        if (event.type === 'status.update') {
          const kind = safeText(event.payload?.kind);
          const text = safeText(event.payload?.text);
          if (/tool|skill/i.test(kind) && text) {
            const name = text.split(/\s+/)[0] || kind;
            const part: NonTextPart = { kind: toolKind(name), name, status: 'running', summary: text };
            const nextMessage: Message = { id: makeId(), role: 'tool', text: '', parts: [part], at: Date.now() };
            setMessages(prev => [...prev, nextMessage].slice(-120));
          } else if (text) {
            const part: NonTextPart = { kind: 'thought', name: 'thought', status: 'running', summary: text };
            const nextMessage: Message = { id: makeId(), role: 'system', text: '', parts: [part], at: Date.now() };
            setMessages(prev => [...prev, nextMessage].slice(-120));
          }
        }
      });
      await rpc.connect();
      rpcRef.current = rpc;
      setStatus('connected');
      const updated = { ...runtimeProfile, wsTicket: undefined, lastUsedAt: Date.now() };
      setProfile(updated);
      setProfiles(await upsertProfile(updated));
      setTab('chat');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setStatus('error'); setError(e?.message || String(e));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    }
  }, [profile]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <LinearGradient colors={[colors.bg, '#070b18', colors.bg]} style={StyleSheet.absoluteFill} />
        <View style={styles.root}>
          {tab !== 'home' ? <Header profile={profile} status={status} active={tab} opsScreen={opsScreen} onStatusPress={() => setTab('settings')} onBack={tab === 'ops' && opsScreen !== 'hub' ? () => setOpsScreen('hub') : undefined} /> : null}
          <View style={styles.body}>
            {tab === 'home' && <ConnectScreen profiles={profiles} active={profile} status={status} error={error} statusPayload={statusPayload} onSelect={setProfile} onSave={async (p: ConnectionProfile) => { setProfile(p); setProfiles(await upsertProfile(p)); await connect(p); }} onDelete={async (id: string) => { setProfiles(await deleteProfile(id)); if (profile?.id === id) setProfile(null); }} />}
            {tab === 'chat' && <ChatScreen rest={rest} rpc={rpcRef.current} connected={status === 'connected'} activeSession={activeSession} setActiveSession={setActiveSession} activeRuntimeSession={activeRuntimeSession} setActiveRuntimeSession={setActiveRuntimeSession} messages={messages} setMessages={setMessages} />}
            {tab === 'approvals' && <ApprovalsScreen rpc={rpcRef.current} events={events} activeSession={activeSession} />}
            {tab === 'artifacts' && <ArtifactsScreen rest={rest} />}
            {tab === 'ops' && opsScreen === 'hub' && <OpsHubScreen setOpsScreen={setOpsScreen} />}
            {tab === 'ops' && opsScreen === 'skills' && <SkillsScreen rest={rest} />}
            {tab === 'ops' && opsScreen === 'mcp' && <McpScreen rest={rest} />}
            {tab === 'ops' && opsScreen === 'cron' && <CronScreen rest={rest} />}
            {tab === 'settings' && <SettingsScreen rest={rest} profile={profile} statusPayload={statusPayload} />}
          </View>
          {status === 'connected' ? <TabBar active={tab === 'home' ? 'chat' : tab} setActive={(next) => { setTab(next); if (next !== 'ops') setOpsScreen('hub'); }} /> : null}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Header({ profile, status, active, opsScreen, onStatusPress, onBack }: { profile: ConnectionProfile | null; status: Status; active: Tab; opsScreen: OpsScreen; onStatusPress: () => void; onBack?: () => void }) {
  const title = active === 'approvals' ? 'Needs Me' : active === 'ops' ? (opsScreen === 'hub' ? 'Ops' : opsScreen === 'mcp' ? 'MCP Servers' : opsScreen === 'cron' ? 'Cron' : 'Skills') : active === 'artifacts' ? 'Artifacts' : active === 'settings' ? 'Settings' : 'Hermes';
  const subtitle = active === 'ops' && opsScreen === 'hub' ? 'Operate and extend Hermes.' : active === 'settings' ? 'Connection, profiles, auth, system.' : undefined;
  return <View style={styles.headerCompact}>
    <View style={styles.rowCenter}>
      {onBack ? <Pressable onPress={onBack} style={styles.headerBack}><Ionicons name="chevron-back" size={22} color={colors.text} /></Pressable> : null}
      <View><Text style={styles.headerTitle}>{title}</Text>{subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}</View>
    </View>
    <Pressable onPress={onStatusPress} style={[styles.pill, status === 'connected' ? styles.pillGood : status === 'error' ? styles.pillBad : null]}>
      <View style={[styles.dot, status === 'connected' ? { backgroundColor: colors.good } : status === 'error' ? { backgroundColor: colors.bad } : { backgroundColor: colors.warn }]} />
      <Text style={styles.pillText}>{profile ? 'Hermes' : 'Connect'}</Text>
    </Pressable>
  </View>;
}

function TabBar({ active, setActive }: { active: Exclude<Tab, 'home'>; setActive: (t: Exclude<Tab, 'home'>) => void }) {
  return <View style={styles.tabs}>
    {tabs.map(t => <Pressable key={t.id} onPress={() => setActive(t.id)} style={[styles.tab, active === t.id && styles.tabActive]}>
      <Ionicons name={t.icon} size={20} color={active === t.id ? colors.text : colors.muted} />
      <Text style={[styles.tabText, active === t.id && { color: colors.text }]} numberOfLines={1}>{t.label}</Text>
    </Pressable>)}
  </View>;
}

function ConnectScreen({ profiles, active, status, error, statusPayload, onSelect, onSave, onDelete }: any) {
  const [name, setName] = useState(active?.name || 'My Hermes');
  const [baseUrl, setBaseUrl] = useState(active?.baseUrl || 'http://100.x.y.z:9119');
  const [token, setToken] = useState(active?.token || '');
  const [username, setUsername] = useState(active?.username || '');
  const [password, setPassword] = useState(active?.password || '');
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { if (active) { setName(active.name); setBaseUrl(active.baseUrl); setToken(active.token || ''); setUsername(active.username || ''); setPassword(active.password || ''); } }, [active]);
  const save = () => onSave({ id: active?.id || makeId(), name: name.trim() || 'Hermes', baseUrl: normalizeBaseUrl(baseUrl), token: token.trim(), username: username.trim(), password, authMode: username.trim() || password ? 'password' : 'auto', createdAt: active?.createdAt || Date.now(), lastUsedAt: Date.now() });

  return <ScrollView contentContainerStyle={styles.onboardingScreen}>
    <View style={styles.hero}>
      <Text style={styles.eyebrow}>Hermes Mobile</Text>
      <Text style={styles.heroTitle}>Pocket cockpit</Text>
      <View style={styles.orbital}><View style={styles.orbitalRing} /><View style={[styles.orbitalRing, styles.orbitalRingTilt]} /><LinearGradient colors={[colors.primary2, colors.primary]} style={styles.orbitalCore}><Ionicons name="sparkles" size={30} color={colors.text} /></LinearGradient></View>
      <Text style={styles.sectionTitle}>Connect to your Hermes dashboard</Text>
      <Text style={styles.mutedCenter}>Paste your dashboard URL. Token discovery is automatic for Tailnet/LAN mode.</Text>
    </View>
    <Card>
      <Label text="Dashboard URL" /><Input value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" placeholder="http://100.74.248.8:9119" />
      <Button icon="flash-outline" text={status === 'testing' ? 'Connecting...' : 'Connect'} onPress={save} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusPayload ? <Text style={styles.success}>REST OK · {safeText(statusPayload.version || statusPayload.hermes_version || 'Hermes')}</Text> : null}
      <Pressable onPress={() => setAdvanced(v => !v)} style={styles.advancedLink}><Text style={styles.advancedText}>Advanced options</Text><Ionicons name={advanced ? 'chevron-up' : 'chevron-down'} size={16} color={colors.primary2} /></Pressable>
      {advanced ? <View style={styles.advancedPanel}>
        <Label text="Profile name" /><Input value={name} onChangeText={setName} placeholder="My Hermes" />
        <Label text="Session token (optional)" /><Input value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry placeholder="Usually auto-discovered" />
        <Label text="Internal login username (optional)" /><Input value={username} onChangeText={setUsername} autoCapitalize="none" placeholder="Only if dashboard advertises password login" />
        <Label text="Internal login password (optional)" /><Input value={password} onChangeText={setPassword} secureTextEntry placeholder="Only if dashboard advertises password login" />
      </View> : null}
    </Card>
    {profiles.length ? <Card><Text style={styles.sectionTitle}>Saved backends</Text>{profiles.map((p: ConnectionProfile) => <Pressable key={p.id} style={styles.listItem} onPress={() => onSelect(p)}><View style={{ flex: 1 }}><Text style={styles.listTitle}>{p.name}</Text><Text style={styles.listSub} numberOfLines={1}>{p.baseUrl} · {p.authMode || 'auto'}</Text></View><Pressable onPress={() => onDelete(p.id)} style={styles.compactIcon}><Ionicons name="trash-outline" size={17} color={colors.bad} /></Pressable></Pressable>)}</Card> : null}
  </ScrollView>;
}

function ChatScreen({ rest, rpc, connected, activeSession, setActiveSession, activeRuntimeSession, setActiveRuntimeSession, messages, setMessages }: any) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<'chats' | 'cron'>('chats');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionsHasMore, setSessionsHasMore] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [err, setErr] = useState('');
  const visibleMessages = messages.filter(isVisibleMessage);
  const renderMessages = () => {
    const nodes: React.ReactNode[] = [];
    let pendingCalls: NonTextPart[] = [];
    const flush = (key: string) => {
      if (!pendingCalls.length) return;
      nodes.push(<ActivitySummaryLine key={`calls-${key}`} parts={pendingCalls} />);
      pendingCalls = [];
    };
    visibleMessages.forEach((message: Message, index: number) => {
      if (isToolOnlyMessage(message)) {
        pendingCalls.push(...nonTextParts(message));
        return;
      }
      flush(message.id || String(index));
      nodes.push(<MessageBubble key={message.id} message={message} />);
    });
    flush('tail');
    return nodes;
  };
  const storedIdFromRpc = (r: any) => safeText(r?.stored_session_id || r?.session_key || r?.resumed || r?.id || r?.session_id);
  const runtimeIdFromRpc = (r: any) => safeText(r?.session_id || r?.runtime_session_id || r?.id);
  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a)), [sessions]);
  const drawerSessions = sortedSessions.filter(s => {
    if (!isUserFacingSession(s)) return false;
    if (drawerMode === 'cron') return isCronSession(s);
    return !isCronSession(s);
  });

  const loadSessions = async (reset = false, minVisible = 0, mode: 'chats' | 'cron' = drawerMode) => {
    if (!rest) return;
    let offset = reset ? 0 : sessionOffset;
    if (!reset && (!sessionsHasMore || loadingSessions || loadingMoreSessions)) return;
    reset ? setLoadingSessions(true) : setLoadingMoreSessions(true);
    try {
      let merged = reset ? [] : sessions;
      let hasMore = reset ? true : sessionsHasMore;
      for (let page = 0; page < 8 && hasMore; page += 1) {
        const data = await rest.sessions(SESSION_PAGE_SIZE, offset, 'include');
        const batch = Array.isArray(data) ? data : data.sessions || [];
        const total = Array.isArray(data) ? undefined : data.total;
        merged = appendUniqueSessions(merged, batch);
        offset += batch.length;
        hasMore = batch.length === SESSION_PAGE_SIZE && (typeof total !== 'number' || offset < total);
        if (!minVisible || visibleSessionCount(merged, mode) >= minVisible) break;
      }
      setSessions(merged);
      setSessionOffset(offset);
      setSessionsHasMore(hasMore);
    } finally {
      reset ? setLoadingSessions(false) : setLoadingMoreSessions(false);
    }
  };
  const refresh = async () => loadSessions(true, DRAWER_MIN_VISIBLE_SESSIONS, 'chats');
  useEffect(() => { refresh().catch(e => setErr(e.message)); }, [rest]);

  const openSession = async (sid: string) => {
    setActiveSession(sid);
    setActiveRuntimeSession('');
    setDrawerOpen(false);
    setLoadingMessages(true); setErr('');
    try {
      if (rpc) {
        const resumed: any = await rpc.resumeSession(sid);
        const stored = storedIdFromRpc(resumed) || sid;
        setActiveSession(stored);
        setActiveRuntimeSession(runtimeIdFromRpc(resumed));
        setMessages(normalizeMessages(resumed?.messages || []));
      } else if (rest) {
        const data = await rest.sessionMessages(sid);
        setMessages(normalizeMessages(data));
      }
    } catch (e: any) {
      try {
        if (rest) {
          const data = await rest.sessionMessages(sid);
          setMessages(normalizeMessages(data));
        }
        setErr('');
      } catch { setErr(e.message); setMessages([]); }
    }
    finally { setLoadingMessages(false); }
  };

  const newSession = async () => {
    if (!rpc) return;
    const r: any = await rpc.createSession();
    const stored = storedIdFromRpc(r);
    const runtime = runtimeIdFromRpc(r);
    setActiveSession(stored || runtime);
    setActiveRuntimeSession(runtime);
    setMessages([]); setDrawerOpen(false); await refresh();
  };

  const submit = async () => {
    if (!rpc || !prompt.trim()) return;
    let storedSid = activeSession;
    let runtimeSid = activeRuntimeSession;
    setBusy(true); setErr('');
    try {
      if (!runtimeSid) {
        const r: any = storedSid ? await rpc.resumeSession(storedSid) : await rpc.createSession();
        runtimeSid = runtimeIdFromRpc(r);
        storedSid = storedIdFromRpc(r) || storedSid || runtimeSid;
        setActiveRuntimeSession(runtimeSid);
        setActiveSession(storedSid);
        if (r?.messages) setMessages(normalizeMessages(r.messages));
      }
      const text = prompt.trim();
      setMessages((m: Message[]) => [...m, { id: makeId(), role: 'user', text, parts: [{ kind: 'text', text }], at: Date.now() }]);
      setPrompt('');
      await rpc.submitPrompt(runtimeSid, text);
      await refresh();
    } catch(e:any){ setErr(e.message); }
    finally { setBusy(false); }
  };

  return <View style={styles.chatRoot}>
    <View style={styles.chatTopBar}>
      <Pressable onPress={() => { setDrawerMode('chats'); setDrawerOpen(true); loadSessions(false, DRAWER_MIN_VISIBLE_SESSIONS, 'chats').catch(e => setErr(e.message)); }} style={styles.iconButton}><Ionicons name="menu-outline" size={24} color={colors.text} /></Pressable>
      <View style={{ flex: 1 }}><Text style={styles.chatTitle}>{activeSession ? titleOf(sessions.find(s => sessionId(s) === activeSession) || ({ title: shortId(activeSession) } as any)) : 'New chat'}</Text><Text style={styles.chatSub}>{connected ? 'Live Hermes session' : 'Connect backend first'}</Text></View>
      <Pressable onPress={newSession} disabled={!connected} style={styles.iconButton}><Ionicons name="add-outline" size={24} color={connected ? colors.text : colors.faint} /></Pressable>
    </View>
    {err ? <Text style={styles.errorInline}>{err}</Text> : null}
    <ScrollView contentContainerStyle={styles.chatMessages}>
      {loadingMessages ? <LoadingBlock label="Loading chat…" /> : visibleMessages.length ? renderMessages() : <View style={styles.centerPane}><Ionicons name="sparkles-outline" size={32} color={colors.primary2} /><Text style={styles.sectionTitle}>How can Hermes help?</Text><Text style={styles.mutedCenter}>Start typing, or open the menu to choose a previous session.</Text></View>}
      {busy ? <ToolCallCard part={{ kind: 'tool', name: 'Hermes', status: 'running', summary: 'Thinking' }} /> : null}
    </ScrollView>
    <View style={styles.composer}><TextInput value={prompt} onChangeText={setPrompt} placeholder="Message Hermes…" placeholderTextColor={colors.faint} style={styles.composerInput} multiline /><Pressable onPress={submit} disabled={busy || !connected} style={[styles.send, (!connected || busy) && { opacity: 0.45 }]}><Ionicons name="send" color={colors.text} size={20}/></Pressable></View>
    <Modal visible={drawerOpen} transparent animationType="fade" onRequestClose={() => setDrawerOpen(false)}>
      <Pressable style={styles.drawerScrim} onPress={() => setDrawerOpen(false)} />
      <View style={styles.drawer}>
        <View style={styles.rowBetween}><Text style={styles.sectionTitle}>Chats</Text><Pressable onPress={() => setDrawerOpen(false)} style={styles.iconButton}><Ionicons name="close-outline" size={24} color={colors.text} /></Pressable></View>
        <Button text="New chat" icon="add-outline" onPress={newSession} />
        <View style={styles.drawerFilterRow}>
          <Pressable onPress={() => { setDrawerMode('chats'); loadSessions(false, DRAWER_MIN_VISIBLE_SESSIONS, 'chats').catch(e => setErr(e.message)); }} style={[styles.drawerFilterPill, drawerMode === 'chats' && styles.drawerFilterPillActive]}><Text style={styles.drawerFilterText}>Chats</Text></Pressable>
          <Pressable onPress={() => { setDrawerMode('cron'); loadSessions(false, DRAWER_MIN_VISIBLE_SESSIONS, 'cron').catch(e => setErr(e.message)); }} style={[styles.drawerFilterPill, drawerMode === 'cron' && styles.drawerFilterPillActive]}><Text style={styles.drawerFilterText}>Cron</Text></Pressable>
        </View>
        {loadingSessions ? <LoadingBlock label="Loading sessions…" compact /> : <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 26 }} onScroll={(event) => { if (isNearScrollEnd(event)) loadSessions(false).catch(e => setErr(e.message)); }} scrollEventThrottle={240}>{drawerSessions.map(s => <Pressable key={sessionId(s)} style={[styles.drawerItem, activeSession === sessionId(s) && styles.selected]} onPress={() => openSession(sessionId(s))}><Text style={styles.listTitle} numberOfLines={1}>{titleOf(s)}</Text><Text style={styles.listSub}>{shortId(sessionId(s))} · {safeText(s.message_count ?? 0)} messages</Text></Pressable>)}{loadingMoreSessions ? <LoadingBlock label="Loading more…" compact /> : sessionsHasMore ? <Text style={styles.mutedCenter}>Scroll for more</Text> : null}</ScrollView>}
      </View>
    </Modal>
  </View>;
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const parts = message.parts?.length ? message.parts : parseMessageParts(message.text, message.role);
  const textParts = parts.filter(p => p.kind === 'text') as Extract<MessagePart, { kind: 'text' }>[];
  const toolParts = parts.filter(p => p.kind !== 'text') as NonTextPart[];
  if (!textParts.length && toolParts.length) return <ActivitySummaryLine parts={toolParts} />;
  return <View style={[styles.messageWrap, isUser && styles.messageWrapUser]}>
    {toolParts.length ? <ActivitySummaryLine parts={toolParts} /> : null}
    <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
      {!isUser ? <Text style={styles.bubbleRole}>{message.role}</Text> : null}
      {textParts.map((p, i) => <Text key={`t-${i}`} style={styles.text}>{p.text}</Text>)}
      {!textParts.length && !toolParts.length ? <Text style={styles.muted}>No visible content.</Text> : null}
    </View>
  </View>;
}

function ActivitySummaryLine({ parts }: { parts: NonTextPart[] }) {
  const tools = parts.filter(p => p.kind === 'tool').length;
  const skills = parts.filter(p => p.kind === 'skill').length;
  const thoughts = parts.filter(p => p.kind === 'thought').length;
  const errors = parts.filter(p => p.status === 'error').length;
  const names = Array.from(new Set(parts.filter(p => p.kind !== 'thought').map(p => toolTitle(p.name)).filter(Boolean))).slice(0, 3).join(', ');
  const bits = tools || skills ? [`${tools + skills} call${tools + skills === 1 ? '' : 's'} made`] : [];
  if (skills) bits.push(`${skills} skill${skills === 1 ? '' : 's'}`);
  if (tools) bits.push(`${tools} tool${tools === 1 ? '' : 's'}`);
  if (thoughts) bits.push(`${thoughts} thought update${thoughts === 1 ? '' : 's'}`);
  if (errors) bits.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return <Text style={styles.activityLine}>{bits.join(' · ')}{names ? ` · ${names}` : ''}</Text>;
}

function ToolCallCard({ part }: { part: NonTextPart }) {
  const isSkill = part.kind === 'skill';
  const color = part.status === 'error' ? colors.bad : isSkill ? colors.primary2 : colors.primary;
  const icon: keyof typeof Ionicons.glyphMap = isSkill ? 'library-outline' : part.status === 'error' ? 'warning-outline' : 'terminal-outline';
  return <View style={[styles.toolCard, isSkill && styles.skillCard, part.status === 'error' && styles.toolCardError]}>
    <View style={styles.toolGlyph}>{part.status === 'running' ? <ActivityIndicator size="small" color={color} /> : <Ionicons name={icon} size={17} color={color} />}</View>
    <View style={{ flex: 1 }}>
      <Text style={styles.toolTitle}>{isSkill ? 'Skill' : 'Tool'} · {toolTitle(part.name)}</Text>
      <Text style={styles.toolSub} numberOfLines={2}>{part.status === 'running' ? 'Running…' : part.status === 'error' ? 'Needs attention' : 'Completed'}{part.summary ? ` · ${part.summary}` : ''}</Text>
      {part.detail ? <Text style={styles.toolDetail}>{part.detail}</Text> : null}
    </View>
  </View>;
}

function ApprovalsScreen({ rpc, events, activeSession }: any) {
  const actionable = events.filter((e: HermesEvent) => ['approval.request','clarify.request','sudo.request','secret.request'].includes(e.type));
  const [answer, setAnswer] = useState('');
  return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>Needs me</Text><Text style={styles.muted}>Approval, clarify, sudo, and secret requests appear here in real time.</Text></Card>{actionable.length ? actionable.map((e: HermesEvent, i: number) => <Card key={`${e.receivedAt}-${i}`}><Text style={styles.eyebrow}>{e.type}</Text><Text style={styles.text}>{safeText(e.payload)}</Text>{e.type === 'approval.request' ? <View style={styles.row}><Button text="Approve" icon="checkmark-outline" onPress={() => rpc?.approval(e.session_id || activeSession, 'approve')} /><Button text="Deny" icon="close-outline" secondary onPress={() => rpc?.approval(e.session_id || activeSession, 'deny')} /></View> : <><Input value={answer} onChangeText={setAnswer} placeholder="Answer…" /><Button text="Send answer" icon="return-down-forward-outline" onPress={() => rpc?.clarify(e.payload?.request_id || e.payload?.id, answer)} /></>}</Card>) : <Empty title="Nothing needs you" body="Requests will appear here when Hermes needs a decision." />}</ScrollView>;
}

function ArtifactsScreen({ rest }: { rest: HermesRestClient | null }) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artifactOffset, setArtifactOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const seenRef = useRef(new Set<string>());
  const loadPage = async (reset = false) => {
    if (!rest) return;
    const offset = reset ? 0 : artifactOffset;
    if (!reset && (!hasMore || loading || loadingMore)) return;
    reset ? setLoading(true) : setLoadingMore(true);
    try {
      if (reset) {
        seenRef.current = new Set<string>();
        setItems([]);
      }
      const data = await rest.sessions(ARTIFACT_SESSION_PAGE_SIZE, offset, 'include');
      const sessions = Array.isArray(data) ? data : data.sessions || [];
      const total = Array.isArray(data) ? undefined : data.total;
      const out: ArtifactItem[] = [];
      for (const s of sessions) {
        if (!isUserFacingSession(s)) continue;
        try {
          const m = await rest.sessionMessages(sessionId(s));
          const messages = (m.messages || m || []).slice().reverse();
          for (const msg of messages) {
            for (const item of extractArtifactItems(msg, titleOf(s))) {
              const key = `${item.kind}:${item.value}`;
              if (seenRef.current.has(key)) continue;
              seenRef.current.add(key);
              out.push(item);
            }
          }
        } catch {}
      }
      setItems(prev => reset ? out : [...prev, ...out]);
      const nextOffset = offset + sessions.length;
      setArtifactOffset(nextOffset);
      setHasMore(sessions.length === ARTIFACT_SESSION_PAGE_SIZE && (typeof total !== 'number' || nextOffset < total));
    } finally {
      reset ? setLoading(false) : setLoadingMore(false);
    }
  };
  useEffect(()=>{ loadPage(true).catch(e=>setErr(e.message)); }, [rest]);
  return <ScrollView contentContainerStyle={styles.screen} onScroll={(event) => { if (isNearScrollEnd(event)) loadPage(false).catch(e=>setErr(e.message)); }} scrollEventThrottle={240}><Card><Text style={styles.sectionTitle}>Artifacts</Text>{err ? <Text style={styles.error}>{err}</Text> : null}</Card>{loading ? <LoadingBlock label="Loading artifacts…" /> : items.length ? items.map((it,i)=><ArtifactCard key={`${it.kind}-${it.value}-${i}`} item={it} />) : <Empty title="No artifacts found" body="Shared files, links, images, and MEDIA attachments will appear here." />}{loadingMore ? <LoadingBlock label="Loading more…" /> : hasMore && items.length ? <Text style={styles.mutedCenter}>Scroll for more</Text> : null}</ScrollView>;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
const PATH_RE = /(^|[\s("'`])((?:MEDIA:)?(?:\/|~\/|\.\.?\/)[^\s"'`<>]+(?:\.[a-z0-9]{1,8})?)/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?.*)?$/i;
const FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|txt|json|md|csv|zip|tar|gz|mp3|wav|mp4|mov)(?:\?.*)?$/i;

function normalizeArtifactValue(value: string): string { return value.trim().replace(/[),.;]+$/, ''); }
function looksLikePathOrUrl(value: string): boolean { return /^(?:https?:\/\/|file:\/\/|data:image\/|MEDIA:|\/|\.\.?\/|~\/)/i.test(value); }
function looksLikeArtifact(value: string): boolean { return /^(?:https?:\/\/|data:image\/)/i.test(value) || (looksLikePathOrUrl(value) && FILE_EXT_RE.test(value.replace(/^MEDIA:/, ''))); }
function artifactKind(value: string): ArtifactKind { return IMAGE_EXT_RE.test(value.replace(/^MEDIA:/, '')) || value.startsWith('data:image/') ? 'image' : /^(?:https?:\/\/)/i.test(value) ? 'link' : 'file'; }
function artifactHref(value: string): string {
  const clean = value.replace(/^MEDIA:/, '');
  if (/^(?:https?:\/\/|file:\/\/|data:)/i.test(clean)) return clean;
  if (clean.startsWith('/')) return `file://${encodeURI(clean)}`;
  return clean;
}
function artifactLabel(value: string): string {
  const clean = value.replace(/^MEDIA:/, '');
  try { const url = new URL(clean); return url.pathname.split('/').filter(Boolean).pop() || clean; }
  catch { return clean.split(/[\\/]/).filter(Boolean).pop() || clean; }
}
function canOpenArtifact(value: string): boolean { return /^(?:https?:\/\/|data:image\/)/i.test(value.replace(/^MEDIA:/, '')); }

function extractArtifactItems(raw: any, session: string): ArtifactItem[] {
  const role = safeText(raw?.role).toLowerCase();
  if (role === 'system') return [];
  const msg = messageFromRaw(raw, 0);
  if (!isVisibleMessage(msg)) return [];
  const text = msg.text || safeText(raw?.content ?? raw?.text ?? raw?.message ?? '');
  if (!text || isInternalContextBlob(text)) return [];
  const items: ArtifactItem[] = [];
  const add = (value: string) => {
    const clean = normalizeArtifactValue(value);
    if (!clean || !looksLikeArtifact(clean) || isInternalContextBlob(clean)) return;
    items.push({ session, kind: artifactKind(clean), label: artifactLabel(clean), value: clean, href: artifactHref(clean), canOpen: canOpenArtifact(clean) });
  };
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) add(match[2] || '');
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === '!') continue;
    add(match[2] || '');
  }
  for (const match of text.matchAll(URL_RE)) add(match[0] || '');
  for (const match of text.matchAll(/MEDIA:([^\s)]+)/g)) add(`MEDIA:${match[1]}`);
  for (const match of text.matchAll(PATH_RE)) add(match[2] || '');
  const directUrl = safeText(raw?.url || raw?.href || raw?.link);
  const directPath = safeText(raw?.path || raw?.file_path || raw?.filename);
  if (directUrl) add(directUrl);
  if (directPath) add(directPath);
  return items;
}

function ArtifactCard({ item }: { item: ArtifactItem }) {
  const icon: keyof typeof Ionicons.glyphMap = item.kind === 'image' ? 'image-outline' : item.kind === 'link' ? 'link-outline' : 'document-attach-outline';
  const open = async () => {
    if (item.canOpen) await Linking.openURL(item.href);
    else await Clipboard.setStringAsync(item.value);
  };
  return <Pressable onPress={open}><Card><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.eyebrow}>{item.kind}</Text><Text style={styles.listTitle} numberOfLines={1}>{item.label}</Text><Text style={styles.listSub} numberOfLines={1}>{item.session}</Text></View><Ionicons name={icon} size={24} color={colors.primary2} /></View><Text style={styles.muted} numberOfLines={2}>{item.value}</Text><View style={styles.row}><Button text={item.canOpen ? 'Open' : 'Copy path'} icon={item.canOpen ? 'open-outline' : 'copy-outline'} secondary onPress={open} /></View></Card></Pressable>;
}

function OpsHubScreen({ setOpsScreen }: { setOpsScreen: (screen: OpsScreen) => void }) {
  const rows: { id: OpsScreen; title: string; sub: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { id: 'skills', title: 'Skills', sub: 'Toolsets and reusable procedures', icon: 'library-outline' },
    { id: 'mcp', title: 'MCP Servers', sub: 'External tools and integrations', icon: 'git-network-outline' },
    { id: 'cron', title: 'Cron', sub: 'Scheduled autonomous jobs', icon: 'alarm-outline' }
  ];
  return <ScrollView contentContainerStyle={styles.screen}>
    {rows.map(row => <Pressable key={row.id} onPress={() => setOpsScreen(row.id)} style={styles.opsRow}>
      <View style={styles.opsIcon}><Ionicons name={row.icon} size={21} color={colors.primary2} /></View>
      <View style={{ flex: 1 }}><Text style={styles.listTitle}>{row.title}</Text><Text style={styles.listSub}>{row.sub}</Text></View>
      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
    </Pressable>)}
    <Card><Text style={styles.sectionTitle}>Recent activity</Text><Text style={styles.muted}>Live activity will appear here as Hermes reports ops events.</Text></Card>
  </ScrollView>;
}

function SkillsScreen({ rest }: { rest: HermesRestClient | null }) {
  const [skills,setSkills]=useState<SkillInfo[]>([]); const [tools,setTools]=useState<ToolsetInfo[]>([]); const [query,setQuery]=useState(''); const [err,setErr]=useState(''); const [loading,setLoading]=useState(false);
  const load=async()=>{ if(!rest)return; setLoading(true); try { const [s,t]=await Promise.all([rest.skills(), rest.toolsets()]); setSkills(Array.isArray(s)?s:[]); setTools(Array.isArray(t)?t:[]); } finally { setLoading(false); } };
  useEffect(()=>{ load().catch(e=>setErr(e.message)); },[rest]);
  const filtered=skills.filter(s=>`${s.name} ${s.description||''}`.toLowerCase().includes(query.toLowerCase()));
  return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>Skills + tools</Text><Input value={query} onChangeText={setQuery} placeholder="Search skills…" />{err?<Text style={styles.error}>{err}</Text>:null}</Card>{loading ? <LoadingBlock label="Loading skills…" /> : <><Card><Text style={styles.sectionTitle}>Toolsets</Text>{tools.map(t=><ToggleRow key={t.name} title={safeText(t.name)} sub={`${safeText(t.tools?.length||0)} tools · ${safeText(t.provider||'default')}`} on={!!t.enabled} onPress={async()=>{await rest?.toggleToolset(t.name,!t.enabled); await load();}} />)}</Card><Card><Text style={styles.sectionTitle}>Skills</Text>{filtered.map(s=><ToggleRow key={s.name} title={safeText(s.name)} sub={safeText(s.description||s.category||'')} on={!!s.enabled} onPress={async()=>{await rest?.toggleSkill(s.name,!s.enabled); await load();}} />)}</Card></>}</ScrollView>;
}

function McpScreen({ rest }: { rest: HermesRestClient | null }) {
  const [servers,setServers]=useState<McpServer[]>([]);
  const [catalog,setCatalog]=useState<McpCatalogEntry[]>([]);
  const [err,setErr]=useState('');
  const [notice,setNotice]=useState('');
  const [loading,setLoading]=useState(false);
  const [name,setName]=useState('');
  const [transport,setTransport]=useState<'http'|'stdio'>('http');
  const [url,setUrl]=useState('');
  const [command,setCommand]=useState('');
  const [args,setArgs]=useState('');
  const [env,setEnv]=useState('{}');
  const [auth,setAuth]=useState('');
  const [expanded,setExpanded]=useState('');
  const normalizeServers=(raw:any):McpServer[]=>Array.isArray(raw)?raw:(Array.isArray(raw?.servers)?raw.servers:[]);
  const normalizeCatalog=(raw:any):McpCatalogEntry[]=>Array.isArray(raw)?raw:(Array.isArray(raw?.entries)?raw.entries:Array.isArray(raw?.servers)?raw.servers:Array.isArray(raw?.items)?raw.items:[]);
  const load=async()=>{ if(!rest)return; setLoading(true); setErr(''); try { const [s,c]=await Promise.all([rest.mcpServers(), rest.mcpCatalog().catch(()=>({ entries: [] })) as any]); setServers(normalizeServers(s)); setCatalog(normalizeCatalog(c)); } catch(e:any) { setErr(e.message); } finally { setLoading(false); } };
  useEffect(()=>{ load().catch(e=>setErr(e.message));},[rest]);
  const create=async()=>{ if(!rest)return; setErr(''); setNotice(''); const serverName=name.trim(); if(!serverName){setErr('Server name is required.'); return;} let parsedEnv:Record<string,string>={}; try{ const raw=env.trim()?JSON.parse(env):{}; if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('Env must be a JSON object'); parsedEnv=raw; } catch(e:any){ setErr(`Invalid env JSON: ${e.message}`); return; } const body:any={ name: serverName }; if(transport==='http') body.url=url.trim(); else { body.command=command.trim(); body.args=args.split(/\s+/).map(a=>a.trim()).filter(Boolean); } if(auth.trim()) body.auth=auth.trim(); if(Object.keys(parsedEnv).length) body.env=parsedEnv; try{ await rest.createMcpServer(body); setName(''); setUrl(''); setCommand(''); setArgs(''); setAuth(''); setEnv('{}'); setNotice(`Added ${serverName}. Reload MCP or start a fresh session for tools.`); await load(); } catch(e:any){ setErr(e.message); } };
  const remove=(serverName:string)=>Alert.alert('Remove MCP server?', serverName, [{ text:'Cancel', style:'cancel' }, { text:'Remove', style:'destructive', onPress:()=>void (async()=>{ try{ await rest?.deleteMcpServer(serverName); setNotice(`Removed ${serverName}.`); await load(); } catch(e:any){ setErr(e.message); } })() }]);
  const test=async(serverName:string)=>{ try{ setErr(''); setNotice(`Testing ${serverName}…`); const result=await rest?.testMcpServer(serverName); const count=Array.isArray(result?.tools)?result.tools.length:0; setNotice(result?.ok ? `${serverName} connected · ${count} tools` : `${serverName} failed: ${safeText(result?.error||'unknown error')}`); } catch(e:any){ setErr(e.message); } };
  const install=async(entry:McpCatalogEntry)=>{ try{ setErr(''); setNotice(`Installing ${entry.name}…`); await rest?.installMcp({ name: entry.name, enable: true }); setNotice(`Installed ${entry.name}. Add required env vars, then reload MCP/new turn.`); await load(); } catch(e:any){ setErr(e.message); } };
  const serverSub=(s:McpServer)=>`${safeText(s.transport || (s.url?'http':s.command?'stdio':'unknown'))}${s.url?` · ${s.url}`:s.command?` · ${s.command}`:''}${s.tools?` · ${Array.isArray(s.tools)?s.tools.length:'all'} tools`:''}`;
  return <ScrollView contentContainerStyle={styles.screen}>
    {loading ? <LoadingBlock label="Loading MCP…" /> : <>
      <Card><View style={styles.rowBetween}><Text style={styles.sectionTitle}>Servers</Text><Text style={styles.listSub}>{servers.length} configured</Text></View>{err?<Text style={styles.error}>{err}</Text>:null}{notice?<Text style={notice.includes('failed')?styles.error:styles.success}>{notice}</Text>:null}{servers.length===0?<Text style={styles.muted}>No configured MCP servers found.</Text>:servers.map(s=><View key={s.name} style={styles.compactListItem}><Pressable onPress={()=>setExpanded(expanded===s.name?'':s.name)} style={styles.compactMain}><View style={{ flex: 1 }}><Text style={styles.listTitle}>{safeText(s.name)}</Text><Text style={styles.listSub} numberOfLines={1}>{serverSub(s)}</Text></View><View style={[styles.statusDot, s.enabled===false && styles.statusDotOff]} /><Ionicons name="chevron-forward" size={18} color={colors.muted} /></Pressable>{expanded===s.name?<View style={styles.detailsPanel}>{s.env&&Object.keys(s.env).length?<Text style={styles.muted}>env: {Object.keys(s.env).join(', ')}</Text>:null}<View style={styles.row}><Button text="Test" secondary icon="flash-outline" onPress={()=>void test(s.name)}/><Button text={s.enabled===false?'Enable':'Disable'} secondary icon="power-outline" onPress={async()=>{await rest?.setMcpEnabled(s.name,s.enabled===false); await load();}}/><Button text="Remove" secondary icon="trash-outline" onPress={()=>remove(s.name)}/></View></View>:null}</View>)}</Card>
      <Card><Text style={styles.sectionTitle}>Add server</Text><Label text="Name"/><Input value={name} onChangeText={setName} placeholder="filesystem"/><View style={styles.row}><Button text="HTTP" secondary={transport!=='http'} icon="globe-outline" onPress={()=>setTransport('http')}/><Button text="Stdio" secondary={transport!=='stdio'} icon="terminal-outline" onPress={()=>setTransport('stdio')}/></View>{transport==='http'?<><Label text="URL"/><Input value={url} onChangeText={setUrl} placeholder="https://example.com/mcp" autoCapitalize="none"/></>:<><Label text="Command"/><Input value={command} onChangeText={setCommand} placeholder="npx" autoCapitalize="none"/><Label text="Args"/><Input value={args} onChangeText={setArgs} placeholder="-y @modelcontextprotocol/server-filesystem" autoCapitalize="none"/></>}<Label text="Auth header/value (optional)"/><Input value={auth} onChangeText={setAuth} placeholder="Bearer ..." autoCapitalize="none" secureTextEntry/><Label text="Env JSON"/><Input value={env} onChangeText={setEnv} multiline/><Button text="Add server" icon="add-outline" onPress={create}/></Card>
      <Card><View style={styles.rowBetween}><Text style={styles.sectionTitle}>Optional MCP catalog</Text><Text style={styles.listSub}>{catalog.length}</Text></View>{catalog.slice(0,12).map(entry=><View key={entry.name} style={styles.compactListItem}><View style={styles.compactMain}><View style={{ flex: 1 }}><Text style={styles.listTitle}>{safeText(entry.name)}</Text><Text style={styles.listSub} numberOfLines={2}>{safeText(entry.description||entry.transport||'Catalog entry')}</Text>{Array.isArray(entry.env)&&entry.env.length?<Text style={styles.muted}>env: {entry.env.join(', ')}</Text>:null}</View><Button text="Install" secondary icon="download-outline" onPress={()=>void install(entry)}/></View></View>)}</Card>
    </>}
  </ScrollView>;
}

function CronScreen({ rest }: { rest: HermesRestClient | null }) {
  const [jobs,setJobs]=useState<CronJob[]>([]); const [name,setName]=useState(''); const [schedule,setSchedule]=useState('every 4h'); const [prompt,setPrompt]=useState(''); const [err,setErr]=useState(''); const [loading,setLoading]=useState(false);
  const load=async()=>{ if(!rest)return; setLoading(true); try { const data = await rest.cronJobs(); setJobs(Array.isArray(data) ? data : []); } finally { setLoading(false); } };
  useEffect(()=>{ load().catch(e=>setErr(e.message));},[rest]);
  const create=async()=>{ try{ await rest?.createCronJob({ name, schedule, prompt }); setName(''); setPrompt(''); await load(); } catch(e:any){setErr(e.message);} };
  return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>Cron jobs</Text>{err?<Text style={styles.error}>{err}</Text>:null}<Label text="Name"/><Input value={name} onChangeText={setName} placeholder="Morning operator brief"/><Label text="Schedule"/><Input value={schedule} onChangeText={setSchedule}/><Label text="Prompt"/><Input value={prompt} onChangeText={setPrompt} placeholder="What should Hermes do?" multiline/><Button text="Create cron" icon="add-outline" onPress={create}/></Card>{loading ? <LoadingBlock label="Loading cron jobs…" /> : jobs.map(j=>{const id=safeText(j.job_id||j.id); const scheduleText = safeText((j as any).schedule_display || (typeof j.schedule === 'object' ? (j.schedule as any).display : j.schedule)); return <Card key={id || makeId()}><Text style={styles.listTitle}>{safeText(j.name||id)}</Text><Text style={styles.listSub}>{scheduleText || 'no schedule'} · {j.enabled===false||j.paused?'paused':'enabled'}</Text><Text style={styles.muted}>{safeText(j.prompt).slice(0,160)}</Text><View style={styles.row}><Button text={j.enabled===false||j.paused?'Resume':'Pause'} secondary icon="pause-outline" onPress={async()=>{j.enabled===false||j.paused?await rest?.resumeCronJob(id):await rest?.pauseCronJob(id); await load();}}/><Button text="Run" secondary icon="play-outline" onPress={async()=>{await rest?.triggerCronJob(id); await load();}}/><Button text="Delete" secondary icon="trash-outline" onPress={async()=>{await rest?.deleteCronJob(id); await load();}}/></View></Card>})}</ScrollView>;
}

function SettingsScreen({ rest, profile, statusPayload }: { rest: HermesRestClient | null; profile: ConnectionProfile | null; statusPayload: any }) {
  const [model,setModel]=useState<any>(null); const [profiles,setProfiles]=useState<any>(null); const [logs,setLogs]=useState<any>(null); const [loading,setLoading]=useState(false);
  const load=async()=>{ if(!rest)return; setLoading(true); try { const [m,p,l]=await Promise.all([rest.modelInfo().catch((e:any)=>({error:e.message})), rest.profiles().catch((e:any)=>({error:e.message})), rest.logs(40).catch((e:any)=>({error:e.message}))]); setModel(m); setProfiles(p); setLogs(l); } finally { setLoading(false); } };
  useEffect(()=>{load().catch(()=>undefined)},[rest]);
  return <ScrollView contentContainerStyle={styles.screen}>{loading ? <LoadingBlock label="Loading system info…" /> : null}<JsonCard title="Connection details" data={{ name: profile?.name, baseUrl: profile?.baseUrl, platform: Platform.OS }} /><JsonCard title="Profiles" data={profiles}/><JsonCard title="Auth + session" data={{ authMode: profile?.authMode || 'auto', token: profile?.token ? '[stored securely]' : null, username: profile?.username || null, password: profile?.password ? '[stored securely]' : null }} /><JsonCard title="System status" data={statusPayload}/><JsonCard title="Raw JSON / status output" data={{ model, logs }}/><Card><Text style={styles.sectionTitle}>Advanced / admin</Text><Text style={styles.muted}>Dangerous actions stay behind explicit details/overflow controls.</Text></Card></ScrollView>;
}

function LoadingBlock({ label, compact }: { label: string; compact?: boolean }) { return <View style={[styles.loading, compact && { padding: 12 }]}><ActivityIndicator color={colors.primary2} /><Text style={styles.muted}>{label}</Text></View>; }
function ToggleRow({ title, sub, on, onPress }: { title:string; sub:string; on:boolean; onPress:()=>void }) { return <Pressable style={styles.listItem} onPress={onPress}><View style={{flex:1}}><Text style={styles.listTitle}>{title}</Text><Text style={styles.listSub}>{sub}</Text></View><View style={[styles.toggle,on&&styles.toggleOn]}><View style={[styles.knob,on&&styles.knobOn]}/></View></Pressable>; }
function JsonCard({ title, data }: { title:string; data:any }) { return <Card><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.code}>{safeText(data ?? {}).slice(0,2200)}</Text></Card>; }
function Empty({ title, body }: { title:string; body:string }) { return <Card><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.muted}>{body}</Text></Card>; }
function Card({ children }: { children: React.ReactNode }) { return <View style={styles.card}>{children}</View>; }
function Label({ text }: { text:string }) { return <Text style={styles.label}>{text}</Text>; }
function Input(props: any) { return <TextInput {...props} placeholderTextColor={colors.faint} style={[styles.input, props.multiline && { minHeight: 96, textAlignVertical: 'top' }, props.style]} />; }
function Button({ text, icon, onPress, secondary }: { text:string; icon?: keyof typeof Ionicons.glyphMap; onPress?:()=>void; secondary?:boolean }) { return <Pressable onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary]}>{icon?<Ionicons name={icon} size={17} color={colors.text}/>:null}<Text style={styles.buttonText}>{text}</Text></Pressable>; }
function Command({ text }: { text:string }) { return <Text style={styles.code}>{text}</Text>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg }, root: { flex: 1 }, fill: { flex: 1 }, body: { flex: 1 },
  header: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.primary2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.2 }, title: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.8 },
  pill: { flexDirection:'row', gap:8, alignItems:'center', borderWidth:1, borderColor: colors.stroke, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, backgroundColor:'rgba(255,255,255,0.04)', maxWidth: 170 }, pillGood:{borderColor:'rgba(52,211,153,0.4)'}, pillBad:{borderColor:'rgba(251,113,133,0.4)'}, pillText:{color:colors.text,fontSize:12,fontWeight:'700'}, dot:{width:8,height:8,borderRadius:99},
  screen: { padding: 14, paddingBottom: 170, gap: 12 },
  card: { backgroundColor:'rgba(17,24,47,0.82)', borderWidth:1, borderColor: colors.stroke, borderRadius: radius.lg, padding:14, gap:10, ...shadow }, sectionTitle:{color:colors.text,fontSize:20,fontWeight:'800',letterSpacing:-0.4}, muted:{color:colors.muted,lineHeight:21}, mutedCenter:{color:colors.muted,lineHeight:21,textAlign:'center'}, text:{color:colors.text,lineHeight:21}, error:{color:colors.bad,fontWeight:'700'}, errorInline:{color:colors.bad,fontWeight:'700',paddingHorizontal:14,paddingBottom:6}, success:{color:colors.good,fontWeight:'700'}, label:{color:colors.muted,fontSize:12,fontWeight:'800',textTransform:'uppercase',letterSpacing:0.8},
  input:{backgroundColor:'rgba(255,255,255,0.055)', borderWidth:1, borderColor:colors.stroke, borderRadius:radius.md, paddingHorizontal:14, paddingVertical:12, color:colors.text, fontSize:15},
  row:{flexDirection:'row', gap:10, flexWrap:'wrap'}, rowBetween:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:12}, button:{backgroundColor:colors.primary, paddingHorizontal:14, paddingVertical:12, borderRadius:radius.md, flexDirection:'row',alignItems:'center',gap:7, justifyContent:'center'}, buttonSecondary:{backgroundColor:'rgba(255,255,255,0.08)', borderWidth:1,borderColor:colors.stroke}, buttonText:{color:colors.text,fontWeight:'800'},
  code:{fontFamily:Platform.select({ios:'Menlo',android:'monospace',default:'monospace'}), color:'#dbeafe', backgroundColor:'rgba(0,0,0,0.35)', borderRadius:radius.md, padding:12, overflow:'hidden', lineHeight:19},
  listItem:{borderWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(255,255,255,0.035)',borderRadius:radius.md,padding:13,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}, selected:{borderColor:colors.primary2,backgroundColor:'rgba(34,211,238,0.08)'}, listTitle:{color:colors.text,fontSize:16,fontWeight:'800'}, listSub:{color:colors.muted,fontSize:12,marginTop:3},
  tabs:{height:78,borderTopWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(5,7,13,0.96)',flexDirection:'row',paddingHorizontal:8,paddingTop:8,paddingBottom:10,gap:4}, tabsInner:{padding:10,gap:8}, tab:{flex:1,alignItems:'center',justifyContent:'center',gap:3,paddingHorizontal:2,paddingVertical:7,borderRadius:radius.md,borderWidth:1,borderColor:'transparent'}, tabActive:{backgroundColor:'rgba(139,92,246,0.22)',borderColor:'rgba(139,92,246,0.45)'}, tabText:{color:colors.muted,fontSize:11,fontWeight:'800'},
  toggle:{width:48,height:28,borderRadius:999,backgroundColor:'rgba(255,255,255,0.14)',padding:3}, toggleOn:{backgroundColor:colors.primary}, knob:{width:22,height:22,borderRadius:99,backgroundColor:colors.text}, knobOn:{transform:[{translateX:20}]},
  loading:{borderWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(255,255,255,0.035)',borderRadius:radius.lg,padding:20,gap:10,alignItems:'center',justifyContent:'center'},
  chatRoot:{flex:1}, chatTopBar:{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:12,paddingVertical:10,borderBottomWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(5,7,13,0.55)'}, iconButton:{width:42,height:42,borderRadius:99,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(255,255,255,0.06)',borderWidth:1,borderColor:colors.stroke}, chatTitle:{color:colors.text,fontSize:18,fontWeight:'900'}, chatSub:{color:colors.muted,fontSize:12,marginTop:2}, chatMessages:{padding:14,paddingBottom:28,gap:8,minHeight:'100%'}, centerPane:{flex:1,minHeight:420,alignItems:'center',justifyContent:'center',gap:10,paddingHorizontal:30},
  composer:{flexDirection:'row',alignItems:'flex-end',gap:10,padding:12,borderTopWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(5,7,13,0.96)'}, composerInput:{flex:1,maxHeight:130,backgroundColor:'rgba(255,255,255,0.06)',borderWidth:1,borderColor:colors.stroke,borderRadius:22,paddingHorizontal:15,paddingVertical:11,color:colors.text}, send:{backgroundColor:colors.primary,borderRadius:99,width:46,height:46,alignItems:'center',justifyContent:'center'},
  messageWrap:{alignSelf:'stretch',gap:6,marginBottom:8}, messageWrapUser:{alignItems:'flex-end'}, bubble:{borderRadius:radius.lg,padding:13,gap:5}, userBubble:{backgroundColor:'rgba(139,92,246,0.25)',alignSelf:'flex-end',maxWidth:'92%'}, assistantBubble:{backgroundColor:'rgba(255,255,255,0.06)',alignSelf:'flex-start',maxWidth:'96%'}, bubbleRole:{color:colors.primary2,fontSize:11,fontWeight:'900',textTransform:'uppercase'},
  drawerScrim:{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(0,0,0,0.52)'}, drawer:{position:'absolute',left:0,top:0,bottom:0,width:'82%',maxWidth:360,backgroundColor:'#080c18',borderRightWidth:1,borderColor:colors.stroke,paddingTop:58,paddingHorizontal:14,gap:12}, drawerItem:{borderWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(255,255,255,0.04)',borderRadius:radius.md,padding:13}, drawerFilterRow:{flexDirection:'row',gap:10}, drawerFilterPill:{flex:1,borderWidth:1,borderColor:'rgba(255,255,255,0.84)',borderRadius:radius.md,paddingVertical:10,alignItems:'center',justifyContent:'center',backgroundColor:'transparent'}, drawerFilterPillActive:{backgroundColor:'rgba(255,255,255,0.12)',borderColor:colors.text}, drawerFilterText:{color:colors.text,fontSize:13,fontWeight:'900'},
  toolCard:{alignSelf:'flex-start',maxWidth:'96%',borderWidth:1,borderColor:'rgba(139,92,246,0.28)',backgroundColor:'rgba(139,92,246,0.09)',borderRadius:radius.md,padding:10,flexDirection:'row',gap:10,alignItems:'flex-start'}, skillCard:{borderColor:'rgba(34,211,238,0.28)',backgroundColor:'rgba(34,211,238,0.08)'}, toolCardError:{borderColor:'rgba(251,113,133,0.35)',backgroundColor:'rgba(251,113,133,0.08)'}, toolGlyph:{width:25,height:25,borderRadius:99,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(0,0,0,0.2)'}, toolTitle:{color:colors.text,fontSize:13,fontWeight:'900'}, toolSub:{color:colors.muted,fontSize:12,lineHeight:17,marginTop:2}, toolDetail:{color:colors.bad,fontSize:12,lineHeight:17,marginTop:6,fontFamily:Platform.select({ios:'Menlo',android:'monospace',default:'monospace'})}, activityLine:{alignSelf:'flex-start',color:colors.muted,fontSize:12,fontWeight:'700',paddingHorizontal:3,paddingVertical:2},
  headerCompact:{paddingHorizontal:16,paddingTop:8,paddingBottom:10,flexDirection:'row',alignItems:'center',justifyContent:'space-between',borderBottomWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(5,7,13,0.48)'}, rowCenter:{flexDirection:'row',alignItems:'center',gap:10,flex:1}, headerBack:{width:34,height:34,borderRadius:99,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(255,255,255,0.06)',borderWidth:1,borderColor:colors.stroke}, headerTitle:{color:colors.text,fontSize:20,fontWeight:'900',letterSpacing:-0.3}, headerSub:{color:colors.muted,fontSize:12,marginTop:2},
  onboardingScreen:{padding:16,paddingBottom:36,gap:14}, hero:{alignItems:'center',gap:10,paddingTop:22,paddingBottom:8,paddingHorizontal:8}, heroTitle:{color:colors.text,fontSize:42,fontWeight:'900',letterSpacing:-1.4,textAlign:'center'}, orbital:{width:148,height:132,alignItems:'center',justifyContent:'center',marginVertical:8}, orbitalRing:{position:'absolute',width:142,height:76,borderRadius:999,borderWidth:1,borderColor:'rgba(139,92,246,0.52)',transform:[{rotate:'-18deg'}]}, orbitalRingTilt:{borderColor:'rgba(34,211,238,0.34)',transform:[{rotate:'24deg'}]}, orbitalCore:{width:70,height:70,borderRadius:35,alignItems:'center',justifyContent:'center',shadowColor:colors.primary,shadowOpacity:0.55,shadowRadius:18}, advancedLink:{alignSelf:'center',flexDirection:'row',alignItems:'center',gap:5,paddingVertical:4}, advancedText:{color:colors.primary2,fontWeight:'800'}, advancedPanel:{gap:10,borderTopWidth:1,borderColor:colors.stroke,paddingTop:10}, compactIcon:{width:34,height:34,borderRadius:99,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(255,255,255,0.05)',borderWidth:1,borderColor:colors.stroke},
  opsRow:{borderWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(17,24,47,0.82)',borderRadius:radius.lg,padding:15,flexDirection:'row',alignItems:'center',gap:12,...shadow}, opsIcon:{width:42,height:42,borderRadius:14,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(139,92,246,0.14)',borderWidth:1,borderColor:'rgba(139,92,246,0.26)'}, compactListItem:{borderWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(255,255,255,0.035)',borderRadius:radius.md,overflow:'hidden'}, compactMain:{padding:12,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10}, statusDot:{width:9,height:9,borderRadius:99,backgroundColor:colors.good}, statusDotOff:{backgroundColor:colors.muted}, detailsPanel:{borderTopWidth:1,borderColor:colors.stroke,padding:12,gap:10,backgroundColor:'rgba(0,0,0,0.16)'}
});
