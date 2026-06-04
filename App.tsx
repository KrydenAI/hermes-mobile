import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';

import { HermesRestClient, HermesRpcClient, normalizeBaseUrl, parsePairingPayload, prepareConnectionProfile } from './src/api/hermes';
import { deleteProfile, loadProfiles, upsertProfile } from './src/storage';
import { colors, radius, shadow } from './src/theme';
import type { ConnectionProfile, CronJob, HermesEvent, McpServer, SessionSummary, SkillInfo, ToolsetInfo } from './src/types';

type Tab = 'home' | 'chat' | 'approvals' | 'artifacts' | 'skills' | 'mcp' | 'cron' | 'settings';

type Message = { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; text: string; at: number };

type Status = 'idle' | 'testing' | 'connected' | 'error';

const tabs: { id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'home', label: 'Connect', icon: 'radio-outline' },
  { id: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline' },
  { id: 'approvals', label: 'Needs Me', icon: 'hand-left-outline' },
  { id: 'artifacts', label: 'Artifacts', icon: 'sparkles-outline' },
  { id: 'skills', label: 'Skills', icon: 'library-outline' },
  { id: 'mcp', label: 'MCP', icon: 'git-network-outline' },
  { id: 'cron', label: 'Cron', icon: 'alarm-outline' },
  { id: 'settings', label: 'Settings', icon: 'settings-outline' }
];

function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function sessionId(s: SessionSummary): string { return String(s.session_id || s.id || s.stored_session_id || ''); }
function titleOf(s: SessionSummary): string { return String(s.title || s.name || sessionId(s).slice(0, 8) || 'Untitled'); }
function summarize(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(summarize).join('\n');
  if (typeof v === 'object') return v.content || v.text || v.message || v.delta || JSON.stringify(v, null, 2);
  return String(v);
}

export default function App() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [status, setStatus] = useState<Status>('idle');
  const [statusPayload, setStatusPayload] = useState<any>(null);
  const [error, setError] = useState('');
  const [events, setEvents] = useState<HermesEvent[]>([]);
  const [activeSession, setActiveSession] = useState('');
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
          const text = summarize(event.payload);
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            return [...prev, { id: makeId(), role: 'assistant', text, at: Date.now() }];
          });
        }
        if (event.type === 'message.complete') {
          const text = summarize(event.payload?.message || event.payload?.content || event.payload);
          if (text) setMessages(prev => [...prev, { id: makeId(), role: 'assistant', text, at: Date.now() }]);
        }
      });
      await rpc.connect();
      rpcRef.current = rpc;
      setStatus('connected');
      const updated = { ...runtimeProfile, wsTicket: undefined, lastUsedAt: Date.now() };
      setProfile(updated);
      setProfiles(await upsertProfile(updated));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setStatus('error'); setError(e?.message || String(e));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    }
  }, [profile]);

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient colors={[colors.bg, '#070b18', colors.bg]} style={StyleSheet.absoluteFill} />
      <View style={styles.root}>
        <Header profile={profile} status={status} />
        <View style={styles.body}>
          {tab === 'home' && <ConnectScreen profiles={profiles} active={profile} status={status} error={error} statusPayload={statusPayload} onSelect={setProfile} onSave={async (p: ConnectionProfile) => { setProfile(p); setProfiles(await upsertProfile(p)); await connect(p); }} onDelete={async (id: string) => { setProfiles(await deleteProfile(id)); if (profile?.id === id) setProfile(null); }} onConnect={() => connect()} />}
          {tab === 'chat' && <ChatScreen rest={rest} rpc={rpcRef.current} connected={status === 'connected'} activeSession={activeSession} setActiveSession={setActiveSession} messages={messages} setMessages={setMessages} />}
          {tab === 'approvals' && <ApprovalsScreen rpc={rpcRef.current} events={events} activeSession={activeSession} />}
          {tab === 'artifacts' && <ArtifactsScreen rest={rest} />}
          {tab === 'skills' && <SkillsScreen rest={rest} />}
          {tab === 'mcp' && <McpScreen rest={rest} />}
          {tab === 'cron' && <CronScreen rest={rest} />}
          {tab === 'settings' && <SettingsScreen rest={rest} profile={profile} statusPayload={statusPayload} />}
        </View>
        <TabBar active={tab} setActive={setTab} />
      </View>
    </SafeAreaView>
  );
}

