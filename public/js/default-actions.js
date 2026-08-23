// Default action registry. Imported as a side-effect module so actions exist
// as soon as the app bundle loads — independent of the host bootstrap order
// and of the auth gate. Voice and palette both consume these.
import { registerAction, isVoiceAvailable } from './actions.js';
import * as ops from './ops.js';

function showPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const currentlyHidden = panel.classList.contains('hidden');
  // Toggle behavior: clicking the same surface twice closes it again.
  panel.classList.toggle('hidden');
  const toggle = document.getElementById('ops-panel-toggle');
  if (toggle && panelId === 'ops-spaces-panel') toggle.setAttribute('aria-expanded', String(currentlyHidden));
}

export function registerDefaultActions({ ops } = {}) {
  if (!ops) return;
  registerAction({ id: 'mode.2d', title: 'Switch to 2D view', group: 'View', keywords: ['2d', 'office', 'flat', 'workspace', 'view'], hint: 'display mode', run: () => ops.setMode('2d') });
  registerAction({ id: 'mode.3d', title: 'Switch to 3D space', group: 'View', keywords: ['3d', 'space', 'immersive', 'view'], hint: 'display mode', run: () => ops.setMode('3d') });
  registerAction({ id: 'ops.togglePanel', title: 'Toggle Spaces panel', group: 'Operations', keywords: ['spaces', 'operations', 'panel', 'ops'], run: () => showPanel('ops-spaces-panel') });
  registerAction({ id: 'ops.tabAgents', title: 'Show agents tab', group: 'Operations', keywords: ['agents', 'tab', 'roster'], run: () => { showPanel('ops-spaces-panel'); ops.setTab('agents'); } });
  registerAction({ id: 'ops.tabTasks', title: 'Show tasks tab', group: 'Operations', keywords: ['tasks', 'tab'], run: () => { showPanel('ops-spaces-panel'); ops.setTab('tasks'); } });
  registerAction({ id: 'ops.tabMachines', title: 'Show machines tab', group: 'Operations', keywords: ['machines', 'tab', 'servers', 'health', 'cpu'], run: () => { showPanel('ops-spaces-panel'); ops.setTab('machines'); } });
  registerAction({ id: 'ops.tabHarnesses', title: 'Show harnesses tab', group: 'Operations', keywords: ['harnesses', 'tab', 'providers', 'hermes'], run: () => { showPanel('ops-spaces-panel'); ops.setTab('harnesses'); } });
  registerAction({ id: 'ops.refresh', title: 'Refresh live state', group: 'Operations', keywords: ['refresh', 'reload', 'sync', 'overview', 'status'], run: async () => { await ops.refreshOverview({ force: true }); } });
  registerAction({
    id: 'voice.status',
    title: 'What can voice control right now?',
    group: 'Voice',
    keywords: ['voice', 'microphone', 'speech', 'control'],
    hint: isVoiceAvailable() ? 'mic recognition available' : 'text-driven here',
    run: async () => {
      const available = isVoiceAvailable();
      return available
        ? 'Live mic recognition is available in this browser; palette actions are reachable by voice through the shared action layer.'
        : 'This browser has no SpeechRecognition API, so voice actions run as typed text via the command palette (Ctrl+K).';
    },
  });
}

// Self-register on module load — the palette must have actions before the
// host app's main() finishes (which can stall behind the auth gate).
if (typeof window !== 'undefined') {
  registerDefaultActions({ ops });
}
