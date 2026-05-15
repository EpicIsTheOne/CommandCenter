// Pixel-art styled crab mascot with 7 emotion states
// Designed with setSpriteSheet() for easy upgrade to real sprites

const EMOTIONS = {
  idle:      { color: '#00DDFF', eyeAnim: 'blink',   mouthAnim: 'neutral',  particles: 'float' },
  listening: { color: '#00FF66', eyeAnim: 'wide',     mouthAnim: 'open',     particles: 'pulse' },
  thinking:  { color: '#FFCC00', eyeAnim: 'squint',   mouthAnim: 'hmm',      particles: 'spin' },
  working:   { color: '#AA66FF', eyeAnim: 'focused',  mouthAnim: 'neutral',  particles: 'spark' },
  happy:     { color: '#00FF66', eyeAnim: 'happy',    mouthAnim: 'smile',    particles: 'burst' },
  error:     { color: '#FF4466', eyeAnim: 'x',        mouthAnim: 'frown',    particles: 'shake' },
  sleeping:  { color: '#334466', eyeAnim: 'closed',   mouthAnim: 'neutral',  particles: 'zzz' },
};

let canvas, ctx;
let emotion = 'idle';
let tick = 0;
let spriteSheet = null; // for future drop-in upgrade
let particles = [];

// Pixel scale factor - draws chunky pixels
const PX = 4;
const BASE = window.__BASE_PATH__ || '';
const FAIRY_ASSETS = [
  'part-1.png', 'part-2.png', 'part-3.png', 'part-4.png', 'part-5.png', 'part-6.png', 'part-7.png',
].map((name) => `${BASE}/assets/fairy-status/${name}`);
const FAIRY_LAYER_ORDER = [4, 5, 6, 0, 2, 1, 3];
const FAIRY_ASSEMBLED_URL = `${BASE}/assets/fairy-status/fairy-assembled.png`;
const fairyImageCache = new Map();

export function init(canvasId) {
  canvas = document.getElementById(canvasId);
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const headerH = canvas.parentElement.querySelector('.zone-header')?.offsetHeight || 24;
  const labelH = document.getElementById('mascot-label')?.offsetHeight || 30;
  canvas.width = rect.width;
  canvas.height = rect.height - headerH - labelH;
}

export function setEmotion(newEmotion) {
  if (EMOTIONS[newEmotion] && newEmotion !== emotion) {
    emotion = newEmotion;
    particles = [];

    // Update label and glow
    const label = document.getElementById('mascot-label');
    const zone = document.getElementById('zone-mascot');
    if (label) {
      label.textContent = emotion.toUpperCase();
      label.style.color = EMOTIONS[emotion].color;
      label.style.textShadow = `0 0 8px ${EMOTIONS[emotion].color}`;
    }
    if (zone) {
      zone.setAttribute('data-emotion', emotion);
    }
  }
}

export function setSpriteSheet(sheet) {
  spriteSheet = sheet;
}

export function update(dt) {
  tick += dt;
  updateParticles(dt);
}

export function draw() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (spriteSheet) {
    // Future: draw sprite sheet frame based on emotion
    return;
  }

  drawProceduralCrab();
  drawParticles();
}

// --- Procedural Pixel Crab ---

function drawProceduralCrab() {
  drawBangbooStatusAnimation();
}


function getSceneFairyImage(url = '') {
  if (!url) return null;
  if (fairyImageCache.has(url)) return fairyImageCache.get(url);
  const img = new Image();
  img.src = url;
  fairyImageCache.set(url, img);
  return img;
}