function Header({ profile, status }: { profile: ConnectionProfile | null; status: Status }) {
  return <View style={styles.header}>
    <View><Text style={styles.eyebrow}>Hermes Mobile</Text><Text style={styles.title}>Pocket cockpit</Text></View>
    <View style={[styles.pill, status === 'connected' ? styles.pillGood : status === 'error' ? styles.pillBad : null]}>
      <View style={[styles.dot, status === 'connected' ? { backgroundColor: colors.good } : status === 'error' ? { backgroundColor: colors.bad } : { backgroundColor: colors.warn }]} />
      <Text style={styles.pillText}>{profile ? profile.name : 'No backend'}</Text>
    </View>
  </View>;
}

function TabBar({ active, setActive }: { active: Tab; setActive: (t: Tab) => void }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsInner}>
    {tabs.map(t => <Pressable key={t.id} onPress={() => setActive(t.id)} style={[styles.tab, active === t.id && styles.tabActive]}>
      <Ionicons name={t.icon} size={19} color={active === t.id ? colors.text : colors.muted} />
      <Text style={[styles.tabText, active === t.id && { color: colors.text }]}>{t.label}</Text>
    </Pressable>)}
  </ScrollView>;
}

function ConnectScreen({ profiles, active, status, error, statusPayload, onSelect, onSave, onDelete }: any) {
  const [name, setName] = useState(active?.name || 'My Hermes');
  const [baseUrl, setBaseUrl] = useState(active?.baseUrl || 'http://100.x.y.z:9119');
  const [token, setToken] = useState(active?.token || '');
  const [username, setUsername] = useState(active?.username || '');
  const [password, setPassword] = useState(active?.password || '');
  const [showScanner, setShowScanner] = useState(false);
  const pairingValue = `hermesmobile://connect?url=${encodeURIComponent(normalizeBaseUrl(baseUrl))}&token=${encodeURIComponent(token)}`;
  const setupCommand = 'hermes dashboard --tui --no-open --host <tailscale-or-lan-ip> --port 9119 --insecure';
  useEffect(() => { if (active) { setName(active.name); setBaseUrl(active.baseUrl); setToken(active.token || ''); setUsername(active.username || ''); setPassword(active.password || ''); } }, [active]);

  const save = () => onSave({ id: active?.id || makeId(), name: name.trim() || 'Hermes', baseUrl: normalizeBaseUrl(baseUrl), token: token.trim(), username: username.trim(), password, authMode: username.trim() || password ? 'password' : 'auto', createdAt: active?.createdAt || Date.now(), lastUsedAt: Date.now() });

  return <ScrollView contentContainerStyle={styles.screen}>
    <Card>
      <Text style={styles.sectionTitle}>Quick Connect</Text>
      <Text style={styles.muted}>Paste your dashboard URL. Token discovery is automatic for Tailnet/LAN mode.</Text>
    </Card>
    <Card>
      <Text style={styles.sectionTitle}>Connect to your Hermes Agent</Text>
      <Label text="Profile name" /><Input value={name} onChangeText={setName} placeholder="My Hermes" />
      <Label text="Dashboard URL" /><Input value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" placeholder="http://desktop.tailnet.ts.net:9119" />
      <View style={styles.row}><Button icon="qr-code-outline" text="Scan QR" onPress={() => setShowScanner(true)} secondary /><Button icon="flash-outline" text={status === 'testing' ? 'Connecting...' : 'Save + Connect'} onPress={save} /></View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusPayload ? <Text style={styles.success}>REST OK · {String(statusPayload.version || statusPayload.hermes_version || 'Hermes')} · {String(statusPayload.mobile_message || 'connected')}</Text> : null}
      <Label text="Session token (optional)" /><Input value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry placeholder="Usually auto-discovered" />
      <Label text="Internal login username (optional)" /><Input value={username} onChangeText={setUsername} autoCapitalize="none" placeholder="Only if dashboard advertises password login" />
      <Label text="Internal login password (optional)" /><Input value={password} onChangeText={setPassword} secureTextEntry placeholder="Only if dashboard advertises password login" />
    </Card>
    <Card>
      <Text style={styles.sectionTitle}>Recommended backend</Text>
      <Text style={styles.muted}>Run this on your Hermes computer, then paste the URL above.</Text>
      <Command text={setupCommand} />
      <View style={styles.row}><Button text="Open Tailscale" icon="open-outline" secondary onPress={() => Linking.openURL('https://tailscale.com/download')} /><Button text="Copy command" icon="copy-outline" secondary onPress={() => Clipboard.setStringAsync(setupCommand)} /></View>
    </Card>
    <Card>
      <Text style={styles.sectionTitle}>Pairing QR</Text>
      <Text style={styles.muted}>Optional fallback.</Text>
      <View style={styles.qrWrap}>{token ? <QRCode value={pairingValue} size={170} backgroundColor="transparent" color={colors.text} /> : <Text style={styles.muted}>A stored/advanced token can generate QR here.</Text>}</View>
    </Card>
    {profiles.length ? <Card><Text style={styles.sectionTitle}>Saved backends</Text>{profiles.map((p: ConnectionProfile) => <Pressable key={p.id} style={styles.listItem} onPress={() => onSelect(p)}><View><Text style={styles.listTitle}>{p.name}</Text><Text style={styles.listSub}>{p.baseUrl} · {p.authMode || 'auto'}</Text></View><Pressable onPress={() => onDelete(p.id)}><Ionicons name="trash-outline" size={18} color={colors.bad} /></Pressable></Pressable>)}</Card> : null}
    <Scanner visible={showScanner} onClose={() => setShowScanner(false)} onData={data => { const parsed = parsePairingPayload(data); if (parsed?.baseUrl) { setBaseUrl(parsed.baseUrl); setToken(parsed.token || ''); setShowScanner(false); } }} />
  </ScrollView>;
}

