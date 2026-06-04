# Hermes Mobile

**Hermes Mobile** is a local-first iOS-polished React Native + Expo cockpit for your own [Hermes Agent](https://github.com/NousResearch/hermes-agent). It connects directly to the same `hermes dashboard --tui` backend that Hermes Desktop uses — no Kryden cloud, no required custom Hermes plugin, and no server changes required.

> A dead-simple phone cockpit for your Hermes Agent: connect, chat, approve, inspect sessions, manage crons, skills, MCP servers, tools, and remote access guidance from your pocket.

## MVP scope

- Front-and-center connection setup for first-time users.
- Manual backend URL + token setup.
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

Hermes Mobile talks to the standard Hermes dashboard backend. Hermes Desktop can auto-start a private dashboard only when it is running on the same machine as Hermes Agent. A phone cannot start a process on your computer, so Mobile makes this explicit in the first-run setup wizard: start the backend once, then connect by URL + token.

Start Hermes with TUI/chat support and a stable session token:

```bash
# Generate a stable private token; do not publish it.
TOKEN=$(openssl rand -base64 32)
printf 'HERMES_DASHBOARD_SESSION_TOKEN=%s\n' "$TOKEN" >> ~/.hermes/.env
chmod 600 ~/.hermes/.env

# Local/Tailscale-friendly backend. Prefer a Tailscale IP or MagicDNS host for remote use.
hermes dashboard --tui --no-open --insecure --host <tailscale-or-lan-ip> --port 9119
```

Then connect Hermes Mobile to:

- URL: `http://<tailscale-or-lan-ip>:9119`
- Token: the value you generated above

Security note: `--insecure` means the dashboard accepts token auth on non-loopback interfaces. Use Tailscale or a trusted LAN. Do **not** expose the dashboard to the public internet.

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
