# Hermes Mobile

**Hermes Mobile** is a local-first iOS-polished React Native + Expo cockpit for your own [Hermes Agent](https://github.com/NousResearch/hermes-agent). It connects directly to the same `hermes dashboard --tui` backend that Hermes Desktop uses — no Kryden cloud, no required custom Hermes plugin, and no server changes required.

> A dead-simple phone cockpit for your Hermes Agent: connect, chat, approve, inspect sessions, manage crons, skills, MCP servers, tools, and remote access guidance from your pocket.

## MVP scope

- Front-and-center connection setup for first-time users.
- URL-only Tailnet/LAN setup for `--insecure` dashboards; Hermes Mobile auto-discovers the injected session token from the dashboard HTML.
- Optional advanced manual token setup.
- Hermes internal username/password login support when the dashboard advertises a password-capable provider.
- Explicit unsupported message when an external browser OAuth provider gates the dashboard; no WebView cookie bridge is attempted.
- QR pairing payload support (`hermesmobile://connect?url=...&token=...` or JSON `{ "url": "...", "token": "..." }`).
- Tailscale setup assistant for secure remote access without exposing Hermes publicly.
- REST client for the existing dashboard API.
- JSON-RPC WebSocket client for `/api/ws` chat/session streaming.
- Session list, session resume/create, prompt submit, streaming message events.
- Approval and clarify inbox over Hermes gateway events.
- Skills, tools/toolsets, MCP servers/catalog, cron jobs create/pause/resume/trigger/delete.
- Artifacts view derived from recent session messages/tool outputs.
- Profiles/status/model/logs/settings surfaces.

## Backend requirement

Hermes Mobile talks to the standard Hermes dashboard backend. Hermes Desktop can auto-start a private dashboard only when it is running on the same machine as Hermes Agent. A phone cannot start a process on your computer, so Mobile makes this explicit in the first-run setup wizard: start the backend once, then connect by URL.

Fastest path: start Hermes with TUI/chat support on a trusted Tailnet/LAN address:

```bash
# Local/Tailscale-friendly backend. Prefer a Tailscale IP or MagicDNS host.
hermes dashboard --tui --no-open --insecure --host <tailscale-or-lan-ip> --port 9119
```

Then connect Hermes Mobile to:

- URL: `http://<tailscale-or-lan-ip>:9119`
- Token: leave blank; Hermes Mobile auto-discovers it from the dashboard HTML in this mode.

Security note: `--insecure` means the dashboard accepts session-token auth on non-loopback interfaces. Use Tailscale or a trusted LAN. Do **not** expose the dashboard to the public internet.

Auth support matrix:

- `--insecure` Tailnet/LAN dashboard: supported with URL only.
- Hermes internal username/password dashboard provider: supported with credentials entered in the app.
- External browser OAuth-only gated dashboard: detected and reported to the user as unsupported for now. Hermes Mobile intentionally does not use a WebView cookie bridge.

## Development

```bash
npm install
npm run typecheck
npm start
```

## Smoke-test a Hermes backend from a terminal

```bash
HERMES_MOBILE_URL=http://127.0.0.1:9119 \
HERMES_MOBILE_TOKEN='***' \
npm run test:api
```

## Roadmap

- Native deep-link pairing flow from a future upstream `hermes dashboard pair` command.
- Push notification bridge for approvals/blockers.
- Optional plugin installer for non-required community extensions such as Thoughts/Mind views.
- Rich artifact previews and mobile-native file handoff.
- TestFlight/App Store packaging.

## License

MIT
