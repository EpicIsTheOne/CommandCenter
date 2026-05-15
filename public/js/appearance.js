const BASE = window.__BASE_PATH__ || '';

const THEME_COLOR_FIELDS = [
  ['bgPrimary', '--bg-primary'], ['bgMascot', '--bg-mascot'], ['bgTerminal', '--bg-terminal'], ['bgOffice', '--bg-office'],
  ['borderColor', '--border-color'], ['textPrimary', '--text-primary'], ['textDim', '--text-dim'], ['green', '--green'],
  ['greenDim', '--green-dim'], ['red', '--red'], ['cyan', '--cyan'], ['yellow', '--yellow'], ['purple', '--purple'],
  ['amber', '--amber'], ['glowIdle', '--glow-idle'], ['glowListening', '--glow-listening'], ['glowThinking', '--glow-thinking'],
  ['glowWorking', '--glow-working'], ['glowHappy', '--glow-happy'], ['glowError', '--glow-error'], ['glowSleeping', '--glow-sleeping'],
];

const APPEARANCE_DEFAULTS = {
  workspaceBackgroundId: 'default-office',
  themeId: 'default-ember',
  customThemes: [],
  panelOpacity: 0.85,
  blurStrength: 12,
  glowIntensity: 1,
  uiDensity: 'normal',
  borderStyle: 'sharp',
  fontPreset: 'modern',
};

