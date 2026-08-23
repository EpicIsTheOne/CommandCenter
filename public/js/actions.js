// Command Center unified action layer.
// Every user-invokable operation registers here once. The command palette
// (Ctrl+K) and the voice interface both execute THE SAME actions — no
// parallel pile of hardcoded shortcuts. Voice availability is reported
// truthfully via isVoiceAvailable(): actions work by text today; live mic
// recognition reuses the browser SpeechRecognition API when present.
const actions = [];
const listeners = new Set();

function normalize(text = '') {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function registerAction(action) {
  // { id, title, group, keywords, hint?, disabled?, run }
  const existing = actions.findIndex((entry) => entry.id === action.id);
  if (existing >= 0) actions[existing] = action;
  else actions.push(action);
  for (const listener of listeners) {
    try { listener({ type: 'registry-changed' }); } catch {}
  }
}

export function listActions() {
  return actions.filter((action) => !action.disabled).map((action) => ({ ...action }));
}

export function searchActions(query = '') {
  const needle = normalize(query);
  if (!needle) return listActions();
  const terms = needle.split(' ');
  return listActions()
    .map((action) => {
      const haystack = normalize([action.title, action.group, ...(action.keywords || []), action.hint || ''].join(' '));
      let score = 0;
      for (const term of terms) {
        if (!haystack.includes(term)) return null;
        if (normalize(action.title).startsWith(term)) score += 10;
        else if (normalize(action.title).includes(term)) score += 5;
        else score += 1;
      }
      return { ...action, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

export async function runAction(actionId, arg) {
  const action = actions.find((entry) => entry.id === actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);
  if (action.disabled) throw new Error(`Action unavailable: ${action.title}`);
  return action.run(arg);
}

// Natural-language dispatch used by the voice path: matches an utterance to
// the best-scoring action whose keywords hit, then runs it. Returns the
// outcome so a voice UI can speak it honestly.
export async function interpretUtterance(utterance = '') {
  const cleaned = normalize(utterance).replace(/^(hey |ok |okay )?(command center|computer)[,\s]+/, '');
  const results = searchActions(cleaned);
  if (!results.length) return { matched: false, reason: `No action matches "${cleaned}".` };
  const best = results[0];
  try {
    await best.run({ utterance: cleaned });
    return { matched: true, action: best.id, title: best.title };
  } catch (error) {
    return { matched: true, action: best.id, error: error.message };
  }
}

// Truthful capability boundary: text-driven voice actions always work through
// the palette/utterance path; live microphone recognition needs Web Speech.
export function isVoiceAvailable() {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}
