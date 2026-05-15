export async function loadGeminiRuntimeConfig() {
  const missionControlUrl = String(process.env.MISSION_CONTROL_URL || 'https://your-domain.example/missioncontrol').replace(/\/$/, '');
  try {
    const res = await fetch(`${missionControlUrl}/api/user/gemini-key`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Mission Control Gemini config failed (${res.status})`);
    const json = await res.json();
    return {
      ok: Boolean(json?.hasApiKey),
      hasApiKey: Boolean(json?.hasApiKey),
      apiKey: String(json?.apiKey || ''),
      model: String(json?.model || 'gemini-3.1-flash-live-preview'),
      responseModalities: Array.isArray(json?.responseModalities) ? json.responseModalities : ['AUDIO'],
      thinkingLevel: String(json?.thinkingLevel || 'minimal'),
      source: 'mission-control',
    };
  } catch (error) {
    return {
      ok: false,
      hasApiKey: false,
      apiKey: '',
      model: 'gemini-3.1-flash-live-preview',
      responseModalities: ['AUDIO'],
      thinkingLevel: 'minimal',
      source: 'mission-control',
      error: error.message || 'Gemini config unavailable',
    };
  }
}