let officeModule = null;
let state = {
  settings: { ...APPEARANCE_DEFAULTS },
  themes: [],
  backgrounds: [],
};

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function qs(id) { return document.getElementById(id); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function clamp(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }

function normalizeSettings(input = {}) {
  return {
    ...APPEARANCE_DEFAULTS,
    ...input,
    panelOpacity: clamp(input.panelOpacity, 0.3, 1, APPEARANCE_DEFAULTS.panelOpacity),
    blurStrength: clamp(input.blurStrength, 0, 24, APPEARANCE_DEFAULTS.blurStrength),
    glowIntensity: clamp(input.glowIntensity, 0, 2, APPEARANCE_DEFAULTS.glowIntensity),
    uiDensity: ['compact', 'normal', 'spacious'].includes(input.uiDensity) ? input.uiDensity : APPEARANCE_DEFAULTS.uiDensity,
    borderStyle: ['sharp', 'rounded'].includes(input.borderStyle) ? input.borderStyle : APPEARANCE_DEFAULTS.borderStyle,
    fontPreset: ['terminal', 'modern', 'pixel', 'clean'].includes(input.fontPreset) ? input.fontPreset : APPEARANCE_DEFAULTS.fontPreset,
  };
}

function getAllThemes() {
  return Array.isArray(state.themes) ? state.themes : [];
}

function getCurrentTheme() {
  return getAllThemes().find((theme) => theme.id === state.settings.themeId) || getAllThemes()[0] || null;
}

function getCurrentBackground() {
  return (state.backgrounds || []).find((bg) => bg.id === state.settings.workspaceBackgroundId) || state.backgrounds?.[0] || null;
}

function applyTheme(theme) {
  if (!theme?.colors) return;
  const root = document.documentElement;
  for (const [key, cssVar] of THEME_COLOR_FIELDS) {
    if (theme.colors[key]) root.style.setProperty(cssVar, theme.colors[key]);
  }
  if (theme.colors.amberGlow) root.style.setProperty('--amber-glow', theme.colors.amberGlow);
  if (theme.colors.paneBg) root.style.setProperty('--pane-bg', theme.colors.paneBg);
}

function applyAppearanceControls() {
  const root = document.documentElement;
  const body = document.body;
  root.style.setProperty('--panel-opacity', String(state.settings.panelOpacity));
  root.style.setProperty('--panel-blur', `${state.settings.blurStrength}px`);
  root.style.setProperty('--glow-intensity', String(state.settings.glowIntensity));
  if (body) {
    body.dataset.uiDensity = state.settings.uiDensity;
    body.dataset.borderStyle = state.settings.borderStyle;
    body.dataset.fontPreset = state.settings.fontPreset;
  }
}

function applyWorkspaceBackground(background) {
  if (!officeModule?.setWorkspaceBackground) return;
  officeModule.setWorkspaceBackground(background?.url || '');
}

function updateCustomThemeInputs(theme) {
  const colors = theme?.colors || {};
  for (const [key] of THEME_COLOR_FIELDS) {
    const input = qs(`theme-color-${key}`);
    if (input && colors[key]) input.value = colors[key];
  }
  const nameInput = qs('custom-theme-name');
  if (nameInput && theme && !theme.builtIn) nameInput.value = theme.name || '';
}

function updateValueLabel(id, value) {
  const el = qs(id);
  if (el) el.textContent = value;
}

export async function refresh() {
  const data = await fetchJson(`${BASE}/api/settings/appearance`);
  state.settings = normalizeSettings(data.settings || state.settings);
  state.themes = data.themes || [];
  state.backgrounds = data.backgrounds || [];
  applyTheme(getCurrentTheme());
  applyAppearanceControls();
  applyWorkspaceBackground(getCurrentBackground());
  renderSettings();
  return state;
}

export function renderSettings() {
  const themeSelect = qs('appearance-theme-select');
  const bgSelect = qs('workspace-background-select');
  if (themeSelect) {
    themeSelect.innerHTML = getAllThemes().map((theme) => `<option value="${esc(theme.id)}" ${theme.id === state.settings.themeId ? 'selected' : ''}>${esc(theme.name)}${theme.builtIn ? '' : ' (custom)'}</option>`).join('');
  }
  if (bgSelect) {
    bgSelect.innerHTML = (state.backgrounds || []).map((bg) => `<option value="${esc(bg.id)}" ${bg.id === state.settings.workspaceBackgroundId ? 'selected' : ''}>${esc(bg.name)}</option>`).join('');
  }
  const bgStatus = qs('workspace-background-upload-status');
  if (bgStatus && !bgStatus.dataset.busy) bgStatus.textContent = getCurrentBackground()?.name ? `Selected workspace: ${getCurrentBackground().name}` : 'Pick a workspace background.';
  const opacity = qs('appearance-panel-opacity');
  const blur = qs('appearance-blur-strength');
  const glow = qs('appearance-glow-intensity');
  if (opacity) opacity.value = String(Math.round(state.settings.panelOpacity * 100));
  if (blur) blur.value = String(Math.round(state.settings.blurStrength));
  if (glow) glow.value = String(Math.round(state.settings.glowIntensity * 100));
  if (qs('appearance-ui-density')) qs('appearance-ui-density').value = state.settings.uiDensity;
  if (qs('appearance-border-style')) qs('appearance-border-style').value = state.settings.borderStyle;
  if (qs('appearance-font-preset')) qs('appearance-font-preset').value = state.settings.fontPreset;
  updateValueLabel('appearance-panel-opacity-value', `${Math.round(state.settings.panelOpacity * 100)}%`);
  updateValueLabel('appearance-blur-strength-value', `${Math.round(state.settings.blurStrength)}px`);
  updateValueLabel('appearance-glow-intensity-value', `${Math.round(state.settings.glowIntensity * 100)}%`);
  updateCustomThemeInputs(getCurrentTheme());
}

export function collectSettings() {
  return normalizeSettings({
    ...state.settings,
    workspaceBackgroundId: String(qs('workspace-background-select')?.value || '').trim(),
    themeId: String(qs('appearance-theme-select')?.value || '').trim(),
    panelOpacity: Number(qs('appearance-panel-opacity')?.value || 85) / 100,
    blurStrength: Number(qs('appearance-blur-strength')?.value || 12),
    glowIntensity: Number(qs('appearance-glow-intensity')?.value || 100) / 100,
    uiDensity: String(qs('appearance-ui-density')?.value || 'normal').trim(),
    borderStyle: String(qs('appearance-border-style')?.value || 'sharp').trim(),
    fontPreset: String(qs('appearance-font-preset')?.value || 'modern').trim(),
  });
}

export async function saveSettings() {
  const payload = collectSettings();
  const data = await fetchJson(`${BASE}/api/settings/appearance`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  state.settings = normalizeSettings(data.settings || payload);
  applyTheme(getCurrentTheme());
  applyAppearanceControls();
  applyWorkspaceBackground(getCurrentBackground());
  renderSettings();
  return data;
}

function slugify(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `custom-theme-${Date.now()}`;
}

export async function saveCustomTheme() {
  const current = getCurrentTheme();
  const customThemeName = String(qs('custom-theme-name')?.value || '').trim() || 'Custom Theme';
  const colors = {};
  for (const [key] of THEME_COLOR_FIELDS) colors[key] = qs(`theme-color-${key}`)?.value || current?.colors?.[key] || '#000000';
  colors.amberGlow = current?.colors?.amberGlow || 'rgba(204, 153, 51, 0.4)';
  colors.paneBg = current?.colors?.paneBg || 'rgba(20, 24, 32, 0.85)';
  const theme = { id: slugify(customThemeName), name: customThemeName, colors };
  const data = await fetchJson(`${BASE}/api/settings/appearance/theme`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }),
  });
  state.settings = normalizeSettings(data.settings || state.settings);
  state.themes = data.themes || state.themes;
  applyTheme(getCurrentTheme());
  applyAppearanceControls();
  renderSettings();
  return data;
}

