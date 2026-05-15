const companionState = {
  visuals: {},
  registry: {},
  runtime: new Map(),
  imageCache: new Map(),
};

const CODEX_ROW_MAP = {
  idle: [0],
  thinking: [6],
  responding: [3],
  tool: [7],
  error: [5],
  waiting: [6],
  review: [8],
  running: [7],
  runningRight: [1],
  runningLeft: [2],
};

const CODEX_FRAME_FALLBACKS = {
  idle: 6,
  thinking: 6,
  waiting: 6,
  responding: 4,
  waving: 4,
  wave: 4,
  jumping: 5,
  error: 8,
  failed: 8,
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
};

function getCodexRows(companion = {}, state = 'idle') {
  const animationMap = companion?.importedPet?.animationMap || {};
  const rows = animationMap?.[state];
  if (Array.isArray(rows) && rows.length) return rows;
  return CODEX_ROW_MAP[state] || CODEX_ROW_MAP.idle;
}

function getStableCodexRow(companion = {}, state = 'idle') {
  const rows = getCodexRows(companion, state);
  return Array.isArray(rows) && rows.length ? Number(rows[0]) || 0 : 0;
}

function getCodexFrameCount(companion = {}, state = 'idle', columns = 8) {
  const safeColumns = Math.max(1, Math.floor(Number(columns) || 1));
  const frameCounts = companion?.importedPet?.frameCounts || companion?.importedPet?.animationMap?.frameCounts || {};
  const count = Number(frameCounts?.[state] || 0);
  if (Number.isFinite(count) && count > 0) return Math.max(1, Math.min(safeColumns, Math.floor(count)));
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

function getValidCodexRow(companion = {}, state = 'idle', maxRows = 1) {
  const rows = getCodexRows(companion, state);
  const valid = (Array.isArray(rows) ? rows : [rows])
    .map((row) => Math.floor(Number(row)))
    .find((row) => Number.isFinite(row) && row >= 0 && row < maxRows);
  if (Number.isFinite(valid)) return valid;
  const idleRows = getCodexRows(companion, 'idle');
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

function paletteFor(companion = {}) {
  return {
    primary: companion?.palette?.primary || '#7ee7ff',
    secondary: companion?.palette?.secondary || '#172033',
    accent: companion?.palette?.accent || '#8aff80',
  };
}

function getCodexImage(url = '') {
  if (!url) return null;
  const key = `codex:${url}`;
  let cached = companionState.imageCache.get(key);
  if (cached) return cached;
  const img = new Image();
  img.decoding = 'async';
  img.crossOrigin = 'anonymous';
  img.onload = () => refreshCompanions();
  img.onerror = () => { img._failed = true; };
  img.src = url;
  companionState.imageCache.set(key, img);
  return img;
}

function drawCompanionCaption(ctx, width, height, label = '') {
  if (!label) return;
  ctx.fillStyle = 'rgba(200,208,224,0.92)';
  ctx.font = '12px Inter';
  ctx.textAlign = 'center';
  ctx.fillText(label, width / 2, height - 4);
  ctx.textAlign = 'start';
}

function renderCodexImportedCompanion(ctx, width, height, companion, state = 'idle', tick = 0, label = '', options = {}) {
  ctx.imageSmoothingEnabled = false;
  const pet = companion.importedPet || {};
  const img = getCodexImage(pet.spritesheetUrl || '');
  if (!img || !img.complete || !img.naturalWidth) {
    if (!options.keepLastFrame) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#c8d0e0';
      ctx.font = '12px Inter';
      ctx.textAlign = 'center';
      ctx.fillText(img?._failed ? 'Pet unavailable' : 'Loading pet…', width / 2, height / 2);
      ctx.textAlign = 'start';
      drawCompanionCaption(ctx, width, height, label);
    }
    return;
  }

  const layout = getCodexSheetLayout(pet, img);
  const activeRow = getValidCodexRow(companion, state, layout.actualRows);
  const frameCount = getCodexFrameCount(companion, state, layout.actualColumns);
  const preferredFrame = Math.abs(Math.floor(tick / 140)) % frameCount;
  const frame = getVisibleCodexFrame(img, layout, activeRow, preferredFrame, frameCount);
  if (frame < 0) return;
  const sx = frame * layout.frameWidth;
  const sy = activeRow * layout.frameHeight;

  const reservedLabelSpace = label ? 18 : 0;
  const availableHeight = Math.max(1, height - reservedLabelSpace);
  const sizeScale = Math.min(2, Math.max(0.45, Number(options.scale || 1) || 1));
  const scale = Math.min(width / layout.frameWidth, availableHeight / layout.frameHeight) * sizeScale;
  const drawWidth = Math.floor(layout.frameWidth * scale);
  const drawHeight = Math.floor(layout.frameHeight * scale);
  const dx = Math.floor((width - drawWidth) / 2);
  const dy = Math.floor((availableHeight - drawHeight) / 2);

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(2, 2, width - 4, availableHeight - 2, 10);
    ctx.clip();
  }
  ctx.drawImage(img, sx, sy, layout.frameWidth, layout.frameHeight, dx, dy, drawWidth, drawHeight);
  ctx.restore();

  drawCompanionCaption(ctx, width, height, label);
}

