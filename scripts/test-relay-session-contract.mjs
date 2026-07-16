import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const relaySource = readFileSync(new URL('../server/relay-agent-source.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../server/openclaw-bridge.js', import.meta.url), 'utf8');
const status = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../server/config.js', import.meta.url), 'utf8');
const publicApp = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

assert.match(config, /relayOnlyMode:\s*relayOnlyRequested \|\| reikaEmbeddedRuntime/, 'config should expose relay-only mode flag');
assert.match(config, /reikaEmbeddedRuntime[\s\S]*NODE_ENV[\s\S]*reika-embedded[\s\S]*reikaEmbedToken/, 'Reika embedded authentication/runtime should force relay-only mode');
assert.match(bridge, /if \(config\.relayOnlyMode\) \{\s*console\.log\('\[bridge\] Starting in RELAY-ONLY mode'\);\s*this\.startRelayOnly\(\);/s, 'bridge should start in relay-only mode when configured');
assert.match(bridge, /startRelayOnly\(\) \{[\s\S]*this\.mode = 'relay-only';[\s\S]*relayOnly: true/s, 'relay-only mode should publish coherent status');
assert.match(status, /RELAY_ONLY_MODE_ENABLED/, 'status endpoint should report relay-only mode');
assert.match(publicApp, /relayOnly \? '\[sys\] Connecting to Reika Relay\.\.\.'/, 'relay-only boot log should not claim it is connecting to OpenClaw');
assert.match(publicApp, /bridge\.mode === 'relay-only'[\s\S]*'Relay Connected'/, 'relay-only setup status should be presented coherently');

assert.match(relaySource, /const providerSessionId = cleanText\(metadata\.relayProviderSessionId\);/, 'relay chat should only use stored provider session ids');
assert.doesNotMatch(relaySource, /commandcenter_api_\$\{cleanText\(session\?\.id\)/, 'relay chat must not fabricate provider session ids');
assert.match(relaySource, /\.\.\.\(providerSessionId \? \{ providerSessionId \} : \{\}\),/, 'relay request payload should omit providerSessionId until known');
assert.match(relaySource, /providerSessionId: cleanText\(payload\.providerSessionId\)/, 'relay response parsing should preserve provider session ids for persistence');

console.log('CommandCenter relay session contract passed');