export async function uploadWorkspaceBackground() {
  const input = qs('workspace-background-upload-input');
  const status = qs('workspace-background-upload-status');
  const file = input?.files?.[0];
  if (!file) {
    if (status) status.textContent = 'Pick an image first.';
    return null;
  }
  const form = new FormData();
  form.append('background', file, file.name);
  if (status) { status.dataset.busy = '1'; status.textContent = `Uploading ${file.name}...`; }
  try {
    const data = await fetchJson(`${BASE}/api/settings/appearance/background`, { method: 'POST', body: form });
    state.settings = normalizeSettings(data.settings || state.settings);
    state.backgrounds = data.backgrounds || state.backgrounds;
    applyWorkspaceBackground(getCurrentBackground());
    renderSettings();
    if (input) input.value = '';
    if (status) status.textContent = `${data.background?.name || file.name} uploaded.`;
    return data;
  } finally {
    if (status) delete status.dataset.busy;
  }
}

function previewCurrentAppearance() {
  state.settings = collectSettings();
  applyTheme(getCurrentTheme());
  applyAppearanceControls();
  applyWorkspaceBackground(getCurrentBackground());
  renderSettings();
}

function installHandlers() {
  qs('appearance-theme-select')?.addEventListener('change', () => {
    state.settings.themeId = String(qs('appearance-theme-select')?.value || '').trim();
    applyTheme(getCurrentTheme());
    updateCustomThemeInputs(getCurrentTheme());
  });
  qs('workspace-background-select')?.addEventListener('change', () => {
    state.settings.workspaceBackgroundId = String(qs('workspace-background-select')?.value || '').trim();
    applyWorkspaceBackground(getCurrentBackground());
  });
  qs('workspace-background-upload-btn')?.addEventListener('click', uploadWorkspaceBackground);
  qs('save-custom-theme-btn')?.addEventListener('click', saveCustomTheme);
  for (const id of ['appearance-panel-opacity', 'appearance-blur-strength', 'appearance-glow-intensity', 'appearance-ui-density', 'appearance-border-style', 'appearance-font-preset']) {
    qs(id)?.addEventListener('input', previewCurrentAppearance);
    qs(id)?.addEventListener('change', previewCurrentAppearance);
  }
  for (const [key] of THEME_COLOR_FIELDS) {
    qs(`theme-color-${key}`)?.addEventListener('input', () => {
      const current = getCurrentTheme();
      const theme = { ...current, colors: { ...(current?.colors || {}), [key]: qs(`theme-color-${key}`)?.value || current?.colors?.[key] } };
      applyTheme(theme);
    });
  }
}

function buildThemeEditorHtml() {
  return THEME_COLOR_FIELDS.map(([key]) => `<label class="theme-color-field"><span>${esc(key)}</span><input id="theme-color-${esc(key)}" type="color"></label>`).join('');
}

export function mountThemeEditor() {
  const mount = qs('custom-theme-colors');
  if (mount && !mount.dataset.ready) {
    mount.innerHTML = buildThemeEditorHtml();
    mount.dataset.ready = '1';
  }
}

export async function init({ office } = {}) {
  officeModule = office || null;
  mountThemeEditor();
  installHandlers();
  await refresh();
}
