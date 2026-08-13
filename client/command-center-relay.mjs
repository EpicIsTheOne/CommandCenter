import { stdin } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CommandCenterRelayClient, FileCredentialStore, defaultCredentialPath } from './relay-client.mjs';

function parseArgs(argv) {
  const options = { relayUrl: process.env.COMMANDCENTER_RELAY_URL || '', hermesBin: process.env.HERMES_BIN || 'hermes', once: false, pairingSecretStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--pairing-secret-stdin') options.pairingSecretStdin = true;
    else if (arg === '--relay-url') options.relayUrl = argv[++index] || '';
    else if (arg === '--device-name') options.deviceName = argv[++index] || '';
    else if (arg === '--device-version') options.deviceVersion = argv[++index] || '';
    else if (arg === '--hermes-bin') options.hermesBin = argv[++index] || '';
    else if (arg === '--credential-file') options.credentialFile = argv[++index] || '';
    else if (arg === '--heartbeat-ms') options.heartbeatMs = Number(argv[++index] || 0);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Command Center Windows relay client',
    '',
    'Usage:',
    '  command-center-relay.cmd --relay-url <ws(s) endpoint> --pairing-secret-stdin',
    '',
    'Options:',
    '  --relay-url <url>          Device endpoint or base URL; query strings are rejected.',
    '  --pairing-secret-stdin     Read the one-time pairing secret from stdin; never persist it.',
    '  --credential-file <path>   Protected local credential file path.',
    '  --device-name <name>       Bounded device display name.',
    '  --hermes-bin <path>        Hermes executable (default: hermes).',
    '  --heartbeat-ms <ms>        Heartbeat interval, minimum 1000 ms.',
    '  --once                     Connect, publish one snapshot, then exit.',
  ].join('\n');
}

async function readPairingSecret() {
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    process.stdout.write('One-time pairing secret: ');
    stdin.setRawMode(true);
    stdin.resume();
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = (chunk) => {
        for (const character of String(chunk)) {
          if (character === '\u0003') {
            cleanup();
            reject(new Error('Pairing input cancelled.'));
          } else if (character === '\r' || character === '\n') {
            cleanup();
            process.stdout.write('\n');
            resolve(value.trim());
          } else if (character === '\b' || character === '\u007f') {
            value = value.slice(0, -1);
          } else {
            value += character;
          }
        }
      };
      const cleanup = () => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
      };
      stdin.on('data', onData);
    });
  }
  let value = '';
  for await (const chunk of stdin) value += String(chunk);
  return value.trim();
}

function waitForEvent(client, eventName) {
  return new Promise((resolve, reject) => {
    const onEvent = (value) => { cleanup(); resolve(value); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      client.off(eventName, onEvent);
      client.off('error', onError);
      client.off('auth-error', onError);
    };
    client.once(eventName, onEvent);
    client.once('error', onError);
    client.once('auth-error', onError);
  });
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.relayUrl) throw new Error('Missing --relay-url or COMMANDCENTER_RELAY_URL.');
  const store = new FileCredentialStore(options.credentialFile || defaultCredentialPath());
  const client = new CommandCenterRelayClient({
    url: options.relayUrl,
    device: {
      name: options.deviceName || 'Command Center Windows Client',
      platform: 'win32',
      type: 'desktop',
      version: options.deviceVersion || undefined,
    },
    credentialStore: store,
    hermesBin: options.hermesBin || 'hermes',
    heartbeatIntervalMs: options.heartbeatMs,
  });

  client.on('authenticated', (info) => {
    const profiles = info.profiles.length ? info.profiles.join(', ') : 'none';
    console.log(`[relay-client] authenticated via ${info.method}; Hermes profiles: ${profiles}`);
  });
  client.on('hermes-error', (info) => console.warn(`[relay-client] Hermes discovery unavailable (${info.code}); continuing with an empty roster.`));
  client.on('disconnected', (info) => console.log(`[relay-client] disconnected (${info.code}).`));
  client.on('error', (error) => console.error(`[relay-client] ${error.code || 'CLIENT_ERROR'}: ${error.message}`));

  let pairingSecret = '';
  const stored = await store.load();
  if (!stored && options.pairingSecretStdin) pairingSecret = await readPairingSecret();
  if (!stored && !pairingSecret) throw new Error('No stored credential and no pairing secret supplied.');

  if (options.once) {
    const stopped = waitForEvent(client, 'stopped');
    await client.start({ pairingSecret, once: true });
    await stopped;
    return 0;
  }

  const stopped = waitForEvent(client, 'stopped');
  await client.start({ pairingSecret, once: false });
  const shutdown = () => client.stop();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await stopped;
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[relay-client] ${error.code || 'CLIENT_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}
