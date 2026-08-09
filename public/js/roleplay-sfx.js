export async function init() { return true; }
export function configure() {}
export async function playForMessage() { return false; }
export function stop() {}
export function handleVoicePlaybackStart() {}
export function handleVoicePlaybackStop() {}
export function getState() { return { enabled: false, volume: 0, loopTag: '', manifest: { loops: {}, accents: {} } }; }
