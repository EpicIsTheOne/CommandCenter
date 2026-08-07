// Centralized graceful shutdown for Command Center.
// Closes the WebSocket server first (so in-flight broadcasts stop), then the
// HTTP server(s), stops the bridge connection, and force-exits only if the
// graceful drain overruns the hard limit. Docker/systemd send SIGTERM; this
// prevents dropping live calls, WebSocket clients, and timers mid-flight.

export function buildShutdown({ server, wss, localApiServer = null, bridge = null, log = console, hardTimeoutMs = 10000 } = {}) {
  let shuttingDown = false;

  async function closeServer(target) {
    if (!target) return;
    return new Promise((resolve) => {
      try {
        target.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async function shutdown(signal = 'SIGTERM') {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`[shutdown] Received ${signal}; draining connections…`);

    // 1. Stop accepting new WS connections and close existing ones.
    if (wss) {
      try { wss.close(); } catch { /* already closing */ }
      for (const client of wss.clients || []) {
        try { client.terminate(); } catch { /* ignore */ }
      }
    }

    // 2. Stop the agent bridge connection if it exposes a stop hook.
    if (bridge && typeof bridge.stop === 'function') {
      try { await bridge.stop(); } catch { /* ignore */ }
    }

    // 3. Close the HTTP listeners (public + optional local API).
    await Promise.all([closeServer(server), closeServer(localApiServer)]);

    log.warn('[shutdown] Drain complete.');
    process.exit(0);
  }

  const hardKill = setTimeout(() => {
    log.error('[shutdown] Graceful drain exceeded hard limit; forcing exit.');
    process.exit(1);
  }, hardTimeoutMs);
  if (typeof hardKill.unref === 'function') hardKill.unref();

  return { shutdown, isShuttingDown: () => shuttingDown, hardKill };
}

export function registerGracefulShutdown(deps = {}) {
  const { shutdown } = buildShutdown(deps);
  const onSignal = (signal) => { shutdown(signal).catch(() => process.exit(1)); };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
  return shutdown;
}
