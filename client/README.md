# Command Center Windows relay client

This is a portable Windows background client for the V1 Command Center relay. It discovers local Hermes profiles, publishes bounded status snapshots, roster data, presence, and heartbeats, and handles only the authenticated bounded Hermes chat request/response exchange on the dedicated device endpoint.

It does not send commands, action envelopes, or credentials in URLs. It never executes arbitrary relay-supplied commands. Chat requests use a local loopback Hermes backend with only session create/resume and prompt-submit operations; if that backend is unavailable, the client falls back to the fixed `hermes chat` invocation for the discovered Hermes profile. The relay-side backend launcher skips Hermes's bundled-skill seeding and background MCP discovery startup for faster readiness; the normal Hermes CLI, gateway, and dashboard are unchanged.

## Run from the project checkout

From PowerShell:

```powershell
cd C:\Path\To\CommandCenter
npm ci
.\client\command-center-relay.cmd `
  --relay-url wss://your-command-center.example/commandcenter/relay/v1/device `
  --pairing-secret-stdin `
  --device-name "Epic Windows Hermes"
```

Pipe the one-time pairing secret into stdin through an operator-controlled channel. The client consumes it only for enrollment and never writes it to disk. For a stored credential reconnect, omit `--pairing-secret-stdin`; the client loads its protected credential file automatically.

The default credential file is:

```text
%LOCALAPPDATA%\CommandCenter\relay-device.json
```

On Windows the credential value is protected with the current user’s DPAPI key. The file contains only the relay URL, device ID, schema metadata, and the DPAPI-protected credential blob.

Hermes is resolved from `PATH` as `hermes`. Use `--hermes-bin` when the executable is elsewhere. The client keeps each Hermes profile ID for routing, and reads the profile's `SOUL.md` when available so the dashboard can display the agent's actual name (for example, `default` routes as `hermes:default` but displays as `Reika`). `--once` is useful for a one-shot enrollment/status smoke test; normal use keeps the client connected and reconnects after transient network loss.

The relay server still owns `ownerId` and `deviceId`. They are never placed in client status payloads.

## Install at Windows logon

Run the installer once from the project checkout. If no credential exists, the client prompts for the one-time pairing secret without echoing it. The installer then registers a per-user scheduled task, starts it immediately, and configures limited restart-on-failure behavior.

```powershell
.\client\install-windows.ps1 `
  -RelayUrl wss://techexplore.us/commandcenter/relay/v1/device `
  -DeviceName "Epic Windows Hermes" `
  -HermesBin "C:\Users\Epic\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe"
```

The task is named `CommandCenter Relay Client`. It contains no pairing secret; it uses the DPAPI-protected credential file at `%LOCALAPPDATA%\CommandCenter\relay-device.json`.