function MiniPath({ icon, title, body }: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }) {
  return <View style={styles.miniPath}><Ionicons name={icon} size={22} color={colors.primary2} /><Text style={styles.listTitle}>{title}</Text><Text style={styles.listSub}>{body}</Text></View>;
}

function Hero() { return <LinearGradient colors={[colors.primary, '#1d4ed8', colors.primary2]} start={{x:0,y:0}} end={{x:1,y:1}} style={styles.hero}><Text style={styles.heroText}>The phone-native control surface for Hermes Agent.</Text><Text style={styles.heroSub}>Chat, approvals, crons, skills, MCP, artifacts — local-first.</Text></LinearGradient>; }

function Scanner({ visible, onClose, onData }: { visible: boolean; onClose: () => void; onData: (d: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  useEffect(() => { if (visible && !permission?.granted) requestPermission(); }, [visible, permission?.granted]);
  return <Modal visible={visible} animationType="slide"><View style={styles.scanner}>{permission?.granted ? <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => onData(data)} /> : <Text style={styles.text}>Camera permission required.</Text>}<Pressable style={styles.close} onPress={onClose}><Ionicons name="close" size={28} color={colors.text}/></Pressable></View></Modal>;
}

function ChatScreen({ rest, rpc, connected, activeSession, setActiveSession, messages, setMessages }: any) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]); const [prompt, setPrompt] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const refresh = async () => { if (!rest) return; const data = await rest.sessions(); setSessions(Array.isArray(data) ? data : data.sessions || []); };
  useEffect(() => { refresh().catch(e => setErr(e.message)); }, [rest]);
  const newSession = async () => { if (!rpc) return; const r: any = await rpc.createSession(); const sid = r.session_id || r.id; setActiveSession(sid); setMessages([]); await refresh(); };
  const submit = async () => { if (!rpc || !prompt.trim()) return; let sid = activeSession; setBusy(true); setErr(''); try { if (!sid) { const r: any = await rpc.createSession(); sid = r.session_id || r.id; setActiveSession(sid); } setMessages((m: Message[]) => [...m, { id: makeId(), role: 'user', text: prompt, at: Date.now() }]); const text = prompt; setPrompt(''); await rpc.submitPrompt(sid, text); } catch(e:any){ setErr(e.message); } finally { setBusy(false); } };
  return <View style={styles.fill}><ScrollView contentContainerStyle={styles.screen}><Card><View style={styles.rowBetween}><View><Text style={styles.sectionTitle}>Sessions + chat</Text><Text style={styles.muted}>{connected ? 'Live JSON-RPC connected' : 'Connect WebSocket first'}</Text></View><Button text="New" icon="add-outline" secondary onPress={newSession} /></View>{err ? <Text style={styles.error}>{err}</Text> : null}{sessions.slice(0,8).map(s => <Pressable key={sessionId(s)} style={[styles.listItem, activeSession === sessionId(s) && styles.selected]} onPress={() => { setActiveSession(sessionId(s)); rest?.sessionMessages(sessionId(s)).then((d:any) => setMessages((d.messages || d || []).map((m:any, i:number) => ({ id: `${i}`, role: m.role || 'system', text: summarize(m.content || m.text || m), at: Date.now() })))).catch(()=>undefined); }}><View><Text style={styles.listTitle}>{titleOf(s)}</Text><Text style={styles.listSub}>{sessionId(s)} · {s.message_count ?? 0} messages</Text></View></Pressable>)}</Card><Card>{messages.length ? messages.map((m: Message) => <View key={m.id} style={[styles.bubble, m.role === 'user' ? styles.userBubble : styles.assistantBubble]}><Text style={styles.bubbleRole}>{m.role}</Text><Text style={styles.text}>{m.text}</Text></View>) : <Text style={styles.muted}>Pick a session or start a prompt. Tool activity and streamed responses appear here.</Text>}</Card></ScrollView><View style={styles.composer}><TextInput value={prompt} onChangeText={setPrompt} placeholder="Tell Hermes what to do…" placeholderTextColor={colors.faint} style={styles.composerInput} multiline /><Pressable onPress={submit} disabled={busy || !connected} style={styles.send}><Ionicons name="send" color={colors.text} size={20}/></Pressable></View></View>;
}