function drawAssembledFairyStatus(img, cx, cy, w, h, em, t) {
  const accent = em.color || '#72E7FF';
  const bob = Math.sin(t * 1.45) * 7;
  const breathe = 1 + Math.sin(t * 2.0) * 0.018;
  const maxW = w * 0.78;
  const maxH = h * 0.76;
  const baseScale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const drawW = img.naturalWidth * baseScale * breathe;
  const drawH = img.naturalHeight * baseScale * breathe;
  const x = cx - drawW / 2;
  const y = cy - drawH / 2 + bob;

  drawBangbooBackdrop(cx, cy + bob, Math.max(0.75, Math.min(1.45, Math.min(w, h) / 260)), accent, t);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.16 + Math.sin(t * 2.4) * 0.025;
  ctx.fillStyle = hexToRgba(accent, emotion === 'error' ? 0.55 : 0.38);
  ctx.beginPath();
  ctx.ellipse(cx, cy + bob, drawW * 0.34, drawH * 0.30, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.shadowColor = emotion === 'error' ? 'rgba(255, 76, 105, 0.48)' : hexToRgba(accent, 0.42);
  ctx.shadowBlur = 18;
  ctx.drawImage(img, x, y, drawW, drawH);
  ctx.restore();
  ctx.imageSmoothingEnabled = false;

}

function getFairyPart(index) {
  const url = FAIRY_ASSETS[index];
  if (!url) return null;
  if (fairyImageCache.has(url)) return fairyImageCache.get(url);
  const img = new Image();
  img.src = url;
  fairyImageCache.set(url, img);
  return img;
}

function drawBangbooStatusAnimation() {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const em = EMOTIONS[emotion] || EMOTIONS.idle;
  const t = tick / 1000;
  const loaded = FAIRY_ASSETS.map((_, i) => getFairyPart(i));
  const ready = loaded.every((img) => img?.complete && img.naturalWidth);
  if (!ready) return drawBangbooFallback();

  const scale = Math.max(0.72, Math.min(1.55, Math.min(w, h) / 250));
  const bob = Math.sin(t * 1.55) * 7 * scale;
  const breathe = 1 + Math.sin(t * 2.1) * 0.018;
  const x = cx;
  const y = cy + bob;
  const accent = em.color || '#72E7FF';
  const activeBoost = ['listening', 'thinking', 'working'].includes(emotion) ? 1 : 0;

  drawBangbooBackdrop(cx, cy, scale, accent, t);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale * breathe, scale * breathe);

  // Assemble the actual uploaded Figma fragments. Parts 5/6/7 are the large
  // background/head shell layers; parts 1-4 are the face/ear/accent details.
  const headTilt = Math.sin(t * 0.9) * 0.015;
  const rippleSpeed = 0.24;
  const spikePulseRate = 1.05;
  const spikePulse = (1 - Math.cos(t * spikePulseRate)) / 2;
  // Circle with Spike.png — slow idle spin, then subtly grows + accelerates during the pulse.
  const spikeSpin = t * 0.28 + 0.32 * (t / 2 - Math.sin(t * spikePulseRate) / (2 * spikePulseRate));
  const spikeScale = 0.96 + spikePulse * 0.14;

  // Ripple Circle.png — slow expanding waves that grow out toward the Claw Status edges.
  const rippleMaxScale = Math.max(2.2, Math.min(w, h) / (150 * scale) * 0.98);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 2; i++) {
    const phase = (t * rippleSpeed + i / 2) % 1;
    const eased = 1 - Math.pow(1 - phase, 2.35);
    const rippleScale = 0.86 + eased * (rippleMaxScale - 0.86);
    const rippleAlpha = 0.72 * Math.pow(1 - phase, 0.55);
    drawFairyAsset(5, 0, -2, rippleScale, headTilt * 0.4, rippleAlpha);
  }
  ctx.restore();

  drawFairyRippleRings(0, -2, t, accent, rippleMaxScale);

  drawFairyAsset(4, 0, -4, 1.06, 0, 0.92);                               // main circle/backplate
  drawFairyAsset(6, 0, 0, spikeScale, spikeSpin, 1);                    // Circle with Spike.png
  drawFairyAsset(0, 0, 0, 0.92, headTilt, 1);                           // centered face/detail
  drawFairyAsset(1, 0, 0, 0.92, headTilt * 0.6, 1);
  drawFairyAsset(2, 0, 0, 0.90, 0, 0.96);
  drawFairyAsset(3, 0, 0, 0.90, 0, 1);

  drawBangbooStatusGlow(accent, t, activeBoost);
  ctx.restore();
}

