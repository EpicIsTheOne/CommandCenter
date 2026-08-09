(() => {
  const params = new URLSearchParams(window.location.search);
  const modelUrl = params.get('model') || '';
  let currentState = params.get('state') || 'idle';
  let speaking = currentState === 'speaking';
  let voiceLevel = 0;
  let lastVoiceLevelAt = 0;
  const statusEl = document.getElementById('status');
  const canvas = document.getElementById('stage');
  let model = null;
  let app = null;
  let mouthTime = 0;
  let lastMotionState = '';

  function safeText(value) {
    return String(value || '').replace(/</g, '&lt;');
  }

  function setStatus(message, kind = '') {
    if (!statusEl) return;
    statusEl.className = kind === 'hidden' ? 'hidden' : kind;
    statusEl.innerHTML = message;
  }

  function fitModel(nextModel = model, nextApp = app) {
    if (!nextModel || !nextApp?.renderer) return;
    const width = Math.max(1, nextApp.renderer.width || window.innerWidth || 1);
    const height = Math.max(1, nextApp.renderer.height || window.innerHeight || 1);
    const bounds = nextModel.getLocalBounds();
    const bw = Math.max(1, bounds.width || 1);
    const bh = Math.max(1, bounds.height || 1);
    const scale = Math.min(width / bw, height / bh) * 0.86;
    nextModel.scale.set(scale);
    nextModel.x = (width - bw * scale) / 2 - bounds.x * scale;
    nextModel.y = (height - bh * scale) / 2 - bounds.y * scale;
  }

  function setCubismParam(id, value) {
    try {
      const core = model?.internalModel?.coreModel;
      if (!core) return false;
      if (typeof core.setParameterValueById === 'function') {
        core.setParameterValueById(id, value);
        return true;
      }
      const index = typeof core.getParameterIndex === 'function' ? core.getParameterIndex(id) : -1;
      if (index >= 0 && typeof core.setParameterValueByIndex === 'function') {
        core.setParameterValueByIndex(index, value);
        return true;
      }
    } catch {}
    return false;
  }

  function applyState(nextState = currentState) {
    currentState = nextState || 'idle';
    speaking = currentState === 'speaking' || speaking === true && currentState !== 'idle';
    if (!model || lastMotionState === currentState) return;
    lastMotionState = currentState;
    try {
      if (currentState === 'speaking') model.motion?.('TapBody');
      else if (currentState === 'thinking') model.motion?.('TapHead');
      else model.motion?.('Idle');
    } catch {}
  }

  function tickMouth(delta = 1) {
    if (!model) return;
    mouthTime += delta / 60;
    const freshVoiceLevel = Date.now() - lastVoiceLevelAt < 180;
    const fallback = speaking ? 0.12 + Math.abs(Math.sin(mouthTime * 15)) * 0.36 : 0;
    const target = freshVoiceLevel ? Math.min(1, voiceLevel * 1.35) : fallback;
    setCubismParam('ParamMouthOpenY', target);
    if (target > 0.02) setCubismParam('ParamMouthForm', Math.sin(mouthTime * 7) * Math.min(0.4, target));
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.type === 'commandcenter-live2d-mouth-level') {
      voiceLevel = Math.max(0, Math.min(1, Number(data.level) || 0));
      lastVoiceLevelAt = Date.now();
      speaking = voiceLevel > 0.025 || speaking;
      return;
    }
    if (data.type !== 'commandcenter-live2d-state') return;
    speaking = !!data.speaking || data.state === 'speaking';
    if (!speaking) voiceLevel = 0;
    applyState(data.state || (speaking ? 'speaking' : 'idle'));
  });

  async function boot() {
    if (!modelUrl) {
      setStatus('<span class="bad">No Live2D model URL was provided.</span>');
      return;
    }
    if (!window.PIXI || !window.PIXI.live2d?.Live2DModel) {
      setStatus('<span class="bad">Live2D web runtime failed to load.</span><br><span class="muted">CommandCenter tried the automatic web viewer, but the Live2D runtime was unavailable.</span>');
      return;
    }

    window.PIXI.settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = false;
    app = new window.PIXI.Application({
      view: canvas,
      autoStart: true,
      transparent: true,
      antialias: true,
      resizeTo: window,
      backgroundAlpha: 0,
    });

    setStatus(`Loading model…<br><span class="muted">${safeText(modelUrl)}</span>`);
    model = await window.PIXI.live2d.Live2DModel.from(modelUrl, { autoInteract: false });
    model.interactive = false;
    model.eventMode = 'none';
    app.stage.interactive = false;
    app.stage.eventMode = 'none';
    app.stage.addChild(model);
    fitModel(model, app);
    window.addEventListener('resize', () => fitModel(model, app));
    app.ticker.add(tickMouth);
    applyState(currentState);
    setStatus('', 'hidden');
    window.parent?.postMessage({ type: 'commandcenter-live2d-ready' }, window.location.origin);
  }

  boot().catch((err) => {
    console.error('[live2d-viewer] failed', err);
    setStatus(`<span class="bad">Live2D viewer failed:</span> ${safeText(err?.message || err)}<br><span class="muted">If this is a full Live2D model, upload the entire model folder as a zip so textures/motions stay beside the model JSON.</span>`);
  });
})();
