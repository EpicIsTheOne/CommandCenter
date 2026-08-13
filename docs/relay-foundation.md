# Command Center relay foundation (V1)

The relay foundation is a single-owner, versioned transport for enrolled devices. It is deliberately limited to device presence, heartbeats, roster/activity snapshots, and bounded lifecycle metadata. It does not expose a shell, arbitrary command route, remote action API, or connector adapter.

## Transport and trust boundaries

- Browser control remains on the existing authenticated `/ws` endpoint.
- Devices use the separate authenticated `GET /relay/v1/device` WebSocket endpoint.
- Operator UI calls use `POST /api/relay/v1/pairings`, `GET /api/relay/v1/devices`, and `POST /api/relay/v1/devices/:id/revoke`; these are protected by the existing UI-session middleware.
- V1 has one owner, `owner:default`. The owner is stored with enrollment/device/audit records and added by the server to accepted runtime envelopes. Device payloads cannot select or override it.

## Enrollment

1. The operator creates a short-lived pairing with the UI API.
2. The pairing code is returned once and only its salted hash is persisted.
3. A device opens the device WebSocket and sends a `relay.auth` envelope with `method: pairing`, the code, and bounded device metadata.
4. The server durably consumes the pairing before persisting only a salted credential hash and metadata, then returns the credential once in `relay.auth.ok`. If device persistence fails after consumption, enrollment fails closed and the operator must create a new pairing.
5. Reconnects use `method: credential`; revoked or expired credentials fail closed.

Credentials and pairing codes never appear in URLs, audit records, or normal logs. Sockets and live presence stay in memory; only low-volume device, enrollment, and redacted audit metadata is durable.

## Envelope

Every message is JSON with `v: 1`, a unique `id`, a UTC `timestamp`, a supported `type`, and an object `payload`. Device messages are capped at 64 KiB and validated before state changes. Duplicate message IDs are rejected per live device connection. The server owns `ownerId` and `deviceId` in accepted runtime records.

The dedicated device endpoint accepts authentication, lifecycle (`relay.heartbeat`, `relay.presence`, `relay.disconnect`), snapshots/activity (`device.state.snapshot`, `agent.roster.snapshot`, `agent.activity`), and one narrowly scoped Hermes chat exchange. Chat requests use `relay.chat.request` server-to-device envelopes and devices return `relay.chat.response` with a required correlation ID; both payloads have strict schemas and bounded text. The device may not submit chat requests, command envelopes, or arbitrary actions. Chat execution is fixed to the configured Hermes CLI and selected enrolled Hermes profile; there is no shell or generic command path. Presence is volatile and transitions through connected/online/stale/offline; `stale` is computed after 30 seconds without a heartbeat. Connection replacement closes the older socket. Duplicate message IDs are retained in a bounded per-device replay set, and heartbeat sequence numbers must increase within each authenticated connection epoch; the sequence baseline resets on reconnect.

Authenticated device snapshots are also consumed by the existing dashboard roster through a local volatile bridge. This does not enable or modify the legacy outbound app-relay socket; the dashboard continues using the existing UI and refreshes its roster through the existing `relay:roster_updated` event.