export function setCompanionData({ visuals = {}, items = [] } = {}) {
  companionState.visuals = visuals || {};
  companionState.registry = Object.fromEntries((items || []).map((item) => [item.id, item]));
}

export function getAgentVisual(agentId = '') {
  return companionState.visuals?.[String(agentId)] || { mode: 'default', companion: null, companionId: '' };
}

export function isCompanionMode(agentId = '') {
  return getAgentVisual(agentId).mode === 'companion' && !!getAgentVisual(agentId).companion;
}

function renderPixelCompanion(ctx, width, height, companion, state = 'idle', tick = 0, label = '', options = {}) {
  if (companion?.sourceType === 'codex-import' && companion?.importedPet?.spritesheetUrl) {
    return renderCodexImportedCompanion(ctx, width, height, companion, state, tick, label, options);
  }

  const palette = paletteFor(companion);
  const sizeScale = Math.min(2, Math.max(0.45, Number(options.scale || 1) || 1));
  const unit = Math.max(2, Math.floor((Math.min(width, height) / 18) * sizeScale));
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const bob = state === 'idle' ? Math.sin(tick / 400) * unit * 0.6 : state === 'responding' ? Math.sin(tick / 120) * unit * 0.4 : 0;
  const headY = cy - unit * 3 + bob;
  const bodyY = cy + bob;

  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + unit * 5, unit * 4, unit * 1.6, 0, 0, Math.PI * 2);
  ctx.fill();

  // head
  ctx.fillStyle = '#f2cfb4';
  ctx.fillRect(cx - unit * 2, headY - unit * 2, unit * 4, unit * 4);

  // hair / cap
  ctx.fillStyle = palette.primary;
  ctx.fillRect(cx - unit * 2.4, headY - unit * 3, unit * 4.8, unit * 1.6);
  ctx.fillRect(cx - unit * 3, headY - unit * 2.2, unit, unit * 1.3);
  ctx.fillRect(cx + unit * 2, headY - unit * 2.2, unit, unit * 1.3);

  // body
  ctx.fillStyle = palette.secondary;
  ctx.fillRect(cx - unit * 2.5, bodyY - unit * 0.2, unit * 5, unit * 4.8);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(cx - unit * 0.6, bodyY + unit * 0.5, unit * 1.2, unit * 2.4);

  // arms
  const armWave = state === 'tool' ? Math.sin(tick / 90) * unit * 1.1 : state === 'responding' ? Math.sin(tick / 100) * unit * 0.7 : 0;
  ctx.fillStyle = '#f2cfb4';
  ctx.fillRect(cx - unit * 3.4, bodyY + unit * 0.5 + armWave, unit * 0.9, unit * 2.1);
  ctx.fillRect(cx + unit * 2.5, bodyY + unit * 0.5 - armWave, unit * 0.9, unit * 2.1);

  // legs
  const step = state === 'thinking' ? Math.sin(tick / 130) * unit * 0.7 : 0;
  ctx.fillStyle = palette.secondary;
  ctx.fillRect(cx - unit * 1.4 + step, bodyY + unit * 4.2, unit * 1.1, unit * 2);
  ctx.fillRect(cx + unit * 0.3 - step, bodyY + unit * 4.2, unit * 1.1, unit * 2);

  // eyes
  ctx.fillStyle = state === 'error' ? '#ff4466' : '#111';
  if (state === 'thinking') {
    ctx.fillRect(cx - unit * 1.4, headY - unit * 0.2, unit * 1.1, unit * 0.4);
    ctx.fillRect(cx + unit * 0.3, headY - unit * 0.2, unit * 1.1, unit * 0.4);
  } else if (state === 'error') {
    ctx.fillRect(cx - unit * 1.5, headY - unit * 0.5, unit * 1.2, unit * 1.2);
    ctx.fillRect(cx + unit * 0.3, headY - unit * 0.5, unit * 1.2, unit * 1.2);
  } else {
    ctx.fillRect(cx - unit * 1.3, headY - unit * 0.6, unit * 0.7, unit * 0.7);
    ctx.fillRect(cx + unit * 0.6, headY - unit * 0.6, unit * 0.7, unit * 0.7);
  }

  // mouth
  ctx.fillStyle = state === 'error' ? '#7a1020' : '#5a2a2a';
  if (state === 'responding') ctx.fillRect(cx - unit * 0.5, headY + unit * 1.1, unit, unit * 0.7);
  else if (state === 'thinking') ctx.fillRect(cx - unit * 0.3, headY + unit * 1.1, unit * 0.6, unit * 0.2);
  else ctx.fillRect(cx - unit * 0.5, headY + unit * 1.1, unit, unit * 0.3);

  // tool / error / thinking accents
  if (state === 'tool') {
    ctx.fillStyle = palette.accent;
    ctx.fillRect(cx + unit * 3.1, bodyY - unit * 0.1, unit * 1.4, unit * 1.4);
  }
  if (state === 'thinking') {
    ctx.fillStyle = palette.accent;
    ctx.fillRect(cx + unit * 3.2, headY - unit * 2.2, unit * 0.8, unit * 0.8);
    ctx.fillRect(cx + unit * 4.3, headY - unit * 3.1, unit * 0.6, unit * 0.6);
  }
  if (state === 'error') {
    ctx.fillStyle = '#ff4466';
    ctx.fillRect(cx + unit * 3.1, headY - unit * 2.4, unit * 1.2, unit * 1.2);
  }

  if (label) {
    ctx.fillStyle = 'rgba(200,208,224,0.9)';
    ctx.font = `${Math.max(10, unit * 2)}px Inter`;
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, height - unit);
    ctx.textAlign = 'start';
  }
}

