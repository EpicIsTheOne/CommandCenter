const BASE = window.__BASE_PATH__ || '';
let state = { title: 'OpenClaw Command Center', subtitle: 'Mission Control', logoUrl: '', faviconUrl: '' };

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function qs(id) { return document.getElementById(id); }
function setStatus(text, isError = false) {
  const el = qs('branding-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--red)' : '';
}

function apply() {
  document.title = state.title || 'OpenClaw Command Center';
  const title = qs('app-brand-title');
  const subtitle = qs('app-brand-subtitle');
  const logo = qs('app-brand-logo');
  if (title) title.textContent = state.title || 'OpenClaw Command Center';
  if (subtitle) subtitle.textContent = state.subtitle || 'Mission Control';
  if (logo) {
    if (state.logoUrl) {
      logo.src = state.logoUrl;
      logo.classList.remove('hidden');
    } else {
      logo.classList.add('hidden');
      logo.removeAttribute('src');
    }
  }
  if (state.faviconUrl) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = state.faviconUrl;
  }
}

export async function refresh() {
  const data = await fetchJson(`${BASE}/api/settings/branding`);
  state = data.settings || state;
  if (qs('branding-title')) qs('branding-title').value = state.title || '';
  if (qs('branding-subtitle')) qs('branding-subtitle').value = state.subtitle || '';
  apply();
  setStatus('Branding settings loaded.');
}

export async function saveSettings() {
  const payload = {
    title: String(qs('branding-title')?.value || '').trim(),
    subtitle: String(qs('branding-subtitle')?.value || '').trim(),
  };
  setStatus('Saving branding...');
  const data = await fetchJson(`${BASE}/api/settings/branding`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  state = data.settings || state;
  apply();
  setStatus('Branding settings saved.');
}

async function upload(kind) {
  const input = qs(kind === 'logo' ? 'branding-logo-upload' : 'branding-favicon-upload');
  const file = input?.files?.[0];
  if (!file) {
    setStatus(`Pick a ${kind} file first.`, true);
    return;
  }
  const form = new FormData();
  form.append(kind, file, file.name);
  setStatus(`Uploading ${file.name}...`);
  try {
    const data = await fetchJson(`${BASE}/api/settings/branding/${kind}`, { method: 'POST', body: form });
    state = data.settings || state;
    apply();
    input.value = '';
    setStatus(`${kind === 'logo' ? 'Logo' : 'Favicon'} uploaded.`);
  } catch (err) {
    setStatus(err.message || `Failed to upload ${kind}.`, true);
    throw err;
  }
}

export function init() {
  qs('branding-logo-upload-btn')?.addEventListener('click', () => upload('logo'));
  qs('branding-favicon-upload-btn')?.addEventListener('click', () => upload('favicon'));
  qs('branding-title')?.addEventListener('input', () => {
    state = { ...state, title: String(qs('branding-title')?.value || '').trim() || 'OpenClaw Command Center' };
    apply();
    setStatus('Previewing title change. Save settings to keep it.');
  });
  qs('branding-subtitle')?.addEventListener('input', () => {
    state = { ...state, subtitle: String(qs('branding-subtitle')?.value || '').trim() || 'Mission Control' };
    apply();
    setStatus('Previewing subtitle change. Save settings to keep it.');
  });
}