function drawFairyRippleRings(x, y, t, accent, maxScale = 2.4) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 3;
  const startRadius = 56;
  const edgeRadius = 75 * maxScale;
  for (let i = 0; i < 2; i++) {
    const phase = (t * 0.24 + i / 2) % 1;
    const eased = 1 - Math.pow(1 - phase, 2.35);
    const radius = startRadius + eased * (edgeRadius - startRadius);
    const alpha = 0.48 * Math.pow(1 - phase, 0.7);
    ctx.strokeStyle = hexToRgba(accent, alpha);
    ctx.beginPath();
    ctx.ellipse(x, y, radius * 1.08, radius * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFairyAsset(index, x, y, scale = 1, rotation = 0, alpha = 1) {
  const img = getFairyPart(index);
  if (!img?.complete || !img.naturalWidth) return;
  const flip = scale < 0 ? -1 : 1;
  const absScale = Math.abs(scale);
  const fit = 150 / Math.max(img.naturalWidth, img.naturalHeight);
  const dw = img.naturalWidth * absScale * fit;
  const dh = img.naturalHeight * absScale * fit;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(flip, 1);
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function drawBangbooBackdrop(cx, cy, scale, accent, t) {
  const r = 108 * scale;
  const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, r * 1.35);
  glow.addColorStop(0, hexToRgba(accent, 0.20));
  glow.addColorStop(0.42, 'rgba(255, 209, 139, 0.10)');
  glow.addColorStop(1, 'rgba(255, 209, 139, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
  ctx.fill();

}

function drawBangbooStatusGlow(accent, t, activeBoost = 0) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = emotion === 'error' ? 0.22 : 0.12 + activeBoost * 0.08 + Math.sin(t * 2.4) * 0.025;
  ctx.fillStyle = emotion === 'error' ? 'rgba(255, 80, 105, 0.55)' : hexToRgba(accent, 0.5);
  ctx.beginPath();
  ctx.ellipse(0, 0, 58, 46, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBangbooX(x, y, size) {
  ctx.strokeStyle = '#FF6575';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - size, y - size);
  ctx.lineTo(x + size, y + size);
  ctx.moveTo(x + size, y - size);
  ctx.lineTo(x - size, y + size);
  ctx.stroke();
}

function drawBangbooStatusGlyph(accent, t) {
  ctx.save();
  ctx.globalAlpha = 0.74;
  ctx.fillStyle = hexToRgba(accent, 0.82);
  ctx.font = '700 12px Inter, sans-serif';
  ctx.textAlign = 'center';
  const text = emotion === 'working' ? 'SYNC' : emotion === 'thinking' ? 'SCAN' : emotion === 'listening' ? 'LIVE' : emotion === 'error' ? 'ERR' : emotion === 'happy' ? 'OK' : 'AI';
  ctx.fillText(text, 0, 68 + Math.sin(t * 1.5) * 2);
  ctx.restore();
}

function drawBangbooOrbitParticles(cx, cy, scale, accent, t) {
  const count = emotion === 'working' ? 12 : 8;
  for (let i = 0; i < count; i++) {
    const a = i * Math.PI * 2 / count + t * (0.32 + i * 0.01);
    const rx = 92 * scale + Math.sin(t * 1.5 + i) * 6 * scale;
    const ry = 62 * scale;
    const x = cx + Math.cos(a) * rx;
    const y = cy + Math.sin(a) * ry;
    const size = (2.2 + (i % 3)) * scale;
    ctx.save();
    ctx.globalAlpha = 0.40 + (i % 2) * 0.24;
    ctx.fillStyle = i % 2 ? hexToRgba(accent, 0.88) : 'rgba(255, 218, 154, 0.88)';
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawBangbooFallback() {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const em = EMOTIONS[emotion] || EMOTIONS.idle;
  ctx.fillStyle = 'rgba(255, 220, 160, 0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, 76, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = em.color;
  ctx.font = '600 13px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('assembling fairy ai...', cx, cy);
  ctx.textAlign = 'start';
}

function hexToRgba(hex = '#ffffff', alpha = 1) {
  const clean = String(hex).replace('#', '').trim();
  const r = parseInt(clean.slice(0, 2), 16) || 255;
  const g = parseInt(clean.slice(2, 4), 16) || 255;
  const b = parseInt(clean.slice(4, 6), 16) || 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawEyes(cx, baseY, anim, t, color) {
  const eyeSpacing = PX * 3;
  const lx = cx - eyeSpacing;
  const rx = cx + eyeSpacing - PX;

  switch (anim) {
    case 'blink': {
      const blinkPhase = t % 4;
      if (blinkPhase < 0.1) {
        // Blinking - horizontal line
        ctx.fillStyle = '#FFFFFF';
        pixel(lx, baseY, PX); pixel(lx + PX, baseY, PX);
        pixel(rx, baseY, PX); pixel(rx + PX, baseY, PX);
      } else {
        drawNormalEyes(lx, rx, baseY);
      }
      break;
    }
    case 'wide':
      ctx.fillStyle = '#FFFFFF';
      pixel(lx, baseY - PX, PX); pixel(lx + PX, baseY - PX, PX);
      pixel(lx, baseY, PX); pixel(lx + PX, baseY, PX);
      pixel(rx, baseY - PX, PX); pixel(rx + PX, baseY - PX, PX);
      pixel(rx, baseY, PX); pixel(rx + PX, baseY, PX);
      // Pupils
      ctx.fillStyle = '#111';
      pixel(lx + PX, baseY, PX);
      pixel(rx, baseY, PX);
      break;
    case 'squint':
      ctx.fillStyle = '#FFFFFF';
      pixel(lx, baseY, PX); pixel(lx + PX, baseY, PX);
      pixel(rx, baseY, PX); pixel(rx + PX, baseY, PX);
      break;
    case 'focused': {
      drawNormalEyes(lx, rx, baseY);
      // Focus dots rotating
      const fx = Math.cos(t * 5) * PX;
      const fy = Math.sin(t * 5) * PX;
      ctx.fillStyle = color;
      pixel(lx + PX + fx, baseY + fy, PX * 0.5);
      pixel(rx + fx, baseY + fy, PX * 0.5);
      break;
    }
    case 'happy':
      // Upside down U shapes
      ctx.fillStyle = '#FFFFFF';
      pixel(lx, baseY - PX, PX); pixel(lx + PX, baseY - PX, PX);
      pixel(lx, baseY, PX); pixel(lx + PX, baseY, PX);
      ctx.fillStyle = '#111';
      pixel(lx, baseY, PX); pixel(lx + PX, baseY, PX);
      ctx.fillStyle = '#FFFFFF';
      pixel(rx, baseY - PX, PX); pixel(rx + PX, baseY - PX, PX);
      pixel(rx, baseY, PX); pixel(rx + PX, baseY, PX);
      ctx.fillStyle = '#111';
      pixel(rx, baseY, PX); pixel(rx + PX, baseY, PX);
      break;
    case 'x':
      // X eyes for error
      ctx.fillStyle = '#FF4466';
      pixel(lx, baseY - PX, PX); pixel(lx + PX, baseY, PX);
      pixel(lx + PX, baseY - PX, PX); pixel(lx, baseY, PX);
      pixel(rx, baseY - PX, PX); pixel(rx + PX, baseY, PX);
      pixel(rx + PX, baseY - PX, PX); pixel(rx, baseY, PX);
      break;
    case 'closed':
      ctx.fillStyle = '#FFFFFF';
      pixel(lx, baseY, PX); pixel(lx + PX, baseY, PX);
      pixel(rx, baseY, PX); pixel(rx + PX, baseY, PX);
      break;
    default:
      drawNormalEyes(lx, rx, baseY);
  }
}

function drawNormalEyes(lx, rx, baseY) {
  ctx.fillStyle = '#FFFFFF';
  pixel(lx, baseY - PX, PX); pixel(lx + PX, baseY - PX, PX);
  pixel(lx, baseY, PX); pixel(lx + PX, baseY, PX);
  pixel(rx, baseY - PX, PX); pixel(rx + PX, baseY - PX, PX);
  pixel(rx, baseY, PX); pixel(rx + PX, baseY, PX);
  // Pupils
  ctx.fillStyle = '#111';
  pixel(lx + PX, baseY, PX);
  pixel(rx, baseY, PX);
}

function drawMouth(cx, baseY, anim, t) {
  const mx = cx - PX * 2;

  switch (anim) {
    case 'neutral':
      ctx.fillStyle = '#2A1520';
      pixel(mx, baseY, PX);
      pixel(mx + PX, baseY, PX);
      pixel(mx + PX * 2, baseY, PX);
      pixel(mx + PX * 3, baseY, PX);
      break;
    case 'open': {
      const openSize = Math.sin(t * 6) * 0.5 + 0.5;
      ctx.fillStyle = '#2A1520';
      pixel(mx + PX, baseY, PX);
      pixel(mx + PX * 2, baseY, PX);
      if (openSize > 0.3) {
        pixel(mx + PX, baseY + PX, PX);
        pixel(mx + PX * 2, baseY + PX, PX);
      }
      break;
    }
    case 'hmm':
      ctx.fillStyle = '#2A1520';
      pixel(mx + PX, baseY, PX);
      pixel(mx + PX * 2, baseY, PX);
      // Wavy
      pixel(mx + PX * 3, baseY - (Math.sin(t * 4) > 0 ? PX : 0), PX);
      break;
    case 'smile':
      ctx.fillStyle = '#2A1520';
      pixel(mx, baseY - PX, PX);
      pixel(mx + PX, baseY, PX);
      pixel(mx + PX * 2, baseY, PX);
      pixel(mx + PX * 3, baseY - PX, PX);
      break;
    case 'frown':
      ctx.fillStyle = '#2A1520';
      pixel(mx, baseY + PX, PX);
      pixel(mx + PX, baseY, PX);
      pixel(mx + PX * 2, baseY, PX);
      pixel(mx + PX * 3, baseY + PX, PX);
      break;
  }
}

function drawClaw(x, y, mirrored, color, dark) {
  const d = mirrored ? -1 : 1;
  ctx.fillStyle = dark;
  // Arm
  pixel(x, y + PX, PX);
  pixel(x, y + PX * 2, PX);
  // Pincer top
  ctx.fillStyle = color;
  pixel(x - d * PX, y, PX);
  pixel(x, y, PX);
  pixel(x + d * PX, y, PX);
  // Pincer bottom
  pixel(x - d * PX, y + PX * 2, PX);
  pixel(x + d * PX, y + PX * 2, PX);
  // Pincer opening
  ctx.fillStyle = '#0D1220';
  pixel(x, y + PX, PX);
}

// --- Particles ---

function updateParticles(dt) {
  const em = EMOTIONS[emotion];
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Spawn
  if (particles.length < 15 && Math.random() < 0.1) {
    particles.push(createParticle(cx, cy, em.particles, em.color));
  }

  // Update
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt / 1000;
    p.y += p.vy * dt / 1000;
    p.alpha = Math.max(0, p.life / p.maxLife);

    if (p.life <= 0) {
      particles.splice(i, 1);
    }
  }
}

function createParticle(cx, cy, type, color) {
  const angle = Math.random() * Math.PI * 2;
  const dist = 30 + Math.random() * 40;
  const base = {
    x: cx + Math.cos(angle) * dist,
    y: cy + Math.sin(angle) * dist,
    vx: 0, vy: 0,
    life: 2000 + Math.random() * 1000,
    maxLife: 3000,
    size: PX * (0.5 + Math.random() * 0.5),
    color,
    alpha: 1,
    char: null,
  };

  switch (type) {
    case 'float':
      base.vy = -10 - Math.random() * 10;
      break;
    case 'pulse':
      base.vx = Math.cos(angle) * 20;
      base.vy = Math.sin(angle) * 20;
      break;
    case 'spin':
      base.vx = Math.cos(angle) * 15;
      base.vy = Math.sin(angle) * 15;
      base.char = ['?', '*', '.'][Math.floor(Math.random() * 3)];
      break;
    case 'spark':
      base.vx = (Math.random() - 0.5) * 40;
      base.vy = -20 - Math.random() * 30;
      base.life = 800 + Math.random() * 400;
      base.maxLife = 1200;
      break;
    case 'burst':
      base.vx = Math.cos(angle) * 30;
      base.vy = Math.sin(angle) * 30;
      base.life = 600 + Math.random() * 400;
      base.maxLife = 1000;
      break;
    case 'shake':
      base.vx = (Math.random() - 0.5) * 60;
      base.vy = (Math.random() - 0.5) * 60;
      base.life = 500;
      base.maxLife = 500;
      break;
    case 'zzz':
      base.vy = -8;
      base.vx = 5;
      base.char = 'z';
      base.life = 3000;
      base.maxLife = 3000;
      break;
  }
  return base;
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = p.alpha;
    if (p.char) {
      ctx.fillStyle = p.color;
      ctx.font = `${p.size * 4}px VT323`;
      ctx.fillText(p.char, p.x, p.y);
    } else {
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.floor(p.x), Math.floor(p.y), p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
}

// --- Helpers ---

function pixel(x, y, size) {
  ctx.fillRect(Math.floor(x), Math.floor(y), size, size);
}

function drawPixelPattern(pattern, startX, startY, size) {
  for (let r = 0; r < pattern.length; r++) {
    for (let c = 0; c < pattern[r].length; c++) {
      if (pattern[r][c] === 'X') {
        pixel(startX + c * size, startY + r * size, size);
      }
    }
  }
}

function darken(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.floor(r * (1 - amount))},${Math.floor(g * (1 - amount))},${Math.floor(b * (1 - amount))})`;
}