function ApprovalsScreen({ rpc, events, activeSession }: any) {
  const actionable = events.filter((e: HermesEvent) => ['approval.request','clarify.request','sudo.request','secret.request'].includes(e.type));
  const [answer, setAnswer] = useState('');
  return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>Needs me</Text><Text style={styles.muted}>Mobile-native approval inbox. This is the replacement for Slack/Telegram proxy control.</Text></Card>{actionable.length ? actionable.map((e: HermesEvent, i: number) => <Card key={`${e.receivedAt}-${i}`}><Text style={styles.eyebrow}>{e.type}</Text><Text style={styles.text}>{summarize(e.payload)}</Text>{e.type === 'approval.request' ? <View style={styles.row}><Button text="Approve" icon="checkmark-outline" onPress={() => rpc?.approval(e.session_id || activeSession, 'approve')} /><Button text="Deny" icon="close-outline" secondary onPress={() => rpc?.approval(e.session_id || activeSession, 'deny')} /></View> : <><Input value={answer} onChangeText={setAnswer} placeholder="Answer…" /><Button text="Send answer" icon="return-down-forward-outline" onPress={() => rpc?.clarify(e.payload?.request_id || e.payload?.id, answer)} /></>}</Card>) : <Empty title="Nothing needs you" body="Approval, clarify, sudo, and secret requests will appear here in real time." />}</ScrollView>;
}

