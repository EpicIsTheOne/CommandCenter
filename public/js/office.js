// Canvas office scene with a dynamic OpenClaw agent roster.
// Features: personality wandering, conference huddles, weather ambiance,
// real server health, voice reactions, post-task celebrations, sofa/rest

const PALETTE = {
  floor: '#1A1E2E', floorLine: '#222840', wall: '#141828', wallAccent: '#2D241C',
  desk: '#3A2A1A', deskTop: '#4A3A2A', deskLeg: '#2A1A0A',
  monitorFrame: '#2A2E3A', monitorScreen: '#0D2A0D', monitorGlow: '#CC9933',
  chair: '#2A2A3A', chairSeat: '#3A3A4A',
  plant: '#1A4A2A', plantPot: '#4A3222', plantLeaf: '#5A8A4A',
  whiteboard: '#E8E8E8', whiteboardFrame: '#2D241C',
  coolerBody: '#88AACC', coolerWater: '#44AAFF',
  bookshelfWood: '#4A3222', serverRack: '#1A2030',
  filingCabinet: '#3A3A4A', filingHandle: '#8A8A9A',
  coffeeMachine: '#3A3A3A', coffeeLight: '#CC9933',
  roundTable: '#4A3222', roundTableTop: '#5A4A3A',
  sofa: '#4A3A5A', sofaCushion: '#5A4A6A', sofaArm: '#3A2A4A',
};

const PX = 5;
const BASE = window.__BASE_PATH__ || '';

let canvas, ctx;
let agents = [];
let agentVisuals = {};
let companionRegistry = {};
const codexImageCache = new Map();
const sceneImageCache = new Map();
const OFFICE_ART = {
  defaultBackgroundUrl: `${BASE}/assets/office-art/room-background.png`,
  backgroundUrl: `${BASE}/assets/office-art/room-background.png`,
  deskSheetUrl: `${BASE}/assets/office-art/desk-sheet.png`,
  deskColumns: 1,
  deskRows: 2,
};
let tick = 0;
let highlightedAgent = null;

// External data
let weather = { temp_c: '--', desc: 'Loading...', code: 0 };

function cToF(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return Math.round((n * 9) / 5 + 32);
}
let health = { cpu_pct: 0, mem_pct: 0, disk_pct: 0, temp_c: 0, uptime: 0 };
let weatherFetchTimer = 0;
let healthFetchTimer = 0;

// Clock chime
let lastChimeHour = -1;
let chimeFlashTimer = 0;

// Voice reaction
let voiceReactionTimer = 0;
let voiceReactionTarget = null;

// Post-task celebration
let celebrationAgent = null;
let celebrationTimer = 0;

// Transient action bubbles
let transientBubbles = [];

// Whiteboard kanban tracking
let kanbanTasks = { doing: [], done: [] };
let sessionStats = { exchanges: 0, tasksCompleted: 0, startTime: Date.now() };

// Ambient sound system
let audioCtx = null;
let soundCooldowns = { click: 0, ding: 0, chime: 0 };

// Furniture positions
const FURNITURE = {
  waterCooler:  { xPct: 0.07, yPct: 0.52 },
  bookshelf:    { xPct: 0.93, yPct: 0.48 },
  serverRack:   { xPct: 0.07, yPct: 0.78 },
  coffeeMachine:{ xPct: 0.93, yPct: 0.75 },
  roundTable:   { xPct: 0.50, yPct: 0.62 },
  sofa:         { xPct: 0.50, yPct: 0.88 },
};