export function getCompanionById(companionId = '') {
  return companionState.registry?.[String(companionId)] || null;
}

export function mountCompanionCanvas(canvas, options = {}) {
  if (!canvas) return null;
  const agentId = String(options.agentId || canvas.dataset.agentId || '').trim();
  const state = options.state || 'idle';
  const label = options.label || '';
  const visual = getAgentVisual(agentId);
  const runtime = { canvas, agentId, state, label, visual };
  companionState.runtime.set(canvas, runtime);

  const draw = () => {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.floor(rect.width || options.width || 72));
    const nextHeight = Math.max(1, Math.floor(rect.height || options.height || 72));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    const ctx = canvas.getContext('2d');
    renderPixelCompanion(ctx, canvas.width, canvas.height, runtime.visual.companion || {}, runtime.state, performance.now(), runtime.label, { scale: runtime.visual.scale || 1, keepLastFrame: true });
  };

  runtime.draw = draw;
  draw();
  return runtime;
}

export function refreshCompanions() {
  for (const runtime of companionState.runtime.values()) {
    runtime.visual = getAgentVisual(runtime.agentId);
    if (runtime.draw) runtime.draw();
  }
}

export function setCompanionState(agentId, state = 'idle') {
  for (const runtime of companionState.runtime.values()) {
    if (runtime.agentId !== agentId) continue;
    runtime.state = state;
    if (runtime.draw) runtime.draw();
  }
}

export function renderCompanionPreview(canvas, companion, state = 'idle', label = '', options = {}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const nextWidth = Math.max(1, Math.floor(rect.width || 84));
  const nextHeight = Math.max(1, Math.floor(rect.height || 84));
  if (canvas.width !== nextWidth) canvas.width = nextWidth;
  if (canvas.height !== nextHeight) canvas.height = nextHeight;
  const ctx = canvas.getContext('2d');
  renderPixelCompanion(ctx, canvas.width, canvas.height, companion || {}, state, performance.now(), label, options);
}