function ArtifactsScreen({ rest }: { rest: HermesRestClient | null }) {
  const [items, setItems] = useState<any[]>([]); const [err, setErr] = useState('');
  const load = async () => { if (!rest) return; const data = await rest.sessions(10); const sessions = Array.isArray(data) ? data : data.sessions || []; const out:any[]=[]; for (const s of sessions.slice(0,5)) { try { const m = await rest.sessionMessages(sessionId(s)); for (const msg of (m.messages || m || []).slice(-20)) { const text = summarize(msg.content || msg.text || msg); if (/MEDIA:|```|artifact|file|path/i.test(text)) out.push({ session: titleOf(s), text: text.slice(0,900) }); } } catch {} } setItems(out); };
  useEffect(()=>{ load().catch(e=>setErr(e.message)); }, [rest]);
  return <ScrollView contentContainerStyle={styles.screen}><Card><View style={styles.rowBetween}><View><Text style={styles.sectionTitle}>Artifacts</Text><Text style={styles.muted}>Derived from existing session messages/tool outputs; no plugin required.</Text></View><Button text="Refresh" icon="refresh-outline" secondary onPress={load}/></View>{err ? <Text style={styles.error}>{err}</Text> : null}</Card>{items.length ? items.map((it,i)=><Card key={i}><Text style={styles.eyebrow}>{it.session}</Text><Text style={styles.text}>{it.text}</Text></Card>) : <Empty title="No artifacts found" body="Run sessions with files, previews, MEDIA attachments, or code blocks and they will surface here." />}</ScrollView>;
}

function SkillsScreen({ rest }: { rest: HermesRestClient | null }) {
  const [skills,setSkills]=useState<SkillInfo[]>([]); const [tools,setTools]=useState<ToolsetInfo[]>([]); const [query,setQuery]=useState(''); const [err,setErr]=useState('');
  const load=async()=>{ if(!rest)return; const [s,t]=await Promise.all([rest.skills(), rest.toolsets()]); setSkills(s); setTools(t); };
  useEffect(()=>{ load().catch(e=>setErr(e.message)); },[rest]);
  const filtered=skills.filter(s=>`${s.name} ${s.description||''}`.toLowerCase().includes(query.toLowerCase()));
  return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>Skills + tools</Text><Text style={styles.muted}>Mirrors desktop's skills/toolsets surface. Toggles write to the user's Hermes config.</Text><Input value={query} onChangeText={setQuery} placeholder="Search skills…" />{err?<Text style={styles.error}>{err}</Text>:null}</Card><Card><Text style={styles.sectionTitle}>Toolsets</Text>{tools.map(t=><ToggleRow key={t.name} title={t.name} sub={`${t.tools?.length||0} tools · ${t.provider||'default'}`} on={!!t.enabled} onPress={async()=>{await rest?.toggleToolset(t.name,!t.enabled); await load();}} />)}</Card><Card><Text style={styles.sectionTitle}>Skills</Text>{filtered.map(s=><ToggleRow key={s.name} title={s.name} sub={s.description||s.category||''} on={!!s.enabled} onPress={async()=>{await rest?.toggleSkill(s.name,!s.enabled); await load();}} />)}</Card></ScrollView>;
}

function McpScreen({ rest }: { rest: HermesRestClient | null }) { const [servers,setServers]=useState<McpServer[]>([]); const [catalog,setCatalog]=useState<any[]>([]); const [err,setErr]=useState(''); const load=async()=>{ if(!rest)return; const [s,c]=await Promise.all([rest.mcpServers(), rest.mcpCatalog().catch(()=>[]) as any]); setServers(Array.isArray(s)?s:[]); setCatalog(Array.isArray(c)?c:(c.servers||c.items||[])); }; useEffect(()=>{ load().catch(e=>setErr(e.message));},[rest]); return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>MCP setup</Text><Text style={styles.muted}>Inspect configured MCP servers and browse catalog entries. Install actions use existing Hermes endpoints.</Text>{err?<Text style={styles.error}>{err}</Text>:null}<Button text="Refresh" icon="refresh-outline" secondary onPress={load}/></Card><Card><Text style={styles.sectionTitle}>Servers</Text>{servers.map(s=><ToggleRow key={s.name} title={s.name} sub={s.command||s.url||s.status||''} on={!!s.enabled} onPress={async()=>{await rest?.setMcpEnabled(s.name,!s.enabled); await load();}} />)}</Card><Card><Text style={styles.sectionTitle}>Catalog</Text>{catalog.slice(0,20).map((c:any,i:number)=><View key={c.name||i} style={styles.listItem}><View><Text style={styles.listTitle}>{c.name||c.id}</Text><Text style={styles.listSub}>{c.description||c.command||''}</Text></View></View>)}</Card></ScrollView>; }

function CronScreen({ rest }: { rest: HermesRestClient | null }) { const [jobs,setJobs]=useState<CronJob[]>([]); const [name,setName]=useState(''); const [schedule,setSchedule]=useState('every 4h'); const [prompt,setPrompt]=useState(''); const [err,setErr]=useState(''); const load=async()=>{ if(!rest)return; setJobs(await rest.cronJobs());}; useEffect(()=>{ load().catch(e=>setErr(e.message));},[rest]); const create=async()=>{ try{ await rest?.createCronJob({ name, schedule, prompt }); setName(''); setPrompt(''); await load(); } catch(e:any){setErr(e.message);} }; return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>Cron jobs</Text><Text style={styles.muted}>Create, pause/resume, trigger, and delete Hermes scheduled jobs.</Text>{err?<Text style={styles.error}>{err}</Text>:null}<Label text="Name"/><Input value={name} onChangeText={setName} placeholder="Morning operator brief"/><Label text="Schedule"/><Input value={schedule} onChangeText={setSchedule}/><Label text="Prompt"/><Input value={prompt} onChangeText={setPrompt} placeholder="What should Hermes do?" multiline/><Button text="Create cron" icon="add-outline" onPress={create}/></Card>{jobs.map(j=>{const id=String(j.job_id||j.id||''); return <Card key={id}><Text style={styles.listTitle}>{j.name||id}</Text><Text style={styles.listSub}>{j.schedule} · {j.enabled===false||j.paused?'paused':'enabled'}</Text><Text style={styles.muted}>{String(j.prompt||'').slice(0,160)}</Text><View style={styles.row}><Button text={j.enabled===false||j.paused?'Resume':'Pause'} secondary icon="pause-outline" onPress={async()=>{j.enabled===false||j.paused?await rest?.resumeCronJob(id):await rest?.pauseCronJob(id); await load();}}/><Button text="Run" secondary icon="play-outline" onPress={async()=>{await rest?.triggerCronJob(id); await load();}}/><Button text="Delete" secondary icon="trash-outline" onPress={async()=>{await rest?.deleteCronJob(id); await load();}}/></View></Card>})}</ScrollView>; }

function SettingsScreen({ rest, profile, statusPayload }: { rest: HermesRestClient | null; profile: ConnectionProfile | null; statusPayload: any }) { const [model,setModel]=useState<any>(null); const [profiles,setProfiles]=useState<any>(null); const [logs,setLogs]=useState<any>(null); const load=async()=>{ if(!rest)return; const [m,p,l]=await Promise.all([rest.modelInfo().catch((e:any)=>({error:e.message})), rest.profiles().catch((e:any)=>({error:e.message})), rest.logs(40).catch((e:any)=>({error:e.message}))]); setModel(m); setProfiles(p); setLogs(l); }; useEffect(()=>{load().catch(()=>undefined)},[rest]); return <ScrollView contentContainerStyle={styles.screen}><Card><Text style={styles.sectionTitle}>Settings + system</Text><Text style={styles.muted}>Sensitive admin actions like env reveal, update, restart, raw config edits are intentionally not front-and-center on mobile.</Text><Button text="Refresh" icon="refresh-outline" secondary onPress={load}/></Card><JsonCard title="Connection" data={{ name: profile?.name, baseUrl: profile?.baseUrl, authMode: profile?.authMode || 'auto', token: profile?.token ? '[stored securely]' : null, username: profile?.username || null, password: profile?.password ? '[stored securely]' : null, platform: Platform.OS }} /><JsonCard title="Status" data={statusPayload}/><JsonCard title="Model" data={model}/><JsonCard title="Profiles" data={profiles}/><JsonCard title="Logs" data={logs}/></ScrollView>; }

function ToggleRow({ title, sub, on, onPress }: { title:string; sub:string; on:boolean; onPress:()=>void }) { return <Pressable style={styles.listItem} onPress={onPress}><View style={{flex:1}}><Text style={styles.listTitle}>{title}</Text><Text style={styles.listSub}>{sub}</Text></View><View style={[styles.toggle,on&&styles.toggleOn]}><View style={[styles.knob,on&&styles.knobOn]}/></View></Pressable>; }
function JsonCard({ title, data }: { title:string; data:any }) { return <Card><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.code}>{JSON.stringify(data ?? {}, null, 2).slice(0,2200)}</Text></Card>; }
function Empty({ title, body }: { title:string; body:string }) { return <Card><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.muted}>{body}</Text></Card>; }
function Card({ children }: { children: React.ReactNode }) { return <View style={styles.card}>{children}</View>; }
function Label({ text }: { text:string }) { return <Text style={styles.label}>{text}</Text>; }
function Input(props: any) { return <TextInput {...props} placeholderTextColor={colors.faint} style={[styles.input, props.multiline && { minHeight: 96, textAlignVertical: 'top' }, props.style]} />; }
function Button({ text, icon, onPress, secondary }: { text:string; icon?: keyof typeof Ionicons.glyphMap; onPress?:()=>void; secondary?:boolean }) { return <Pressable onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary]}>{icon?<Ionicons name={icon} size={17} color={colors.text}/>:null}<Text style={styles.buttonText}>{text}</Text></Pressable>; }
function Step({ n, text }: { n:string; text:string }) { return <View style={styles.step}><Text style={styles.stepNum}>{n}</Text><Text style={styles.text}>{text}</Text></View>; }
function Command({ text }: { text:string }) { return <Text style={styles.code}>{text}</Text>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg }, root: { flex: 1 }, fill: { flex: 1 }, body: { flex: 1 },
  header: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.primary2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.2 }, title: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.8 },
  pill: { flexDirection:'row', gap:8, alignItems:'center', borderWidth:1, borderColor: colors.stroke, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7, backgroundColor:'rgba(255,255,255,0.04)', maxWidth: 170 }, pillGood:{borderColor:'rgba(52,211,153,0.4)'}, pillBad:{borderColor:'rgba(251,113,133,0.4)'}, pillText:{color:colors.text,fontSize:12,fontWeight:'700'}, dot:{width:8,height:8,borderRadius:99},
  screen: { padding: 14, paddingBottom: 170, gap: 12 }, hero: { borderRadius: radius.xl, padding: 18, minHeight: 116, justifyContent:'flex-end', ...shadow }, heroText:{color:colors.text,fontSize:27,fontWeight:'900',letterSpacing:-1.2}, heroSub:{color:'rgba(255,255,255,0.82)',fontSize:14,marginTop:6},
  card: { backgroundColor:'rgba(17,24,47,0.82)', borderWidth:1, borderColor: colors.stroke, borderRadius: radius.lg, padding:14, gap:10, ...shadow }, sectionTitle:{color:colors.text,fontSize:20,fontWeight:'800',letterSpacing:-0.4}, muted:{color:colors.muted,lineHeight:21}, text:{color:colors.text,lineHeight:21}, error:{color:colors.bad,fontWeight:'700'}, success:{color:colors.good,fontWeight:'700'}, label:{color:colors.muted,fontSize:12,fontWeight:'800',textTransform:'uppercase',letterSpacing:0.8},
  input:{backgroundColor:'rgba(255,255,255,0.055)', borderWidth:1, borderColor:colors.stroke, borderRadius:radius.md, paddingHorizontal:14, paddingVertical:12, color:colors.text, fontSize:15},
  callout:{flexDirection:'row',gap:10,alignItems:'flex-start',borderWidth:1,borderColor:'rgba(34,211,238,0.24)',backgroundColor:'rgba(34,211,238,0.08)',borderRadius:radius.md,padding:12},
  setupGrid:{flexDirection:'row',gap:10,flexWrap:'wrap'},
  miniPath:{flex:1,minWidth:145,borderWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(255,255,255,0.04)',borderRadius:radius.md,padding:12,gap:6},
  row:{flexDirection:'row', gap:10, flexWrap:'wrap'}, rowBetween:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:12}, button:{backgroundColor:colors.primary, paddingHorizontal:14, paddingVertical:12, borderRadius:radius.md, flexDirection:'row',alignItems:'center',gap:7, justifyContent:'center'}, buttonSecondary:{backgroundColor:'rgba(255,255,255,0.08)', borderWidth:1,borderColor:colors.stroke}, buttonText:{color:colors.text,fontWeight:'800'},
  qrWrap:{alignItems:'center',justifyContent:'center',padding:16,borderRadius:radius.lg,backgroundColor:'rgba(255,255,255,0.05)'}, step:{flexDirection:'row',gap:10,alignItems:'flex-start'}, stepNum:{backgroundColor:colors.primary,color:colors.text,borderRadius:99,overflow:'hidden',width:24,height:24,textAlign:'center',lineHeight:24,fontWeight:'900'}, code:{fontFamily:Platform.select({ios:'Menlo',android:'monospace',default:'monospace'}), color:'#dbeafe', backgroundColor:'rgba(0,0,0,0.35)', borderRadius:radius.md, padding:12, overflow:'hidden', lineHeight:19},
  listItem:{borderWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(255,255,255,0.035)',borderRadius:radius.md,padding:13,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}, selected:{borderColor:colors.primary2,backgroundColor:'rgba(34,211,238,0.08)'}, listTitle:{color:colors.text,fontSize:16,fontWeight:'800'}, listSub:{color:colors.muted,fontSize:12,marginTop:3},
  tabs:{maxHeight:82,borderTopWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(5,7,13,0.92)'}, tabsInner:{padding:10,gap:8}, tab:{alignItems:'center',justifyContent:'center',gap:3,paddingHorizontal:12,paddingVertical:8,borderRadius:radius.md,borderWidth:1,borderColor:'transparent',minWidth:78}, tabActive:{backgroundColor:'rgba(139,92,246,0.22)',borderColor:'rgba(139,92,246,0.45)'}, tabText:{color:colors.muted,fontSize:11,fontWeight:'800'},
  composer:{flexDirection:'row',alignItems:'flex-end',gap:10,padding:12,borderTopWidth:1,borderColor:colors.stroke,backgroundColor:'rgba(5,7,13,0.96)'}, composerInput:{flex:1,maxHeight:130,backgroundColor:'rgba(255,255,255,0.06)',borderWidth:1,borderColor:colors.stroke,borderRadius:22,paddingHorizontal:15,paddingVertical:11,color:colors.text}, send:{backgroundColor:colors.primary,borderRadius:99,width:46,height:46,alignItems:'center',justifyContent:'center'},
  bubble:{borderRadius:radius.lg,padding:13,gap:5,marginBottom:10}, userBubble:{backgroundColor:'rgba(139,92,246,0.25)',alignSelf:'flex-end',maxWidth:'92%'}, assistantBubble:{backgroundColor:'rgba(255,255,255,0.06)',alignSelf:'flex-start',maxWidth:'96%'}, bubbleRole:{color:colors.primary2,fontSize:11,fontWeight:'900',textTransform:'uppercase'},
  scanner:{flex:1,backgroundColor:'#000',alignItems:'center',justifyContent:'center'}, close:{position:'absolute',top:55,right:20,backgroundColor:'rgba(0,0,0,0.5)',borderRadius:999,padding:10}, toggle:{width:48,height:28,borderRadius:999,backgroundColor:'rgba(255,255,255,0.14)',padding:3}, toggleOn:{backgroundColor:colors.primary}, knob:{width:22,height:22,borderRadius:99,backgroundColor:colors.text}, knobOn:{transform:[{translateX:20}]}
});