function getWanderPrefs(agent) {
  if (agent.isBoss) return { targets: ['waterCooler', 'coffeeMachine', 'sofa'], checkDesks: true };
  const pools = [
    ['serverRack', 'coffeeMachine', 'serverRack', 'sofa'],
    ['bookshelf', 'bookshelf', 'waterCooler', 'sofa'],
    ['waterCooler', 'coffeeMachine', 'bookshelf', 'sofa'],
    ['coffeeMachine', 'serverRack', 'waterCooler', 'sofa'],
  ];
  const n = (agent.id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return { targets: pools[n % pools.length], checkDesks: false };
}

const WANDER_THOUGHTS = {
  waterCooler: ['Hydrating...', 'Water break', 'Staying fresh', 'Tiny hydration arc'],
  bookshelf: ['Browsing docs...', 'Reading up...', 'Research time', 'Found a weird note'],
  serverRack: ['Checking logs...', 'Server OK', 'Uptime check', 'Listening to fans'],
  coffeeMachine: ['Coffee time!', 'Espresso...', 'Fuel up', 'Caffeine protocol'],
  roundTable: ['Team sync', 'Sharing ideas', 'Brainstorming', 'Status update'],
  sofa: ['Quick rest...', 'Power nap', 'Recharging...', 'Taking five', 'Dramatic collapse'],
  checkDesk: ['How\'s it going?', 'Need anything?', 'Looking good', 'Tiny peer review'],
  micro: ['Hmm...', 'Tiny idea', 'Wait.', 'Rerouting...', 'Plotting...', 'Staring at pixels', 'Suspiciously calm'],
};

const MOOD_WEIGHTS = [
  { value: 'focused', weight: 24 },
  { value: 'restless', weight: 20 },
  { value: 'curious', weight: 18 },
  { value: 'social', weight: 14 },
  { value: 'tired', weight: 12 },
  { value: 'chaotic', weight: 7 },
];

const MOOD_MODIFIERS = {
  focused: { noop: 1.45, micro: 1.15, walk: 0.72, checkDesk: 0.85, sofa: 0.75 },
  restless: { noop: 0.55, micro: 0.95, walk: 1.5, checkDesk: 1.05, sofa: 0.75 },
  curious: { noop: 0.78, micro: 1.25, walk: 1.15, bookshelf: 1.75, serverRack: 1.35, checkDesk: 0.9 },
  social: { noop: 0.65, micro: 0.9, walk: 1.05, checkDesk: 1.85, roundTable: 1.3 },
  tired: { noop: 1.35, micro: 0.9, walk: 0.78, sofa: 2.1, coffeeMachine: 1.15 },
  chaotic: { noop: 0.45, micro: 1.6, walk: 1.55, checkDesk: 1.35, sofa: 1.25, coffeeMachine: 1.35, bookshelf: 1.25, serverRack: 1.25 },
};

// Huddle
let huddleState = 'idle';
let huddleTimer = randomHuddleDelay();
let huddleMeetingTimer = 0;
let activeHuddleTopic = null;
let huddleLineTimer = 0;
let huddleLineIndex = 0;
const huddleTopics = [
  { name: 'shipping', lines: ['What ships first?', 'Cut the fluff', 'Tiny PR, fast win', 'Ship it clean'] },
  { name: 'bugs', lines: ['Any weird bugs?', 'Repro or rumor?', 'Logs look spicy', 'Patch then test'] },
  { name: 'design', lines: ['UI feels stiff', 'More breathing room', 'Motion sells it', 'Less clutter'] },
  { name: 'ops', lines: ['Health check?', 'CPU looks fine', 'Watch the bridge', 'Keep it stable'] },
  { name: 'ideas', lines: ['Wild idea...', 'Prototype later', 'Could be useful', 'Save that thought'] },
  { name: 'users', lines: ['What would Epic do?', 'Friction spotted', 'Make it obvious', 'Delight matters'] },
  { name: 'lore', lines: ['Office canon?', 'Tiny gremlin energy', 'Mascot unionizing', 'Absolutely haunted'] },
  { name: 'planning', lines: ['Next tiny step?', 'Blocker check', 'No fake progress', 'Momentum wins'] },
  { name: 'code', lines: ['Refactor bait', 'Name it better', 'Cache is lying', 'Test the edge case'] },
  { name: 'vibes', lines: ['Too predictable', 'Needs chaos', 'Let it breathe', 'Looks alive now'] },
];
let huddleTopicIndex = 0;

// --- Init & Data Fetching ---

function buildAgentsFromRoster(roster = { agents: [], primaryAgentId: 'main' }) {
  const sourceAgents = roster.agents?.length ? roster.agents : [{ id: 'main', label: 'Main', color: '#FFD700', isBoss: true }];
  const count = sourceAgents.length;
  agents = sourceAgents.map((agent, index) => {
    const existing = agents.find((item) => item.id === agent.id);
    const isBoss = !!agent.isBoss || agent.id === roster.primaryAgentId || index === 0;
    let xPct, yPct;
    if (existing) {
      xPct = existing.xPct;
      yPct = existing.yPct;
    } else if (isBoss) {
      const slot = getDeskSlots(count)[0] || { xPct: 0.50, yPct: 0.34 };
      xPct = slot.xPct; yPct = slot.yPct;
    } else {
      const deskSlots = getDeskSlots(Math.max(1, count));
      const subs = sourceAgents.filter(a => a.id !== roster.primaryAgentId && !a.isBoss);
      const subIndex = subs.findIndex(a => a.id === agent.id);
      const slot = deskSlots[Math.max(0, subIndex + 1)] || deskSlots[(Math.max(0, subIndex) % Math.max(1, deskSlots.length - 1)) + 1] || { xPct: 0.50, yPct: 0.62 };
      xPct = slot.xPct;
      yPct = slot.yPct;
    }
    const built = createAgent(agent.id, xPct, yPct, agent.color || '#AA66FF', agent.label || agent.name || agent.id, isBoss);
    if (existing) {
      built.state = existing.state;
      built.wanderState = existing.wanderState;
      built.wanderTarget = existing.wanderTarget;
      built.thoughtText = existing.thoughtText;
      built.celebrating = existing.celebrating;
      built.mood = existing.mood || built.mood;
      built.moodTimer = existing.moodTimer || built.moodTimer;
      built.recentActions = Array.isArray(existing.recentActions) ? existing.recentActions.slice(-5) : [];
      built.microActionTimer = existing.microActionTimer || 0;
      built.codexAmbientState = existing.codexAmbientState || null;
      built.codexAmbientTimer = existing.codexAmbientTimer || 0;
      built.codexAmbientCooldown = existing.codexAmbientCooldown || built.codexAmbientCooldown;
    }
    return built;
  });
}

export function init(canvasId, roster = { agents: [], primaryAgentId: 'main' }) {
  canvas = document.getElementById(canvasId);
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  resize();
  window.addEventListener('resize', resize);
  buildAgentsFromRoster(roster);
  fetchWeather();
  fetchHealth();
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const headerH = canvas.parentElement.querySelector('.zone-header')?.offsetHeight || 24;
  canvas.width = rect.width;
  canvas.height = rect.height - headerH;
}

function createAgent(id, xPct, yPct, color, label, isBoss) {
  const mood = pickMood();
  return {
    id, homeX: xPct, homeY: yPct, xPct, yPct, color, label, isBoss,
    state: 'idle', wanderState: 'at_desk', wanderTarget: null,
    wanderTimer: randomWanderDelay(null, mood), wanderIdleTimer: 0,
    stateTimer: 0, animFrame: 0, thoughtText: '', typingDots: 0,
    walkPhase: 0, facingRight: true, lastMoveDx: 1, lastMoveDy: 0, lookUp: false, celebrating: false,
    mood, moodTimer: randomMoodDuration(), recentActions: [], microActionTimer: 0,
    codexAmbientState: null, codexAmbientTimer: 0, codexAmbientCooldown: rand(3500, 12000),
  };
}

function rand(min, max) { return min + Math.random() * (max - min); }

function chooseWeighted(items = []) {
  const valid = items.filter((item) => Number(item.weight) > 0);
  const total = valid.reduce((sum, item) => sum + Number(item.weight), 0);
  if (!total) return valid[0]?.value;
  let roll = Math.random() * total;
  for (const item of valid) {
    roll -= Number(item.weight);
    if (roll <= 0) return item.value;
  }
  return valid[valid.length - 1]?.value;
}

function pickMood() { return chooseWeighted(MOOD_WEIGHTS) || 'focused'; }
function randomMoodDuration() { return rand(26000, 85000); }
function randomHuddleDelay() { return rand(90000, 210000); }

function randomWanderDelay(agent = null, mood = agent?.mood || 'focused') {
  const roll = Math.random();
  let delay;
  if (roll < 0.18) delay = rand(2200, 6200);
  else if (roll < 0.74) delay = rand(7600, 19000);
  else if (roll < 0.93) delay = rand(21000, 42000);
  else delay = rand(45000, 78000);

  const moodScale = {
    focused: 1.25,
    restless: 0.58,
    curious: 0.86,
    social: 0.78,
    tired: 1.42,
    chaotic: 0.48,
  }[mood] || 1;
  const jitter = rand(0.78, 1.28);
  const perAgent = agent?.id ? 0.9 + (((agent.id.charCodeAt(0) || 7) % 9) / 32) : 1;
  return delay * moodScale * jitter * perAgent;
}

function getDeskSlots(count = 5) {
  return [
    { xPct: 0.50, yPct: 0.34, scale: 1.02 },
    { xPct: 0.27, yPct: 0.57, scale: 0.94 },
    { xPct: 0.73, yPct: 0.57, scale: 0.94 },
    { xPct: 0.36, yPct: 0.78, scale: 1.00 },
    { xPct: 0.64, yPct: 0.78, scale: 1.00 },
    { xPct: 0.16, yPct: 0.73, scale: 0.86 },
    { xPct: 0.84, yPct: 0.73, scale: 0.86 },
  ].slice(0, Math.max(1, Math.min(7, count)));
}

function getSceneImage(url = '') {
  if (!url) return null;
  if (sceneImageCache.has(url)) return sceneImageCache.get(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  sceneImageCache.set(url, img);
  return img;
}

function drawImageCover(img, x, y, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih || !w || !h) return;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  const sx = Math.max(0, (iw - sw) / 2);
  const sy = Math.max(0, (ih - sh) / 2);
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function isAgentActive(agent) {
  return ['thinking', 'working', 'talking', 'responding', 'tool', 'error'].includes(agent?.state || '') || !!agent?.thoughtText;
}


async function fetchWeather() {
  try { const r = await fetch(`${BASE}/api/weather`); if (r.ok) weather = await r.json(); } catch (e) {}
}
async function fetchHealth() {
  try { const r = await fetch(`${BASE}/api/health`); if (r.ok) health = await r.json(); } catch (e) {}
}

// --- Public API ---

export function setRoster(roster = { agents: [], primaryAgentId: 'main' }) {
  buildAgentsFromRoster(roster);
}

export function setAgentVisuals(visuals = {}, items = []) {
  agentVisuals = visuals || {};
  companionRegistry = Object.fromEntries((items || []).map((item) => [item.id, item]));
}

export function setAgentState(agentId, state, data = {}) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return;
  agent.state = state;
  agent.stateTimer = 0;
  agent.thoughtText = data.status || data.message || data.tool || '';
  if (state === 'thinking' || state === 'working') {
    // Kanban: add to doing
    if (!kanbanTasks.doing.find(t => t.agentId === agentId)) {
      kanbanTasks.doing.push({ agentId, label: agent.label, text: agent.thoughtText || state, time: Date.now() });
    }
    if (agent.wanderState !== 'at_desk') { agent.wanderState = 'walking_back'; agent.wanderTarget = null; }
    if (huddleState === 'meeting' || huddleState === 'gathering') huddleState = 'dispersing';
  } else if (state === 'talking') {
    // Kanban: move from doing to done
    const idx = kanbanTasks.doing.findIndex(t => t.agentId === agentId);
    if (idx !== -1) {
      const task = kanbanTasks.doing.splice(idx, 1)[0];
      kanbanTasks.done.push({ ...task, text: truncate(agent.thoughtText || 'done', 8), doneTime: Date.now() });
      sessionStats.tasksCompleted++;
      playTaskDing();
    }
    sessionStats.exchanges++;
    if (kanbanTasks.done.length > 6) kanbanTasks.done.shift();
  }
}

export function getAgentAtPoint(canvasX, canvasY) {
  for (let i = agents.length - 1; i >= 0; i -= 1) {
    const agent = agents[i];
    const ax = agent.xPct * canvas.width;
    const ay = agent.yPct * canvas.height;

    // Match what users can actually tap: sprite body + label area + desk footprint.
    const spriteHalfWidth = PX * 10;
    const spriteTop = ay - PX * 18;
    const spriteBottom = ay + PX * 9;
    const deskHalfWidth = PX * 16;
    const deskTop = ay - PX * 2;
    const deskBottom = ay + PX * 12;

    const inSprite = canvasX >= (ax - spriteHalfWidth)
      && canvasX <= (ax + spriteHalfWidth)
      && canvasY >= spriteTop
      && canvasY <= spriteBottom;

    const inDesk = canvasX >= (ax - deskHalfWidth)
      && canvasX <= (ax + deskHalfWidth)
      && canvasY >= deskTop
      && canvasY <= deskBottom;

    if (inSprite || inDesk) return agent.id;
  }
  return null;
}

export function setAgentHighlight(agentId, on) { highlightedAgent = on ? agentId : null; }

export function setWorkspaceBackground(url = '') {
  OFFICE_ART.backgroundUrl = String(url || '').trim() || OFFICE_ART.defaultBackgroundUrl;
}

// All agents look up when voice recording starts
export function onVoiceStart(targetAgentId) {
  voiceReactionTimer = 1200; // look up for 1.2s
  voiceReactionTarget = targetAgentId;
  for (const a of agents) a.lookUp = true;
}

// Post-task celebration
export function onTaskComplete(agentId) {
  celebrationAgent = agentId;
  celebrationTimer = 2000; // 2s celebration
  const agent = agents.find(a => a.id === agentId);
  if (agent) agent.celebrating = true;
}

export function showTransientBubble(agentId, text, options = {}) {
  if (!agentId || !text) return;
  const pendingForAgent = transientBubbles.filter((bubble) => bubble.agentId === agentId && bubble.age < (bubble.delay || 0) + bubble.duration).length;
  transientBubbles.push({
    agentId,
    text: truncate(String(text).trim(), options.maxLength || 28),
    age: 0,
    delay: options.delay ?? Math.min(540, pendingForAgent * 180),
    duration: options.duration || 1000,
    rise: options.rise || PX * 5,
    color: options.color || '#6EE7FF',
    badge: options.badge || '',
    badgeColor: options.badgeColor || options.color || '#6EE7FF',
  });
  if (transientBubbles.length > 18) transientBubbles = transientBubbles.slice(-18);
}

// --- Update ---

export function update(dt) {
  tick += dt;
  const t = tick / 1000;

  // Fetch timers
  weatherFetchTimer += dt;
  healthFetchTimer += dt;
  if (weatherFetchTimer > 300000) { weatherFetchTimer = 0; fetchWeather(); }
  if (healthFetchTimer > 10000) { healthFetchTimer = 0; fetchHealth(); } // every 10s

  // Sound cooldowns
  for (const key in soundCooldowns) { if (soundCooldowns[key] > 0) soundCooldowns[key] -= dt; }

  // Ambient keyboard clicks when agents are working
  if (agents.some(a => a.state === 'working')) playKeyClick();

  // Clock chime
  const curHour = new Date().getHours();
  if (curHour !== lastChimeHour) {
    lastChimeHour = curHour;
    chimeFlashTimer = 1500; // flash for 1.5s
    playHourChime();
  }
  if (chimeFlashTimer > 0) chimeFlashTimer -= dt;

  // Voice reaction decay
  if (voiceReactionTimer > 0) {
    voiceReactionTimer -= dt;
    if (voiceReactionTimer <= 0) { for (const a of agents) a.lookUp = false; }
  }

  // Celebration decay
  if (celebrationTimer > 0) {
    celebrationTimer -= dt;
    if (celebrationTimer <= 0) {
      for (const a of agents) a.celebrating = false;
      celebrationAgent = null;
    }
  }

  transientBubbles = transientBubbles.filter((bubble) => {
    bubble.age += dt;
    return bubble.age < (bubble.delay || 0) + bubble.duration;
  });

  for (const agent of agents) {
    agent.stateTimer += dt;
    agent.animFrame = Math.floor(t * 4) % 4;
    if (agent.state === 'working') agent.typingDots = Math.floor(t * 8) % 4;
  }

  updateHuddle(dt);
  for (const agent of agents) {
    if (huddleState === 'idle' || huddleState === 'dispersing') updateWander(agent, dt);
  }
}

// --- Huddle ---

function updateHuddle(dt) {
  const allIdle = agents.every(a => a.state === 'idle');
  switch (huddleState) {
    case 'idle':
      if (!allIdle) { huddleTimer = randomHuddleDelay(); return; }
      huddleTimer -= dt;
      if (huddleTimer <= 0) {
        // Only some due huddle rolls actually fire; the rest quietly defer so center talks feel rare.
        if (Math.random() > 0.38) { huddleTimer = randomHuddleDelay(); return; }
        huddleState = 'gathering';
        huddleTopicIndex = Math.floor(Math.random() * huddleTopics.length);
        activeHuddleTopic = huddleTopics[huddleTopicIndex];
        huddleLineIndex = Math.floor(Math.random() * activeHuddleTopic.lines.length);
        huddleLineTimer = 0;
        const seatCount = Math.max(agents.length, 3);
        const seats = Array.from({ length: seatCount }, (_, i) => {
          const angle = (-Math.PI / 2) + (i * (Math.PI * 2 / seatCount));
          return {
            x: FURNITURE.roundTable.xPct + Math.cos(angle) * 0.07,
            y: FURNITURE.roundTable.yPct + Math.sin(angle) * 0.05,
          };
        });
        agents.forEach((a, i) => {
          a.wanderState = 'walking_to'; a.wanderTarget = '__huddle__'; a._huddleSeat = seats[i % seats.length];
          a.thoughtText = WANDER_THOUGHTS.roundTable[Math.floor(Math.random() * WANDER_THOUGHTS.roundTable.length)];
        });
      }
      break;
    case 'gathering': {
      if (!allIdle) { huddleState = 'dispersing'; break; }
      let allArrived = true;
      for (const a of agents) {
        if (a.wanderTarget === '__huddle__' && a._huddleSeat) {
          if (!moveToward(a, a._huddleSeat.x, a._huddleSeat.y, 0.00018, dt)) allArrived = false;
          a.walkPhase += dt * 0.005;
        }
      }
      if (allArrived) {
        huddleState = 'meeting';
        huddleMeetingTimer = rand(4200, 9500);
        huddleLineTimer = 0;
        const lines = activeHuddleTopic?.lines || huddleTopics[huddleTopicIndex]?.lines || WANDER_THOUGHTS.roundTable;
        agents.forEach((a, i) => {
          a.wanderState = 'idle_at_furniture';
          a.thoughtText = lines[(huddleLineIndex + i) % lines.length];
          a.facingRight = a.xPct < FURNITURE.roundTable.xPct;
        });
      }
      break;
    }
    case 'meeting':
      if (!allIdle) { huddleState = 'dispersing'; break; }
      huddleMeetingTimer -= dt;
      huddleLineTimer -= dt;
      if (huddleMeetingTimer > 0 && huddleLineTimer <= 0) {
        const lines = activeHuddleTopic?.lines || huddleTopics[huddleTopicIndex]?.lines || WANDER_THOUGHTS.roundTable;
        huddleLineIndex = (huddleLineIndex + 1 + Math.floor(Math.random() * Math.max(1, lines.length - 1))) % lines.length;
        agents.forEach((a, i) => {
          const offset = Math.random() < 0.35 ? Math.floor(Math.random() * lines.length) : i;
          a.thoughtText = lines[(huddleLineIndex + offset) % lines.length];
        });
        huddleLineTimer = rand(1400, 3400);
      }
      if (huddleMeetingTimer <= 0) huddleState = 'dispersing';
      break;
    case 'dispersing':
      for (const a of agents) { if (a.wanderState !== 'at_desk') { a.wanderState = 'walking_back'; a.wanderTarget = null; a.thoughtText = ''; } }
      if (agents.every(a => a.wanderState === 'at_desk')) {
        huddleState = 'idle';
        huddleTimer = randomHuddleDelay();
        activeHuddleTopic = null;
      }
      for (const a of agents) {
        if (a.wanderState === 'walking_back') {
          if (moveToward(a, a.homeX, a.homeY, 0.00018, dt)) { a.wanderState = 'at_desk'; a.wanderTimer = randomWanderDelay(); a.thoughtText = ''; }
          a.walkPhase += dt * 0.005;
        }
      }
      break;
  }
}

// --- Personality Wandering ---

function rememberAgentAction(agent, action) {
  agent.recentActions = Array.isArray(agent.recentActions) ? agent.recentActions : [];
  agent.recentActions.push(action);
  if (agent.recentActions.length > 6) agent.recentActions.shift();
}

function recentPenalty(agent, action) {
  const recent = Array.isArray(agent.recentActions) ? agent.recentActions : [];
  const repeats = recent.filter((item) => item === action).length;
  if (!repeats) return 1;
  return Math.max(0.16, 1 - repeats * 0.28);
}

function moodWeight(agent, key, fallback = 1) {
  return MOOD_MODIFIERS[agent.mood || 'focused']?.[key] ?? fallback;
}

function getRandomThought(key) {
  const thoughts = WANDER_THOUGHTS[key] || ['...'];
  return thoughts[Math.floor(Math.random() * thoughts.length)];
}

function makeDeskCheckTarget(agent) {
  const others = agents.filter(a => a.id !== agent.id);
  if (!others.length) return null;
  const other = others[Math.floor(Math.random() * others.length)];
  return {
    action: 'checkDesk',
    target: '__desk_' + other.id,
    dest: { x: other.homeX + rand(-0.045, 0.055), y: other.homeY + rand(0.015, 0.055) },
    thought: getRandomThought('checkDesk'),
  };
}

function chooseNextAmbientAction(agent) {
  const prefs = getWanderPrefs(agent);
  const hour = new Date().getHours();
  const choices = [];

  choices.push({ value: { action: 'noop' }, weight: 16 * moodWeight(agent, 'noop') * recentPenalty(agent, 'noop') });
  choices.push({ value: { action: 'micro' }, weight: 13 * moodWeight(agent, 'micro') * recentPenalty(agent, 'micro') });

  for (const target of prefs.targets) {
    const timeBoost =
      target === 'coffeeMachine' && hour >= 7 && hour < 10 ? 1.8 :
      target === 'sofa' && hour >= 14 && hour < 17 ? 1.65 :
      target === 'sofa' && (hour >= 23 || hour < 6) ? 1.55 : 1;
    choices.push({
      value: { action: target, target, thought: getRandomThought(target) },
      weight: 10 * moodWeight(agent, 'walk') * moodWeight(agent, target) * recentPenalty(agent, target) * timeBoost,
    });
  }

  if (prefs.checkDesks || agent.mood === 'social' || agent.mood === 'chaotic') {
    const check = makeDeskCheckTarget(agent);
    if (check) choices.push({ value: check, weight: 8 * moodWeight(agent, 'checkDesk') * recentPenalty(agent, 'checkDesk') });
  }

  if (agent.mood === 'curious' || agent.mood === 'chaotic') {
    choices.push({ value: { action: 'bookshelf', target: 'bookshelf', thought: getRandomThought('bookshelf') }, weight: 5 * recentPenalty(agent, 'bookshelf') });
    choices.push({ value: { action: 'serverRack', target: 'serverRack', thought: getRandomThought('serverRack') }, weight: 5 * recentPenalty(agent, 'serverRack') });
  }

  return chooseWeighted(choices) || { action: 'noop' };
}

function startMicroAction(agent) {
  rememberAgentAction(agent, 'micro');
  agent.thoughtText = Math.random() < 0.68 ? getRandomThought('micro') : '';
  agent.microActionTimer = rand(700, 2600);
  agent.lookUp = Math.random() < 0.28;
  agent.facingRight = Math.random() < 0.5;
  if (Math.random() < 0.42) {
    const driftX = rand(-0.012, 0.012);
    const driftY = rand(-0.006, 0.008);
    agent.xPct = Math.max(0.04, Math.min(0.96, agent.xPct + driftX));
    agent.yPct = Math.max(0.12, Math.min(0.94, agent.yPct + driftY));
  }
}

function finishMicroAction(agent) {
  agent.microActionTimer = 0;
  agent.lookUp = false;
  if (Math.random() < 0.55) {
    agent.wanderState = 'walking_back';
  } else {
    agent.thoughtText = '';
    agent.wanderTimer = randomWanderDelay(agent);
  }
}

function startAmbientWalk(agent, choice) {
  rememberAgentAction(agent, choice.action || choice.target);
  agent.wanderTarget = choice.target;
  agent._checkDeskTarget = choice.dest || null;
  agent.wanderState = 'walking_to';
  agent.thoughtText = choice.thought || getRandomThought(choice.target);
}

function updateAgentMood(agent, dt) {
  agent.moodTimer = (agent.moodTimer || randomMoodDuration()) - dt;
  if (agent.moodTimer <= 0) {
    const previous = agent.mood;
    agent.mood = pickMood();
    if (agent.mood === previous && Math.random() < 0.55) agent.mood = pickMood();
    agent.moodTimer = randomMoodDuration();
  }
}

function updateWander(agent, dt) {
  updateAgentMood(agent, dt);

  if (agent.state !== 'idle') {
    if (agent.wanderState === 'at_desk') return;
    if (agent.wanderState === 'walking_to' || agent.wanderState === 'idle_at_furniture') agent.wanderState = 'walking_back';
  }
  const speedBase = agent.wanderState === 'walking_back' && agent.state !== 'idle' ? 0.00025 : 0.00012;
  const speed = speedBase * (agent.mood === 'restless' ? 1.22 : agent.mood === 'tired' ? 0.82 : agent.mood === 'chaotic' ? 1.12 : 1);

  switch (agent.wanderState) {
    case 'at_desk':
      if (agent.state !== 'idle') { agent.wanderTimer = randomWanderDelay(agent); return; }
      if (agent.microActionTimer > 0) {
        agent.microActionTimer -= dt;
        agent.walkPhase += dt * rand(0.0015, 0.003);
        if (agent.microActionTimer <= 0) finishMicroAction(agent);
        break;
      }
      agent.wanderTimer -= dt;
      if (agent.wanderTimer <= 0) {
        const choice = chooseNextAmbientAction(agent);
        if (choice.action === 'noop') {
          rememberAgentAction(agent, 'noop');
          agent.thoughtText = '';
          agent.wanderTimer = randomWanderDelay(agent);
        } else if (choice.action === 'micro') {
          startMicroAction(agent);
        } else {
          startAmbientWalk(agent, choice);
        }
      }
      break;
    case 'walking_to': {
      let dest;
      if (agent.wanderTarget?.startsWith('__desk_')) {
        dest = agent._checkDeskTarget;
      } else {
        dest = FURNITURE[agent.wanderTarget];
      }
      if (!dest) { agent.wanderState = 'at_desk'; break; }
      if (agent.mood === 'chaotic' && Math.random() < 0.0025) {
        agent.thoughtText = getRandomThought('micro');
        if (Math.random() < 0.45) agent.wanderState = 'walking_back';
        break;
      }
      const arrived = moveToward(agent, dest.xPct || dest.x, dest.yPct || dest.y, speed, dt);
      agent.walkPhase += dt * (agent.mood === 'restless' ? 0.0065 : 0.005);
      if (arrived) {
        agent.wanderState = 'idle_at_furniture';
        agent.wanderIdleTimer = rand(1200, 7600) * (agent.mood === 'tired' && agent.wanderTarget === 'sofa' ? 1.55 : 1);
      }
      break;
    }
    case 'idle_at_furniture':
      agent.wanderIdleTimer -= dt;
      if (agent.wanderIdleTimer > 0 && Math.random() < 0.004) agent.facingRight = !agent.facingRight;
      if (agent.wanderIdleTimer > 0 && Math.random() < 0.003) agent.thoughtText = getRandomThought(agent.wanderTarget || 'micro');
      if (agent.wanderIdleTimer <= 0) { agent.wanderState = 'walking_back'; agent.thoughtText = ''; }
      break;
    case 'walking_back': {
      const arrived = moveToward(agent, agent.homeX, agent.homeY, speed, dt);
      agent.walkPhase += dt * 0.005;
      if (arrived) { agent.wanderState = 'at_desk'; agent.wanderTimer = randomWanderDelay(agent); agent.thoughtText = ''; }
      break;
    }
  }
}

function moveToward(agent, targetX, targetY, speed, dt) {
  const dx = targetX - agent.xPct, dy = targetY - agent.yPct;
  const dist = Math.sqrt(dx * dx + dy * dy);
  agent.lastMoveDx = dx;
  agent.lastMoveDy = dy;
  if (dist < 0.005) { agent.xPct = targetX; agent.yPct = targetY; return true; }
  const step = speed * dt;
  if (step >= dist) { agent.xPct = targetX; agent.yPct = targetY; return true; }
  agent.xPct += (dx / dist) * step; agent.yPct += (dy / dist) * step;
  agent.facingRight = dx > 0;
  return false;
}

// --- Draw ---

export function draw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const isNight = isNightTime();
  drawRoom(isNight);

  // Weather ambiance
  if (weather.code >= 300 && weather.code < 600) drawRainEffect();

  for (const a of agents) drawWorkstation(a);

  drawDigitalClock(); drawWeatherWidget(); drawWhiteboard();

  const sorted = [...agents].sort((a, b) => a.yPct - b.yPct);
  for (const a of sorted) {
    const isWalking = a.wanderState === 'walking_to' || a.wanderState === 'walking_back';
    if (agentVisuals?.[a.id]?.mode === 'companion') drawCompanionAgent(a, { isWalking });
    else if (isWalking) drawWalkingAgent(a);
    else drawAgent(a);
    drawStateIndicator(a);
    drawTransientBubbles(a);
    if (highlightedAgent === a.id) drawHighlight(a);
  }

  // Night overlay
  if (isNight) {
    ctx.fillStyle = 'rgba(0, 0, 20, 0.15)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function isNightTime() {
  const h = new Date().getHours();
  return h < 7 || h >= 21;
}

// --- Room ---

function drawRoom(isNight) {
  const w = canvas.width, h = canvas.height, wallH = h * 0.32;
  const bg = getSceneImage(OFFICE_ART.backgroundUrl);
  if (bg?.complete && bg.naturalWidth) {
    ctx.imageSmoothingEnabled = true;
    drawImageCover(bg, 0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = 'rgba(7, 10, 18, 0.10)';
    ctx.fillRect(0, 0, w, h);
    return;
  }

  ctx.fillStyle = PALETTE.wall; ctx.fillRect(0, 0, w, wallH);
  ctx.fillStyle = PALETTE.wallAccent; ctx.fillRect(0, wallH - PX, w, PX);
  ctx.fillStyle = PALETTE.floor; ctx.fillRect(0, wallH, w, h - wallH);
  ctx.fillStyle = PALETTE.floorLine;
  for (let y = wallH; y < h; y += PX * 8) ctx.fillRect(0, y, w, 1);
  for (let x = 0; x < w; x += PX * 12) ctx.fillRect(x, wallH, 1, h - wallH);

  // Whiteboard frame (content drawn by drawWhiteboard)
  const wbW = PX * 28, wbH = PX * 13, wbX = Math.floor(w * 0.50) - wbW / 2, wbY = PX * 2;
  ctx.fillStyle = PALETTE.whiteboardFrame; ctx.fillRect(wbX - PX, wbY - PX, wbW + PX * 2, wbH + PX * 2);
  ctx.fillStyle = PALETTE.whiteboard; ctx.fillRect(wbX, wbY, wbW, wbH);

  drawPlant(w * 0.16, wallH - PX); drawPlant(w * 0.84, wallH - PX);

  // Ceiling lights (dimmer at night)
  const lightAlpha = isNight ? 0.5 : 1;
  for (const lx of [w * 0.25, w * 0.50, w * 0.75]) {
    ctx.fillStyle = '#2A2E3A'; ctx.fillRect(lx - PX * 2, 0, PX * 4, PX * 2);
    ctx.save(); ctx.globalAlpha = lightAlpha;
    ctx.fillStyle = '#FFEE88'; ctx.fillRect(lx - PX, PX * 2, PX * 2, PX);
    ctx.fillStyle = `rgba(255, 238, 136, ${isNight ? 0.01 : 0.02})`;
    ctx.beginPath(); ctx.moveTo(lx - PX, PX * 3); ctx.lineTo(lx - PX * 12, wallH);
    ctx.lineTo(lx + PX * 12, wallH); ctx.lineTo(lx + PX, PX * 3); ctx.fill();
    ctx.restore();
  }
}

function drawRainEffect() {
  ctx.fillStyle = 'rgba(100, 150, 200, 0.08)';
  const w = canvas.width, h = canvas.height * 0.32;
  for (let i = 0; i < 12; i++) {
    const rx = ((tick / 3 + i * 47) % w);
    const ry = ((tick / 2 + i * 31) % h);
    ctx.fillRect(rx, ry, 1, PX * 2);
  }
}

function drawPlant(x, groundY) {
  ctx.fillStyle = PALETTE.plantPot;
  for (let i = -1; i <= 1; i++) pixel(x + i * PX, groundY - PX * 3, PX);
  for (let i = -2; i <= 2; i++) pixel(x + i * PX, groundY - PX * 2, PX);
  ctx.fillStyle = PALETTE.plantLeaf;
  const sway = Math.sin(tick / 1000 * 0.5) * PX * 0.5;
  pixel(x + sway, groundY - PX * 5, PX); pixel(x - PX + sway, groundY - PX * 4, PX);
  pixel(x + PX + sway, groundY - PX * 4, PX); pixel(x - PX * 2 + sway, groundY - PX * 5, PX);
  pixel(x + PX * 2 + sway, groundY - PX * 5, PX);
  ctx.fillStyle = PALETTE.plant; pixel(x + sway, groundY - PX * 4, PX); pixel(x + sway, groundY - PX * 6, PX);
}

// --- Wall Widgets ---

function drawDigitalClock() {
  const w = canvas.width, x = Math.floor(w * 0.18), y = PX * 3;
  const boxW = PX * 14, boxH = PX * 7;

  ctx.fillStyle = '#1A1E2E'; ctx.fillRect(x - PX, y - PX, boxW + PX * 2, boxH + PX * 2);

  // Chime flash
  const isChiming = chimeFlashTimer > 0;
  ctx.fillStyle = isChiming ? '#002200' : '#0A0E1A';
  ctx.fillRect(x, y, boxW, boxH);

  const now = new Date();
  const hours = now.getHours();
  const h = ((hours + 11) % 12) + 1;
  const hStr = String(h).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const amPm = hours >= 12 ? 'PM' : 'AM';
  const blink = Math.floor(tick / 500) % 2 === 0;

  ctx.fillStyle = isChiming ? '#44FF88' : '#00FF66';
  ctx.font = `bold ${PX * 4.5}px VT323`; ctx.textAlign = 'center';
  ctx.fillText(`${hStr}${blink ? ':' : ' '}${m}`, x + boxW / 2, y + PX * 4.5);
  ctx.fillStyle = '#00CC52'; ctx.font = `${PX * 2}px VT323`;
  ctx.fillText(`${s} ${amPm}`, x + boxW / 2, y + PX * 6.2);

  const days = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  ctx.fillStyle = '#5A6580'; ctx.font = `${PX * 1.5}px VT323`;
  ctx.fillText(`${days[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()}`, x + boxW / 2, y + boxH + PX * 1.5);
  ctx.textAlign = 'start';
}

function drawWeatherWidget() {
  const w = canvas.width, x = Math.floor(w * 0.82) - PX * 7, y = PX * 3;
  const boxW = PX * 14, boxH = PX * 7;

  ctx.fillStyle = '#1A1E2E'; ctx.fillRect(x - PX, y - PX, boxW + PX * 2, boxH + PX * 2);
  ctx.fillStyle = '#0A0E1A'; ctx.fillRect(x, y, boxW, boxH);

  const code = weather.code, cx = x + PX * 3, cy = y + PX * 3;
  if (code >= 200 && code < 300) { drawWeatherCloud(cx, cy, '#888'); ctx.fillStyle = '#FFCC00'; pixel(cx, cy + PX * 1.5, PX * 0.7); }
  else if (code >= 300 && code < 600) { drawWeatherCloud(cx, cy, '#88AACC'); ctx.fillStyle = '#44AAFF'; for (let i = 0; i < 3; i++) pixel(cx - PX + i * PX, cy + PX + ((tick / 300 + i * 0.7) % 2) * PX, PX * 0.5); }
  else if (code >= 800 && code <= 802) { ctx.fillStyle = '#FFCC44'; ctx.beginPath(); ctx.arc(cx, cy, PX * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#FFE066'; for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + tick / 3000; pixel(cx + Math.cos(a) * PX * 2.5, cy + Math.sin(a) * PX * 2.5, PX * 0.5); } }
  else { drawWeatherCloud(cx, cy, '#AABBCC'); }

  ctx.fillStyle = '#00DDFF'; ctx.font = `bold ${PX * 3.5}px VT323`; ctx.textAlign = 'center';
  ctx.fillText(`${cToF(weather.temp_c)}\u00B0F`, x + boxW / 2 + PX * 2, y + PX * 4);
  ctx.fillStyle = '#5A6580'; ctx.font = `${PX * 1.5}px VT323`;
  ctx.fillText((weather.desc || '').slice(0, 10), x + boxW / 2, y + PX * 6);
  ctx.fillText(weather.location || 'Weather', x + boxW / 2, y + boxH + PX * 1.5);
  ctx.textAlign = 'start';
}

function drawWeatherCloud(cx, cy, color) {
  ctx.fillStyle = color;
  pixel(cx - PX, cy - PX * 0.5, PX); pixel(cx, cy - PX, PX); pixel(cx + PX, cy - PX * 0.5, PX);
  pixel(cx - PX * 1.5, cy, PX); pixel(cx - PX * 0.5, cy, PX); pixel(cx + PX * 0.5, cy, PX); pixel(cx + PX * 1.5, cy, PX);
}

function drawWhiteboard() {
  const bg = getSceneImage(OFFICE_ART.backgroundUrl);
  if (bg?.complete && bg.naturalWidth) return;
  const w = canvas.width;
  const wbW = PX * 28, wbH = PX * 13;
  const wbX = Math.floor(w * 0.50) - wbW / 2, wbY = PX * 2;

  // Header
  ctx.fillStyle = '#555';
  ctx.font = `bold ${PX * 1.8}px VT323`; ctx.textAlign = 'center';
  ctx.fillText('TEAM BOARD', wbX + wbW / 2, wbY + PX * 1.8);
  ctx.fillStyle = '#CCCCCC';
  ctx.fillRect(wbX + PX, wbY + PX * 2.2, wbW - PX * 2, 1);

  // 3 kanban columns
  const colW = Math.floor((wbW - PX * 2) / 3);
  const colY = wbY + PX * 3;
  const headers = ['IDLE', 'BUSY', 'DONE'];
  const hColors = ['#2A8A3A', '#CC8800', '#3A3ADA'];
  const stateColors = { idle: '#00FF66', thinking: '#FFCC00', working: '#AA66FF', talking: '#00DDFF' };

  for (let c = 0; c < 3; c++) {
    const cx = wbX + PX + c * colW;
    if (c > 0) { ctx.fillStyle = '#CCCCCC'; ctx.fillRect(cx, colY - PX * 0.5, 1, PX * 7); }
    ctx.fillStyle = hColors[c]; ctx.font = `bold ${PX * 1.3}px VT323`; ctx.textAlign = 'center';
    ctx.fillText(headers[c], cx + colW / 2, colY + PX * 0.3);
  }

  // Column 1: IDLE agents
  const idleAgents = agents.filter(a => a.state === 'idle');
  for (let i = 0; i < idleAgents.length && i < 3; i++) {
    const a = idleAgents[i], cx = wbX + PX + colW / 2, cy = colY + PX * 1.5 + i * PX * 1.6;
    ctx.fillStyle = a.color;
    ctx.beginPath(); ctx.arc(cx - PX * 3, cy, PX * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#444'; ctx.font = `${PX * 1.2}px VT323`; ctx.textAlign = 'left';
    ctx.fillText(a.label, cx - PX * 2, cy + PX * 0.3);
  }

  // Column 2: BUSY agents
  const busyAgents = agents.filter(a => a.state !== 'idle');
  for (let i = 0; i < busyAgents.length && i < 3; i++) {
    const a = busyAgents[i], cx = wbX + PX + colW + colW / 2, cy = colY + PX * 1.5 + i * PX * 1.6;
    ctx.fillStyle = stateColors[a.state] || a.color;
    ctx.beginPath(); ctx.arc(cx - PX * 3, cy, PX * 0.4, 0, Math.PI * 2); ctx.fill();
    // Pulsing dot for active work
    if (a.state === 'working' || a.state === 'thinking') {
      const pulse = 0.3 + Math.sin(tick / 200) * 0.2;
      ctx.save(); ctx.globalAlpha = pulse;
      ctx.beginPath(); ctx.arc(cx - PX * 3, cy, PX * 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#444'; ctx.font = `${PX * 1.2}px VT323`; ctx.textAlign = 'left';
    ctx.fillText(a.label, cx - PX * 2, cy + PX * 0.3);
  }

  // Column 3: DONE (recent completed tasks)
  const recentDone = kanbanTasks.done.slice(-3);
  for (let i = 0; i < recentDone.length; i++) {
    const t = recentDone[i], a = agents.find(ag => ag.id === t.agentId);
    if (!a) continue;
    const cx = wbX + PX + colW * 2 + colW / 2, cy = colY + PX * 1.5 + i * PX * 1.6;
    ctx.fillStyle = a.color;
    ctx.beginPath(); ctx.arc(cx - PX * 3, cy, PX * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2A8A3A'; ctx.font = `bold ${PX * 1.2}px VT323`; ctx.textAlign = 'left';
    ctx.fillText('>', cx - PX * 2, cy + PX * 0.3);
    ctx.fillStyle = '#555'; ctx.font = `${PX * 1.1}px VT323`;
    ctx.fillText(a.label, cx - PX * 0.8, cy + PX * 0.3);
  }

  // Bottom stats bar
  ctx.fillStyle = '#CCCCCC';
  ctx.fillRect(wbX + PX, wbY + wbH - PX * 2.8, wbW - PX * 2, 1);
  const elapsed = Math.floor((Date.now() - sessionStats.startTime) / 60000);
  const hrs = Math.floor(elapsed / 60), mins = elapsed % 60;
  const timeStr = hrs > 0 ? `${hrs}h${String(mins).padStart(2, '0')}m` : `${mins}m`;
  ctx.fillStyle = '#777'; ctx.font = `${PX * 1.2}px VT323`;
  ctx.textAlign = 'left';
  ctx.fillText(`UP ${timeStr}`, wbX + PX * 2, wbY + wbH - PX * 1.2);
  ctx.textAlign = 'right';
  ctx.fillText(`${sessionStats.tasksCompleted} done`, wbX + wbW - PX * 2, wbY + wbH - PX * 1.2);
  ctx.textAlign = 'start';
}

// --- Furniture ---

function drawWaterCooler() {
  const x = Math.floor(canvas.width * FURNITURE.waterCooler.xPct), y = Math.floor(canvas.height * FURNITURE.waterCooler.yPct);
  ctx.fillStyle = PALETTE.coolerBody; ctx.fillRect(x - PX * 2, y - PX * 5, PX * 4, PX * 7);
  ctx.fillStyle = PALETTE.coolerWater; ctx.fillRect(x - PX, y - PX * 8, PX * 2, PX * 3);
  ctx.fillStyle = '#6688AA'; pixel(x - PX, y - PX * 9, PX * 2);
  ctx.fillStyle = '#666'; pixel(x - PX * 2, y + PX * 2, PX); pixel(x + PX, y + PX * 2, PX);
}

function drawBookshelf() {
  const x = Math.floor(canvas.width * FURNITURE.bookshelf.xPct), y = Math.floor(canvas.height * FURNITURE.bookshelf.yPct);
  ctx.fillStyle = PALETTE.bookshelfWood; ctx.fillRect(x - PX * 4, y - PX * 7, PX * 8, PX * 11);
  ctx.fillStyle = '#6A4A2A'; for (let s = 0; s < 3; s++) ctx.fillRect(x - PX * 4, y - PX * 6 + s * PX * 3, PX * 8, PX);
  const bc = ['#FF4466','#44AA66','#4488FF','#FFAA22','#AA44FF','#44DDDD'];
  for (let s = 0; s < 2; s++) for (let b = 0; b < 3; b++) { ctx.fillStyle = bc[(s*3+b)%bc.length]; ctx.fillRect(x-PX*3+b*PX*2, y-PX*5+s*PX*3, PX*1.5, PX*2.5); }
}

function drawServerRack() {
  const x = Math.floor(canvas.width * FURNITURE.serverRack.xPct), y = Math.floor(canvas.height * FURNITURE.serverRack.yPct);
  const rackW = PX * 8, rackH = PX * 14;
  // Rack body
  ctx.fillStyle = PALETTE.serverRack;
  ctx.fillRect(x - rackW / 2, y - rackH + PX * 2, rackW, rackH);
  // Top trim
  ctx.fillStyle = '#3A4050';
  ctx.fillRect(x - rackW / 2, y - rackH + PX * 2, rackW, PX);

  // 3 server slots with real metrics
  const metrics = [health.cpu_pct, health.mem_pct, health.disk_pct];
  const labels = ['CPU', 'MEM', 'DSK'];
  const slotH = PX * 3.5;
  for (let s = 0; s < 3; s++) {
    const slotY = y - rackH + PX * 4 + s * (slotH + PX);
    // Slot background
    ctx.fillStyle = '#141828';
    ctx.fillRect(x - rackW / 2 + PX, slotY, rackW - PX * 2, slotH);

    const pct = metrics[s];
    const ledColor = pct > 85 ? '#FF4444' : pct > 60 ? '#FFAA00' : '#00FF44';

    // LED dot (blinks when critical)
    const blink = pct > 85 && Math.floor(tick / 300) % 2 === 0;
    ctx.fillStyle = blink ? '#441111' : ledColor;
    ctx.beginPath();
    ctx.arc(x - rackW / 2 + PX * 2, slotY + slotH / 2, PX * 0.5, 0, Math.PI * 2);
    ctx.fill();

    // Bar graph
    const barMaxW = rackW - PX * 5;
    const barW = (pct / 100) * barMaxW;
    ctx.fillStyle = ledColor + '44';
    ctx.fillRect(x - rackW / 2 + PX * 3, slotY + PX * 0.5, barMaxW, slotH - PX);
    ctx.fillStyle = ledColor;
    ctx.fillRect(x - rackW / 2 + PX * 3, slotY + PX * 0.5, barW, slotH - PX);

    // Label and percentage
    ctx.fillStyle = '#CCCCCC';
    ctx.font = `${PX * 1.5}px VT323`;
    ctx.fillText(labels[s], x - rackW / 2 + PX * 3.2, slotY + slotH - PX * 0.5);
    ctx.textAlign = 'right';
    ctx.fillStyle = ledColor;
    ctx.fillText(`${pct}%`, x + rackW / 2 - PX * 1.2, slotY + slotH - PX * 0.5);
    ctx.textAlign = 'start';
  }

  // Temperature + uptime at bottom
  ctx.fillStyle = health.temp_c > 70 ? '#FF4444' : '#5A8A5A';
  ctx.font = `${PX * 1.8}px VT323`; ctx.textAlign = 'center';
  ctx.fillText(`${health.temp_c}\u00B0C`, x, y + PX * 3.5);
  // Uptime
  const uptimeH = Math.floor(health.uptime / 3600);
  const uptimeM = Math.floor((health.uptime % 3600) / 60);
  ctx.fillStyle = '#5A6580'; ctx.font = `${PX * 1.3}px VT323`;
  ctx.fillText(`UP ${uptimeH}h${String(uptimeM).padStart(2,'0')}m`, x, y + PX * 5);
  ctx.textAlign = 'start';
}

function drawCoffeeMachine() {
  const x = Math.floor(canvas.width * FURNITURE.coffeeMachine.xPct), y = Math.floor(canvas.height * FURNITURE.coffeeMachine.yPct);
  ctx.fillStyle = PALETTE.coffeeMachine; ctx.fillRect(x - PX * 2, y - PX * 5, PX * 4, PX * 6);
  ctx.fillStyle = '#4A4A4A'; ctx.fillRect(x - PX, y - PX * 7, PX * 2, PX * 2);
  ctx.fillStyle = PALETTE.coffeeLight; pixel(x + PX, y - PX * 4, PX * 0.6);
  ctx.fillStyle = '#222'; ctx.fillRect(x - PX, y - PX, PX * 2, PX * 2);
  if (tick % 3000 < 2000) { ctx.fillStyle = 'rgba(200,200,200,0.25)'; const sy = y - PX * 2 + Math.sin(tick / 200) * PX; pixel(x - PX * 0.5, sy, PX * 0.5); pixel(x + PX * 0.5, sy - PX, PX * 0.5); }
}

function drawFilingCabinet() {
  const x = Math.floor(canvas.width * 0.38), y = Math.floor(canvas.height * 0.42);
  ctx.fillStyle = PALETTE.filingCabinet; ctx.fillRect(x - PX * 2, y - PX * 4, PX * 4, PX * 7);
  for (let d = 0; d < 3; d++) { ctx.fillStyle = '#3A3A4A'; ctx.fillRect(x - PX * 2, y - PX * 3.5 + d * PX * 2, PX * 4, 1); ctx.fillStyle = PALETTE.filingHandle; ctx.fillRect(x - PX * 0.5, y - PX * 3 + d * PX * 2, PX, PX * 0.5); }
}

function drawSofa() {
  const x = Math.floor(canvas.width * FURNITURE.sofa.xPct), y = Math.floor(canvas.height * FURNITURE.sofa.yPct);
  const halfW = PX * 10; // wide enough for 3 agents
  // Arms
  ctx.fillStyle = PALETTE.sofaArm;
  ctx.fillRect(x - halfW - PX * 2, y - PX * 3, PX * 2, PX * 4);
  ctx.fillRect(x + halfW, y - PX * 3, PX * 2, PX * 4);
  // Seat
  ctx.fillStyle = PALETTE.sofa;
  ctx.fillRect(x - halfW, y - PX * 2, halfW * 2, PX * 3);
  // 3 cushions (one per agent)
  ctx.fillStyle = PALETTE.sofaCushion;
  for (let i = 0; i < 3; i++) {
    const cx = x - halfW + PX + i * (halfW * 2 / 3);
    ctx.fillRect(cx, y - PX * 3.5, halfW * 2 / 3 - PX, PX * 2);
  }
  // Back
  ctx.fillStyle = PALETTE.sofaArm;
  ctx.fillRect(x - halfW, y - PX * 4.5, halfW * 2, PX * 1.5);
  // Legs
  ctx.fillStyle = '#333';
  pixel(x - halfW - PX, y + PX, PX); pixel(x + halfW, y + PX, PX);
  // Label
  ctx.fillStyle = '#5A6580'; ctx.font = `${PX * 1.5}px VT323`; ctx.textAlign = 'center';
  ctx.fillText('LOUNGE', x, y + PX * 3.5);
  ctx.textAlign = 'start';
}

function drawRoundTable() {
  const x = Math.floor(canvas.width * FURNITURE.roundTable.xPct), y = Math.floor(canvas.height * FURNITURE.roundTable.yPct);
  ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.beginPath(); ctx.ellipse(x, y + PX * 2, PX * 7, PX * 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = PALETTE.roundTable; ctx.fillRect(x - PX, y - PX, PX * 2, PX * 3);
  ctx.fillStyle = PALETTE.roundTableTop; ctx.beginPath(); ctx.ellipse(x, y - PX, PX * 7, PX * 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = PALETTE.roundTable; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#EEEECC'; ctx.fillRect(x - PX * 2, y - PX * 2, PX * 2, PX * 1.5);
  ctx.fillStyle = '#E8D0B0'; pixel(x + PX * 2, y - PX * 2, PX * 0.8);
  if (huddleState === 'meeting') { const p = 0.4 + Math.sin(tick / 300) * 0.2; ctx.save(); ctx.globalAlpha = p; ctx.strokeStyle = '#FFCC00'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, y - PX, PX * 8, PX * 4, 0, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
}

// --- Workstation ---

function drawWorkstation(agent) {
  const sheet = getSceneImage(OFFICE_ART.deskSheetUrl);
  const x = Math.floor(canvas.width * agent.homeX);
  const y = Math.floor(canvas.height * agent.homeY);

  if (sheet?.complete && sheet.naturalWidth) {
    const active = isAgentActive(agent);
    const frameW = Math.floor(sheet.naturalWidth / OFFICE_ART.deskColumns);
    const frameH = Math.floor(sheet.naturalHeight / OFFICE_ART.deskRows);
    const sx = 0;
    const sy = active ? frameH : 0;
    const slot = getDeskSlots(agents.length).find((item) => Math.abs(item.xPct - agent.homeX) < 0.01 && Math.abs(item.yPct - agent.homeY) < 0.01);
    const baseScale = (slot?.scale || 0.95) * (agent.isBoss ? 1.04 : 0.92);
    const drawW = Math.min(canvas.width * 0.30, frameW * (canvas.width / 1653) * 0.38 * baseScale);
    const drawH = drawW * (frameH / frameW);
    const dx = x - drawW / 2;
    const dy = y - drawH * 0.64;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(x, y + drawH * 0.14, drawW * 0.34, drawH * 0.10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.drawImage(sheet, sx, sy, frameW, frameH, dx, dy, drawW, drawH);
    ctx.restore();
    ctx.imageSmoothingEnabled = false;
    return;
  }

  const isBoss = agent.isBoss, deskW = isBoss ? PX * 16 : PX * 12, deskH = PX * 4;
  const dx = x - deskW / 2, dy = y - PX * 2;
  ctx.fillStyle = PALETTE.deskTop; ctx.fillRect(dx, dy, deskW, PX * 2);
  ctx.fillStyle = PALETTE.desk; ctx.fillRect(dx, dy + PX * 2, deskW, deskH - PX * 2);
  ctx.fillStyle = PALETTE.deskLeg; ctx.fillRect(dx + PX, dy + deskH, PX, PX * 2); ctx.fillRect(dx + deskW - PX * 2, dy + deskH, PX, PX * 2);

  if (isBoss) {
    for (const offset of [-PX * 4, PX * 1]) { const mW = PX * 6, mH = PX * 4, mx = x + offset, my = dy - mH - PX; ctx.fillStyle = PALETTE.monitorFrame; ctx.fillRect(mx - PX, my - PX, mW + PX * 2, mH + PX * 2); ctx.fillStyle = PALETTE.monitorScreen; ctx.fillRect(mx, my, mW, mH); drawScreenContent(mx, my, mW, mH, agent); }
    ctx.fillStyle = PALETTE.monitorFrame; ctx.fillRect(x - PX * 2, dy - PX, PX * 2, PX); ctx.fillRect(x + PX * 2, dy - PX, PX * 2, PX);
    ctx.fillStyle = '#FFD700'; ctx.fillRect(x - PX * 3, dy - PX * 8, PX * 6, PX * 1.5);
    ctx.fillStyle = '#0A0E1A'; ctx.font = `${PX * 1.5}px VT323`; ctx.textAlign = 'center'; ctx.fillText('JANSKY', x, dy - PX * 6.8); ctx.textAlign = 'start';
  } else {
    const mW = PX * 7, mH = PX * 5, mx = x - mW / 2, my = dy - mH - PX;
    ctx.fillStyle = PALETTE.monitorFrame; ctx.fillRect(x - PX, dy - PX, PX * 2, PX); ctx.fillRect(mx - PX, my - PX, mW + PX * 2, mH + PX * 2);
    ctx.fillStyle = PALETTE.monitorScreen; ctx.fillRect(mx, my, mW, mH); drawScreenContent(mx, my, mW, mH, agent);
  }
  const cX = x - PX * 2, cY = dy + deskH + PX;
  ctx.fillStyle = PALETTE.chairSeat; ctx.fillRect(cX, cY, PX * 5, PX * 2);
  ctx.fillStyle = PALETTE.chair; ctx.fillRect(cX + PX, cY + PX * 2, PX * 3, PX);
  ctx.fillRect(cX, cY - PX * 3, PX, PX * 3); ctx.fillRect(cX + PX * 4, cY - PX * 3, PX, PX * 3); ctx.fillRect(cX, cY - PX * 3, PX * 5, PX);
  ctx.fillStyle = '#E8E0D0'; pixel(dx + deskW - PX * 3, dy - PX, PX); pixel(dx + deskW - PX * 3, dy - PX * 2, PX);
}

function drawScreenContent(mx, my, w, h, agent) {
  const t = tick / 1000;
  switch (agent.state) {
    case 'idle': if (Math.floor(t * 2) % 2 === 0) { ctx.fillStyle = PALETTE.monitorGlow; pixel(mx + PX, my + PX, PX); } break;
    case 'thinking': ctx.fillStyle = agent.color; for (let i = 0; i < 3; i++) pixel(mx + PX * (1 + i * 2), my + PX + ((Math.floor(t * 3) + i) % 4) * PX, PX); break;
    case 'working': ctx.fillStyle = PALETTE.monitorGlow; for (let r = 0; r < 3; r++) ctx.fillRect(mx + PX + (r % 2) * PX, my + PX * (r + 1), PX * (2 + ((r + Math.floor(t * 2)) % 3)), 1); break;
    case 'talking': ctx.fillStyle = agent.color; for (let i = 0; i < 4; i++) { const bH = PX * (1 + Math.abs(Math.sin(t * 6 + i)) * 2); ctx.fillRect(mx + PX * (1 + i), my + h - PX - bH, PX * 0.8, bH); } break;
  }
}

// --- Agent Drawing ---

function getCodexImage(url = '') {
  if (!url) return null;
  if (codexImageCache.has(url)) return codexImageCache.get(url);
  const img = new Image();
  img.decoding = 'async';
  img.onerror = () => { img._failed = true; };
  img.src = url;
  codexImageCache.set(url, img);
  return img;
}

function getCodexDirectionKey(agent) {
  const vx = Number(agent.lastMoveDx || 0);
  const vy = Number(agent.lastMoveDy || 0);
  if (Math.abs(vx) >= Math.abs(vy)) return vx >= 0 ? 'runningRight' : 'runningLeft';
  return vy >= 0 ? 'walkDown' : 'walkUp';
}

function getCodexRowsForState(pet = {}, state = 'idle', { isWalking = false, directionKey = '' } = {}) {
  const stateMap = pet.animationMap || {};
  if (isWalking) {
    if (directionKey === 'runningLeft') return stateMap.runningLeft || stateMap['running-left'] || stateMap.walkLeft || stateMap.running || stateMap.run || [2];
    if (directionKey === 'walkUp') return stateMap.walkUp || stateMap.runningRight || stateMap['running-right'] || stateMap.walkRight || stateMap.walking || stateMap.running || stateMap.run || [1];
    if (directionKey === 'walkDown') return stateMap.walkDown || stateMap.runningRight || stateMap['running-right'] || stateMap.walkRight || stateMap.walking || stateMap.running || stateMap.run || [1];
    return stateMap.runningRight || stateMap['running-right'] || stateMap.walkRight || stateMap.walking || stateMap.running || stateMap.run || [1];
  }
  if (state === 'waiting') return stateMap.waiting || stateMap.thinking || [6];
  if (state === 'review') return stateMap.review || stateMap.tool || stateMap.waiting || [8];
  if (state === 'waving') return stateMap.waving || stateMap.wave || stateMap.responding || [3];
  if (state === 'jumping') return stateMap.jumping || stateMap.jump || stateMap.waving || stateMap.wave || [4];
  if (state === 'failed') return stateMap.failed || stateMap.error || [5];
  if (state === 'thinking') return stateMap.thinking || stateMap.waiting || [6];
  if (state === 'talking') return stateMap.responding || stateMap.waving || stateMap.wave || [3];
  if (state === 'working') return stateMap.tool || stateMap.review || stateMap.running || stateMap.run || [7];
  if (state === 'error') return stateMap.error || stateMap.failed || [5];
  return stateMap.idle || [0];
}

function getStableCodexRowForState(pet = {}, state = 'idle', options = {}) {
  const rows = getCodexRowsForState(pet, state, options);
  return Array.isArray(rows) && rows.length ? Number(rows[0]) || 0 : 0;
}

const CODEX_FRAME_FALLBACKS = {
  idle: 6,
  thinking: 6,
  waiting: 6,
  responding: 4,
  waving: 4,
  wave: 4,
  jumping: 5,
  failed: 8,
  error: 8,
  tool: 6,
  running: 6,
  run: 6,
  moving: 6,
  review: 6,
  runningRight: 8,
  runningLeft: 8,
  walkRight: 8,
  walkLeft: 8,
  'running-right': 8,
  'running-left': 8,
  walkUp: 6,
  walkDown: 6,
};

function getCodexFrameCountForState(pet = {}, state = 'idle', columns = 8, { isWalking = false, directionKey = '' } = {}) {
  const safeColumns = Math.max(1, Math.floor(Number(columns) || 1));
  const frameCounts = pet.frameCounts || pet.animationMap?.frameCounts || {};
  const keys = isWalking ? [directionKey, directionKey === 'runningRight' ? 'running-right' : directionKey === 'runningLeft' ? 'running-left' : '', 'walking', 'running', 'run', state] : [state];
  for (const key of keys) {
    const count = Number(frameCounts?.[key] || 0);
    if (Number.isFinite(count) && count > 0) return Math.max(1, Math.min(safeColumns, Math.floor(count)));
  }
  for (const key of keys) {
    if (CODEX_FRAME_FALLBACKS[key]) return Math.max(1, Math.min(safeColumns, CODEX_FRAME_FALLBACKS[key]));
  }
  return Math.max(1, Math.min(safeColumns, CODEX_FRAME_FALLBACKS[state] || safeColumns));
}

function getCodexSheetLayout(pet = {}, img) {
  const declaredRows = Math.max(1, Math.floor(Number(pet.rows || 9) || 9));
  const declaredColumns = Math.max(1, Math.floor(Number(pet.columns || 8) || 8));
  const naturalWidth = Math.max(1, Math.floor(Number(img?.naturalWidth || img?.width || 0) || 0));
  const naturalHeight = Math.max(1, Math.floor(Number(img?.naturalHeight || img?.height || 0) || 0));
  const frameWidth = Math.max(1, Math.floor(Number(pet.frameWidth || pet.spriteWidth || 0) || (naturalWidth / declaredColumns)));
  const frameHeight = Math.max(1, Math.floor(Number(pet.frameHeight || pet.spriteHeight || 0) || (naturalHeight / declaredRows)));
  const actualColumns = Math.max(1, Math.floor(naturalWidth / frameWidth));
  const actualRows = Math.max(1, Math.floor(naturalHeight / frameHeight));
  return { frameWidth, frameHeight, columns: Math.min(declaredColumns, actualColumns), rows: Math.min(declaredRows, actualRows), actualColumns, actualRows, naturalWidth, naturalHeight };
}

function getValidCodexRowForState(pet = {}, state = 'idle', maxRows = 1, options = {}) {
  const rows = getCodexRowsForState(pet, state, options);
  const valid = (Array.isArray(rows) ? rows : [rows])
    .map((row) => Math.floor(Number(row)))
    .find((row) => Number.isFinite(row) && row >= 0 && row < maxRows);
  if (Number.isFinite(valid)) return valid;
  const idleRows = getCodexRowsForState(pet, 'idle', { ...options, isWalking: false, directionKey: '' });
  const idle = (Array.isArray(idleRows) ? idleRows : [idleRows])
    .map((row) => Math.floor(Number(row)))
    .find((row) => Number.isFinite(row) && row >= 0 && row < maxRows);
  return Number.isFinite(idle) ? idle : 0;
}

function isValidCodexSourceRect(img, sx, sy, sw, sh) {
  return img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0
    && sw > 0 && sh > 0 && sx >= 0 && sy >= 0
    && sx + sw <= img.naturalWidth && sy + sh <= img.naturalHeight;
}

function isCodexFrameVisible(img, sx, sy, sw, sh) {
  if (!isValidCodexSourceRect(img, sx, sy, sw, sh)) return false;
  const key = `${sx},${sy},${sw},${sh}`;
  img._codexFrameVisibility ||= new Map();
  if (img._codexFrameVisibility.has(key)) return img._codexFrameVisibility.get(key);

  let visible = true;
  try {
    const sample = img._codexSampleCanvas || document.createElement('canvas');
    img._codexSampleCanvas = sample;
    const sampleW = Math.min(32, Math.max(1, Math.floor(sw)));
    const sampleH = Math.min(32, Math.max(1, Math.floor(sh)));
    sample.width = sampleW;
    sample.height = sampleH;
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
    sampleCtx.clearRect(0, 0, sampleW, sampleH);
    sampleCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
    const data = sampleCtx.getImageData(0, 0, sampleW, sampleH).data;
    let opaquePixels = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 12) opaquePixels += 1;
      if (opaquePixels >= 8) break;
    }
    visible = opaquePixels >= 8;
  } catch {
    visible = true;
  }

  img._codexFrameVisibility.set(key, visible);
  return visible;
}

function getVisibleCodexFrame(img, layout, row, preferredFrame, frameCount) {
  const safeFrameCount = Math.max(1, Math.floor(Number(frameCount) || 1));
  const start = Math.max(0, Math.floor(Number(preferredFrame) || 0)) % safeFrameCount;
  for (let offset = 0; offset < safeFrameCount; offset += 1) {
    const frame = (start + offset) % safeFrameCount;
    const sx = frame * layout.frameWidth;
    const sy = row * layout.frameHeight;
    if (isCodexFrameVisible(img, sx, sy, layout.frameWidth, layout.frameHeight)) return frame;
  }
  return -1;
}

function getCodexAmbientState(agent, pet, isWalking = false) {
  if (isWalking || agent.state !== 'idle' || huddleState !== 'idle') {
    agent.codexAmbientState = null;
    agent.codexAmbientTimer = 0;
    return agent.state;
  }

  if (agent.codexAmbientTimer > 0 && agent.codexAmbientState) return agent.codexAmbientState;
  agent.codexAmbientCooldown = Math.max(0, (agent.codexAmbientCooldown || 0) - 16);
  if (agent.codexAmbientCooldown > 0) return agent.state;

  const stateMap = pet.animationMap || {};
  const options = [
    { value: 'waiting', weight: stateMap.waiting ? 12 : 4 },
    { value: 'review', weight: stateMap.review ? 9 : 3 },
    { value: 'waving', weight: (stateMap.waving || stateMap.wave || stateMap.responding) ? 7 : 2 },
    { value: 'jumping', weight: (stateMap.jumping || stateMap.jump) ? 6 : 2 },
    { value: 'failed', weight: (stateMap.failed || stateMap.error) ? 4 : 1 },
  ];
  const next = chooseWeighted(options);
  agent.codexAmbientState = next;
  agent.codexAmbientTimer = rand(900, next === 'failed' ? 1700 : 3200);
  agent.codexAmbientCooldown = rand(6500, 24000) * (agent.mood === 'chaotic' ? 0.65 : agent.mood === 'focused' ? 1.35 : 1);
  return next || agent.state;
}

function drawCodexImportedAgent(agent, companion, { isWalking = false, scale: visualScale = 1 } = {}) {
  const pet = companion?.importedPet || {};
  if (!pet?.spritesheetUrl) return drawAgent(agent);
  const img = getCodexImage(pet.spritesheetUrl);
  if (!img?.complete || !img.naturalWidth) return drawAgent(agent);

  if (agent.codexAmbientTimer > 0) agent.codexAmbientTimer = Math.max(0, agent.codexAmbientTimer - 16);
  const directionKey = isWalking ? getCodexDirectionKey(agent) : '';
  const baseState = isWalking ? (directionKey || 'runningRight') : getCodexAmbientState(agent, pet, isWalking);
  const renderState = isWalking ? (directionKey || 'runningRight') : baseState;
  const layout = getCodexSheetLayout(pet, img);
  const row = getValidCodexRowForState(pet, renderState, layout.actualRows, { isWalking, directionKey });
  const frameCount = getCodexFrameCountForState(pet, renderState, layout.actualColumns, { isWalking, directionKey });
  const preferredFrame = Math.abs(Math.floor(tick / (isWalking ? 95 : 260))) % frameCount;
  const frame = getVisibleCodexFrame(img, layout, row, preferredFrame, frameCount);
  if (frame < 0) return drawAgent(agent);
  const sx = frame * layout.frameWidth;
  const sy = row * layout.frameHeight;

  const x = Math.floor(canvas.width * agent.xPct);
  const y = Math.floor(canvas.height * agent.yPct);
  const sizeScale = Math.min(2, Math.max(0.45, Number(visualScale || 1) || 1));
  const targetHeight = PX * 24 * sizeScale;
  const scale = targetHeight / layout.frameHeight;
  const drawWidth = Math.floor(layout.frameWidth * scale);
  const drawHeight = Math.floor(layout.frameHeight * scale);
  const dx = Math.floor(x - drawWidth / 2);
  const artYOffset = PX * 5;
  const dy = Math.floor(y - drawHeight * 0.72 + artYOffset);

  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(x, y + PX * 4.8 + artYOffset, PX * 4.6, PX * 1.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.drawImage(img, sx, sy, layout.frameWidth, layout.frameHeight, dx, dy, drawWidth, drawHeight);
  ctx.fillStyle = agent.color; ctx.font = `${PX * 3}px VT323`; ctx.textAlign = 'center';
  ctx.fillText(agent.label.toUpperCase(), x, y + PX * 8 + artYOffset); ctx.textAlign = 'start';
}

function drawCompanionAgent(agent, options = {}) {
  const visual = agentVisuals?.[agent.id];
  const companion = companionRegistry?.[visual?.companionId] || visual?.companion || null;
  if (!companion) return drawAgent(agent);
  if (companion?.sourceType === 'codex-import' && companion?.importedPet?.spritesheetUrl) {
    return drawCodexImportedAgent(agent, companion, { ...options, scale: visual?.scale || 1 });
  }
  const x = Math.floor(canvas.width * agent.xPct), y = Math.floor(canvas.height * agent.yPct);
  const t = tick / 1000;
  const palette = companion.palette || { primary: agent.color, secondary: darken(agent.color, 0.5), accent: '#7ee7ff' };
  const sizeScale = Math.min(2, Math.max(0.45, Number(visual?.scale || 1) || 1));
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sizeScale, sizeScale);
  ctx.translate(-x, -y);
  const bob = agent.state === 'idle' ? Math.sin(t * 1.8) * PX * 0.5 : agent.state === 'talking' ? Math.sin(t * 7) * PX * 0.25 : 0;
  const ax = x, ay = y + PX * 4 + bob;
  const headOffset = agent.lookUp ? -PX : 0;

  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(ax, ay + PX * 5.5, PX * 4.2, PX * 1.5, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f2cfb4';
  drawPixelPattern([' XXXX ','XXXXXX','XXXXXX',' XXXX '], ax - PX * 3, ay - PX * 7 + headOffset, PX);
  ctx.fillStyle = palette.primary || agent.color;
  pixel(ax - PX * 2, ay - PX * 8 + headOffset, PX);
  pixel(ax - PX, ay - PX * 8 + headOffset, PX);
  pixel(ax, ay - PX * 8 + headOffset, PX);
  pixel(ax + PX, ay - PX * 8 + headOffset, PX);
  pixel(ax + PX * 2, ay - PX * 8 + headOffset, PX);

  ctx.fillStyle = '#111';
  if (agent.state === 'thinking') {
    pixel(ax - PX * 1.5, ay - PX * 5 + headOffset, PX); pixel(ax + PX * 0.5, ay - PX * 5 + headOffset, PX);
  } else if (agent.state === 'error') {
    ctx.fillStyle = '#FF4466';
    pixel(ax - PX * 1.5, ay - PX * 5 + headOffset, PX); pixel(ax + PX * 0.5, ay - PX * 5 + headOffset, PX);
  } else {
    pixel(ax - PX * 1.5, ay - PX * 5 + headOffset, PX * 0.7); pixel(ax + PX, ay - PX * 5 + headOffset, PX * 0.7);
  }

  ctx.fillStyle = palette.secondary || darken(agent.color, 0.4);
  drawPixelPattern([' XXXX ','XXXXXX','XXXXXX',' XXXX '], ax - PX * 3, ay - PX * 2, PX);
  ctx.fillStyle = palette.accent || '#7EE7FF';
  pixel(ax - PX * 0.5, ay, PX); pixel(ax - PX * 0.5, ay + PX, PX);

  ctx.fillStyle = '#f2cfb4';
  const armWave = agent.state === 'working' ? Math.sin(t * 8) * PX : agent.state === 'talking' ? Math.sin(t * 6) * PX * 0.5 : 0;
  pixel(ax - PX * 4, ay - PX + armWave, PX); pixel(ax + PX * 3, ay - PX - armWave, PX);

  ctx.fillStyle = palette.secondary || darken(agent.color, 0.4);
  const legSwing = agent.state === 'thinking' ? Math.sin(t * 5) * PX : 0;
  pixel(ax - PX + legSwing, ay + PX * 3, PX); pixel(ax + legSwing * -1, ay + PX * 3, PX);
  pixel(ax - PX + legSwing, ay + PX * 4, PX); pixel(ax + legSwing * -1, ay + PX * 4, PX);

  if (agent.state === 'working') {
    ctx.fillStyle = palette.accent || '#7EE7FF';
    pixel(ax + PX * 4.2, ay - PX * 1.5, PX);
  }
  if (agent.state === 'thinking') {
    ctx.fillStyle = palette.accent || '#7EE7FF';
    pixel(ax + PX * 4, ay - PX * 6, PX * 0.8); pixel(ax + PX * 5, ay - PX * 7, PX * 0.6);
  }
  if (agent.state === 'error') {
    ctx.fillStyle = '#FF4466';
    pixel(ax + PX * 4, ay - PX * 6, PX); pixel(ax + PX * 5, ay - PX * 7, PX);
  }

  ctx.fillStyle = agent.color; ctx.font = `${PX * 3}px VT323`; ctx.textAlign = 'center';
  ctx.fillText(agent.label.toUpperCase(), ax, ay + PX * 7); ctx.textAlign = 'start';
  ctx.restore();
}

function drawAgent(agent) {
  const x = Math.floor(canvas.width * agent.xPct), y = Math.floor(canvas.height * agent.yPct);
  const t = tick / 1000, color = agent.color, dark = darken(color, 0.4);
  const ax = x, ay = y + PX * 5;
  const bob = agent.state === 'idle' ? Math.sin(t * 1.5) * PX * 0.3 : 0;

  // Celebration: lean back
  const leanBack = agent.celebrating ? PX * 1.5 : 0;

  // Look up when voice starts
  const headYOff = agent.lookUp ? -PX * 1 : 0;

  ctx.fillStyle = '#D4A574';
  drawPixelPattern([' XX ','XXXX','XXXX',' XX '], ax - PX * 2, ay - PX * 6 + bob + headYOff, PX);
  ctx.fillStyle = color;
  pixel(ax - PX, ay - PX * 7 + bob + headYOff, PX); pixel(ax, ay - PX * 7 + bob + headYOff, PX); pixel(ax + PX, ay - PX * 7 + bob + headYOff, PX);
  pixel(ax - PX * 2, ay - PX * 6 + bob + headYOff, PX); pixel(ax + PX * 2, ay - PX * 6 + bob + headYOff, PX);
  if (agent.isBoss) { ctx.fillStyle = '#FFD700'; pixel(ax, ay - PX * 8 + bob + headYOff, PX); }

  // Eyes — look up if voice active
  ctx.fillStyle = '#111';
  const eyeY = ay - PX * 5 + bob + headYOff + (agent.lookUp ? -PX * 0.3 : 0);
  pixel(ax - PX, eyeY, PX * 0.7); pixel(ax + PX, eyeY, PX * 0.7);

  ctx.fillStyle = dark;
  drawPixelPattern([' XX ','XXXX','XXXX'], ax - PX * 2 + leanBack, ay - PX * 2 + bob, PX);
  ctx.fillStyle = '#D4A574';
  if (agent.state === 'working') {
    const armY = ay - PX + Math.sin(t * 8) * PX * 0.5;
    pixel(ax - PX * 3, armY, PX); pixel(ax + PX * 2, armY + Math.sin(t * 8 + 1) * PX * 0.5, PX);
  } else if (agent.celebrating) {
    // Arms up celebration
    pixel(ax - PX * 3, ay - PX * 4, PX); pixel(ax + PX * 3, ay - PX * 4, PX);
  } else { pixel(ax - PX * 3, ay - PX + bob, PX); pixel(ax + PX * 2, ay - PX + bob, PX); }

  ctx.fillStyle = color; ctx.font = `${PX * 3}px VT323`; ctx.textAlign = 'center';
  ctx.fillText(agent.label.toUpperCase(), ax, ay + PX * 4); ctx.textAlign = 'start';

  // Celebration sparkles
  if (agent.celebrating) {
    ctx.fillStyle = '#FFCC00';
    for (let i = 0; i < 4; i++) {
      const sparkX = ax + Math.sin(t * 4 + i * 1.5) * PX * 4;
      const sparkY = ay - PX * 6 + Math.cos(t * 3 + i * 2) * PX * 3;
      pixel(sparkX, sparkY, PX * 0.5);
    }
  }
}

function drawWalkingAgent(agent) {
  const x = Math.floor(canvas.width * agent.xPct), y = Math.floor(canvas.height * agent.yPct);
  const color = agent.color, dark = darken(color, 0.4);
  const bounce = Math.abs(Math.sin(agent.walkPhase * 3)) * PX * 1.5;
  const legSwing = Math.sin(agent.walkPhase * 6);
  const ax = x, ay = y - bounce;

  ctx.fillStyle = '#D4A574';
  drawPixelPattern([' XX ','XXXX','XXXX',' XX '], ax - PX * 2, ay - PX * 8, PX);
  ctx.fillStyle = color;
  pixel(ax - PX, ay - PX * 9, PX); pixel(ax, ay - PX * 9, PX); pixel(ax + PX, ay - PX * 9, PX);
  pixel(ax - PX * 2, ay - PX * 8, PX); pixel(ax + PX * 2, ay - PX * 8, PX);
  if (agent.isBoss) { ctx.fillStyle = '#FFD700'; pixel(ax, ay - PX * 10, PX); }
  ctx.fillStyle = '#111';
  const eO = agent.facingRight ? PX * 0.3 : -PX * 0.3;
  pixel(ax - PX + eO, ay - PX * 7, PX * 0.7); pixel(ax + PX + eO, ay - PX * 7, PX * 0.7);
  ctx.fillStyle = dark;
  drawPixelPattern([' XX ','XXXX','XXXX'], ax - PX * 2, ay - PX * 4, PX);
  ctx.fillStyle = '#D4A574';
  const aS = Math.sin(agent.walkPhase * 6) * PX;
  pixel(ax - PX * 3, ay - PX * 3 + aS, PX); pixel(ax + PX * 2, ay - PX * 3 - aS, PX);
  ctx.fillStyle = dark;
  const lx = ax - PX + legSwing * PX, rx = ax + legSwing * -PX;
  pixel(lx, ay - PX, PX); pixel(lx, ay, PX); pixel(rx, ay - PX, PX); pixel(rx, ay, PX);
  ctx.fillStyle = '#333'; pixel(lx, ay + PX, PX); pixel(rx, ay + PX, PX);
  ctx.fillStyle = color; ctx.font = `${PX * 3}px VT323`; ctx.textAlign = 'center';
  ctx.fillText(agent.label.toUpperCase(), ax, ay + PX * 4); ctx.textAlign = 'start';
}

function drawHighlight(agent) {
  const x = Math.floor(canvas.width * agent.xPct), y = Math.floor(canvas.height * agent.yPct);
  const p = 0.3 + Math.sin(tick / 200) * 0.15;
  ctx.save(); ctx.globalAlpha = p; ctx.strokeStyle = agent.color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, PX * 10, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
}

// --- State Indicators ---

function drawStateIndicator(agent) {
  const showBubble = agent.state !== 'idle' || (((agent.wanderState === 'idle_at_furniture' || agent.microActionTimer > 0) || huddleState === 'meeting') && agent.thoughtText);
  if (!showBubble) return;
  const x = Math.floor(canvas.width * agent.xPct), y = Math.floor(canvas.height * agent.yPct);
  const bX = x + PX * 5, bY = y - PX * 6, text = truncate(agent.thoughtText, 16);

  if ((agent.wanderState === 'idle_at_furniture' || agent.microActionTimer > 0 || huddleState === 'meeting') && agent.state === 'idle') {
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; pixel(x + PX * 3, y - PX * 8, PX); pixel(x + PX * 4, y - PX * 10, PX * 1.5);
    drawBubble(bX, bY - PX * 4, text, agent.color); return;
  }
  if (agent.state === 'thinking') { ctx.fillStyle = 'rgba(255,255,255,0.6)'; pixel(x + PX * 3, y + PX, PX); pixel(x + PX * 4, y - PX, PX * 1.5); drawBubble(bX, bY, text || '...', agent.color); }
  else if (agent.state === 'working') { drawBubble(bX, bY, (text || 'working') + '.'.repeat(agent.typingDots), agent.color); }
  else if (agent.state === 'talking') { drawBubble(bX, bY, text || 'speaking...', agent.color); }
}

function drawTransientBubbles(agent) {
  const bubbles = transientBubbles.filter((bubble) => bubble.agentId === agent.id);
  if (!bubbles.length) return;

  const x = Math.floor(canvas.width * agent.xPct);
  const y = Math.floor(canvas.height * agent.yPct) - PX * 12;

  let visibleIndex = 0;
  bubbles.forEach((bubble) => {
    const elapsed = bubble.age - (bubble.delay || 0);
    if (elapsed < 0) return;

    const progress = Math.max(0, Math.min(1, elapsed / bubble.duration));
    const alpha = Math.sin(progress * Math.PI);
    const lift = easeOutCubic(progress) * bubble.rise;
    const bx = x + PX * 2;
    const by = y - lift - visibleIndex * PX * 4;
    visibleIndex += 1;

    ctx.save();
    ctx.globalAlpha = alpha * 0.95;
    drawBubble(bx, by, bubble.text, bubble.color, {
      compact: true,
      badge: bubble.badge,
      badgeColor: bubble.badgeColor,
    });
    ctx.restore();
  });
}

function drawBubble(x, y, text, color, options = {}) {
  const compact = !!options.compact;
  const badge = String(options.badge || '').trim();
  const fontSize = compact ? PX * 2.4 : PX * 3;
  ctx.font = `${fontSize}px VT323`;
  const badgePad = badge ? (compact ? PX * 4 : PX * 5) : 0;
  const w = ctx.measureText(text).width + (compact ? PX * 3 : PX * 4) + badgePad;
  const h = compact ? PX * 4.2 : PX * 5;
  ctx.fillStyle = compact ? 'rgba(10,14,26,0.82)' : 'rgba(10,14,26,0.9)';
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  roundRect(x, y - h, w, h, compact ? PX * 0.8 : PX); ctx.fill(); ctx.stroke();

  let textX = x + (compact ? PX * 1.5 : PX * 2);
  if (badge) {
    const badgeW = compact ? PX * 3.2 : PX * 4;
    const badgeH = compact ? PX * 2.3 : PX * 2.8;
    const badgeX = x + PX * 1.1;
    const badgeY = y - h + (compact ? PX * 0.9 : PX * 1.1);
    ctx.fillStyle = options.badgeColor || color;
    roundRect(badgeX, badgeY, badgeW, badgeH, PX * 0.5); ctx.fill();
    ctx.fillStyle = '#081018';
    ctx.font = `${compact ? PX * 1.35 : PX * 1.6}px VT323`;
    ctx.textAlign = 'center';
    ctx.fillText(badge, badgeX + badgeW / 2, badgeY + badgeH - PX * 0.45);
    ctx.textAlign = 'start';
    ctx.font = `${fontSize}px VT323`;
    textX += badgePad;
  }

  ctx.fillStyle = color;
  ctx.fillText(text, textX, y - (compact ? PX * 1.2 : PX * 1.5));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

// --- Helpers ---
function pixel(x, y, size) { ctx.fillRect(Math.floor(x), Math.floor(y), size, size); }
function drawPixelPattern(p, sX, sY, sz) { for (let r=0;r<p.length;r++) for (let c=0;c<p[r].length;c++) if (p[r][c]==='X') pixel(sX+c*sz,sY+r*sz,sz); }
function darken(hex, amt) { const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgb(${Math.floor(r*(1-amt))},${Math.floor(g*(1-amt))},${Math.floor(b*(1-amt))})`; }
function truncate(s, max) { if (!s) return ''; return s.length>max?s.slice(0,max-1)+'\u2026':s; }

// --- Ambient Sound System ---

function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playKeyClick() {
  const ctx = ensureAudio();
  if (!ctx || soundCooldowns.click > 0) return;
  soundCooldowns.click = 200 + Math.random() * 500;
  const dur = 0.015 + Math.random() * 0.01;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.03;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start();
}

function playTaskDing() {
  const ctx = ensureAudio();
  if (!ctx || soundCooldowns.ding > 0) return;
  soundCooldowns.ding = 2000;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, ctx.currentTime);
  osc.frequency.setValueAtTime(800, ctx.currentTime + 0.08);
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + 0.3);
}

function playHourChime() {
  const ctx = ensureAudio();
  if (!ctx || soundCooldowns.chime > 0) return;
  soundCooldowns.chime = 5000;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(523, ctx.currentTime);
  osc.frequency.setValueAtTime(659, ctx.currentTime + 0.3);
  gain.gain.setValueAtTime(0.06, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + 0.8);
}
