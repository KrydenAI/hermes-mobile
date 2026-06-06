# Hermes Mobile

**Hermes Mobile** is a local-first, iOS-polished React Native + Expo cockpit for your own [Hermes Agent](https://github.com/NousResearch/hermes-agent). It connects directly to the standard `hermes --tui dashboard` backend — no Kryden cloud, no required custom Hermes plugin, and no server changes required.

> A phone cockpit for Hermes Agent: connect by URL, chat with sessions, handle approvals/clarifications, inspect delivered briefs, collect artifacts, and manage ops surfaces from your pocket.

## Current app scope

- First-run **Connect** screen with dashboard URL entry and saved backend profiles.
- URL-only Tailnet/LAN setup for `--insecure` dashboards; Hermes Mobile auto-discovers the injected session token from the dashboard HTML.
- Optional advanced manual session-token entry.
- Hermes internal username/password login support when the dashboard advertises a password-capable provider.
- Explicit unsupported message when an external browser OAuth provider gates the dashboard; no WebView cookie bridge is attempted.
- Chat tab with session drawer, session resume/create, prompt submit, streaming message events, and compact tool/skill activity summaries.
- Pulse tab for approval/clarify/access requests, live work activity, and recent delivered automation briefs.
- Artifacts tab that extracts links, images, files, paths, and `MEDIA:` attachments from recent user-facing sessions.
- Ops tab with Skills/toolsets toggles, MCP server/catalog management, and cron create/pause/resume/run/delete.
- Settings tab with connection details, auth/session state, profiles, system status, model info, and logs.

## Not in the current app

- QR-code scanning/pairing. Camera permissions were removed with the QR flow.
- Native deep-link pairing from a `hermes dashboard pair` command.
- Push notifications for approvals/blockers.
- Automatic backend process startup from the phone. Mobile connects to an already-running dashboard.

## Backend requirement

Hermes Mobile talks to the standard Hermes dashboard backend. Hermes Desktop can auto-start a private dashboard only when it is running on the same machine as Hermes Agent. A phone cannot start a process on your computer, so Mobile makes this explicit: start the backend once, then connect by URL.

Fastest path: start Hermes with TUI/chat support on a trusted Tailnet/LAN address:

```bash
# Local/Tailscale-friendly backend. Prefer a Tailscale IP or MagicDNS host.
hermes --tui dashboard --no-open --insecure --host <tailscale-or-lan-ip> --port 9119
```

Then connect Hermes Mobile to:

- URL: `http://<tailscale-or-lan-ip>:9119`
- Token: leave blank; Hermes Mobile auto-discovers it from the dashboard HTML in this mode.

Security note: `--insecure` means the dashboard accepts session-token auth on non-loopback interfaces. Use Tailscale or a trusted LAN. Do **not** expose the dashboard to the public internet.

Auth support matrix:

- `--insecure` Tailnet/LAN dashboard: supported with URL only.
- Hermes internal username/password dashboard provider: supported with credentials entered in Advanced options.
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
- Better mobile-native file previews and handoff for local files.
- TestFlight/App Store packaging.

## License

MIT
