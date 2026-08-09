const runtimeMap = new WeakMap();
let libsPromise = null;
const DEFAULT_SPEAKING_VRMA_URL = '';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadVrmLibs() {
  if (!libsPromise) {
    libsPromise = (async () => {
      const THREE = await import('https://esm.sh/three@0.180.0');
      const { GLTFLoader } = await import('https://esm.sh/three@0.180.0/examples/jsm/loaders/GLTFLoader.js');
      const { VRMLoaderPlugin, VRMUtils } = await import('https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.180.0');
      const { createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } = await import('https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.180.0');
      return { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy };
    })();
  }
  return libsPromise;
}

function setPlaceholder(container, title, copy, tone = '') {
  if (!container) return;
  container.innerHTML = `
    <div class="sa-vrm-placeholder ${tone ? `is-${escapeHtml(tone)}` : ''}">
      <div class="sa-vrm-badge">VRM MODE</div>
      <div class="sa-vrm-title">${escapeHtml(title)}</div>
      <div class="sa-vrm-copy">${escapeHtml(copy)}</div>
      <div class="sa-vrm-note">Agent-driven VRM control uses pixiv/three-vrm in-browser. Upload or select a .vrm model and CommandCenter will start the stage automatically.</div>
    </div>
  `;
}

function cleanupRuntime(runtime) {
  if (!runtime) return;
  runtime.disposed = true;
  if (runtime.rafId) cancelAnimationFrame(runtime.rafId);
  if (runtime.resizeObserver) runtime.resizeObserver.disconnect();
  if (runtime.renderer) {
    runtime.renderer.dispose?.();
    runtime.renderer.forceContextLoss?.();
  }
  if (runtime.vrm?.scene?.parent) runtime.vrm.scene.parent.remove(runtime.vrm.scene);
  if (runtime.THREE && runtime.scene) {
    runtime.scene.traverse?.((obj) => {
      obj.geometry?.dispose?.();
      const material = obj.material;
      if (Array.isArray(material)) material.forEach((item) => item?.dispose?.());
      else material?.dispose?.();
    });
  }
  runtime.container.replaceChildren();
}

function applyBasePose(runtime) {
  const humanoid = runtime.vrm?.humanoid;
  const THREE = runtime.THREE;
  if (!humanoid || !THREE) return;
  const bone = (name) => humanoid.getNormalizedBoneNode?.(name) || null;
  const setRot = (name, x = 0, y = 0, z = 0) => {
    const node = bone(name);
    if (!node) return;
    node.rotation.set(x, y, z);
  };

  // Most VRM files load in their authoring/rest pose, often a strict T-pose.
  // Give CommandCenter a neutral "standing/listening" pose before the runtime
  // state animation adds breathing, nodding, and speaking motion.
  setRot('leftUpperArm', 0.04, -0.08, 0.98);
  setRot('rightUpperArm', 0.04, 0.08, -0.98);
  setRot('leftLowerArm', -0.10, -0.34, 0.32);
  setRot('rightLowerArm', -0.10, 0.34, -0.32);
  setRot('leftHand', -0.12, -0.06, 0.14);
  setRot('rightHand', -0.12, 0.06, -0.14);
  setRot('leftShoulder', 0, 0, 0.12);
  setRot('rightShoulder', 0, 0, -0.12);
  setRot('spine', 0.035, 0, 0);
  setRot('chest', 0.025, 0, 0);
  setRot('neck', -0.015, 0, 0);
  setRot('head', 0, 0, 0);
  runtime.basePoseApplied = true;
}

function applyExpression(runtime, mood = 'neutral', mouth = 0, blink = 0, look = { x: 0, y: 0 }) {
  const manager = runtime.vrm?.expressionManager;
  if (!manager) return;
  const presets = runtime.THREE_VRM_PRESETS;
  const safeMouth = clamp(mouth, 0, 1);
  const safeBlink = clamp(blink, 0, 1);
  const set = (name, value) => {
    if (!name) return;
    try { manager.setValue(name, clamp(value, 0, 1)); } catch {}
  };
  Object.values(presets).forEach((name) => set(name, 0));
  if (mood === 'thinking') set(presets.relaxed || presets.neutral, 0.32);
  if (mood === 'error') set(presets.sorrow || presets.angry || presets.neutral, 0.55);
  if (mood === 'speaking') set(presets.happy || presets.relaxed || presets.neutral, 0.12);
  set(presets.aa || presets.oh || presets.ee, safeMouth);
  set(presets.blink, safeBlink);
  set(presets.blinkLeft, safeBlink);
  set(presets.blinkRight, safeBlink);
  const lx = clamp(Number(look?.x || 0), -1, 1);
  const ly = clamp(Number(look?.y || 0), -1, 1);
  if (lx < -0.02) set(presets.lookLeft, -lx * 0.65);
  if (lx > 0.02) set(presets.lookRight, lx * 0.65);
  if (ly < -0.02) set(presets.lookDown, -ly * 0.45);
  if (ly > 0.02) set(presets.lookUp, ly * 0.45);
  manager.update?.();
}

function setRuntimeAction(runtime, name = 'idle') {
  if (!runtime?.actions || runtime.activeActionName === name) return;
  const next = runtime.actions[name] || runtime.actions.idle || null;
  const previous = runtime.actions[runtime.activeActionName] || null;
  if (!next) {
    if (previous) previous.fadeOut?.(0.22);
    runtime.activeActionName = '';
    return;
  }
  next.enabled = true;
  next.paused = false;
  next.play();
  if (previous && previous !== next) previous.crossFadeTo(next, 0.22, false);
  runtime.activeActionName = name;
}

async function loadVrmAnimationAction(runtime, url = '', name = 'idle') {
  const source = String(url || '').trim();
  if (!source || !runtime?.animationLoader || !runtime?.createVRMAnimationClip || !runtime?.vrm || !runtime?.mixer) return null;
  try {
    const gltf = await runtime.animationLoader.loadAsync(source);
    const vrmAnimation = gltf.userData?.vrmAnimations?.[0];
    if (!vrmAnimation) throw new Error('Animation file did not contain a VRMAnimation clip');
    const clip = runtime.createVRMAnimationClip(vrmAnimation, runtime.vrm);
    const action = runtime.mixer.clipAction(clip);
    action.enabled = true;
    action.clampWhenFinished = false;
    action.setLoop(runtime.THREE.LoopRepeat, Infinity);
    action.weight = 1;
    runtime.actions[name] = action;
    return action;
  } catch (err) {
    console.warn(`[vrm-stage] Failed to load ${name} VRMA animation:`, err?.message || err);
    return null;
  }
}

function updateBlinkAndLook(runtime, now = performance.now()) {
  if (!runtime) return;
  if (!runtime.nextBlinkAt) runtime.nextBlinkAt = now + 1200 + Math.random() * 1800;
  const blinkWindow = 165;
  const blinkProgress = 1 - Math.abs((now - runtime.nextBlinkAt) / (blinkWindow / 2));
  runtime.blinkValue = clamp(blinkProgress, 0, 1);
  if (now > runtime.nextBlinkAt + blinkWindow) {
    const quickDouble = Math.random() < 0.16 ? 210 : 0;
    runtime.nextBlinkAt = now + quickDouble + 1900 + Math.random() * 3900;
  }

  runtime.lookCurrent ||= { x: 0, y: 0 };
  runtime.lookFrom ||= { ...runtime.lookCurrent };
  runtime.lookTarget ||= { x: 0, y: 0 };
  if (!runtime.nextLookAt || now > runtime.nextLookAt) {
    const speakingBias = runtime.state === 'speaking' ? 0.45 : 1;
    runtime.lookFrom = { ...runtime.lookCurrent };
    runtime.lookTarget = {
      x: (Math.random() * 2 - 1) * 0.22 * speakingBias,
      y: (Math.random() * 2 - 1) * 0.11 * speakingBias,
    };
    runtime.lookStartedAt = now;
    runtime.lookDurationMs = 1700 + Math.random() * 1700;
    runtime.nextLookAt = now + runtime.lookDurationMs + 900 + Math.random() * 2600;
  }

  const progress = clamp((now - (runtime.lookStartedAt || now)) / Math.max(1, runtime.lookDurationMs || 1800), 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  const driftT = (now - runtime.startedAt) / 1000;
  const seed = runtime.gazeSeed || 0;
  const driftX = Math.sin(driftT * 0.27 + seed) * 0.035 + Math.sin(driftT * 0.11 + seed * 0.7) * 0.025;
  const driftY = Math.sin(driftT * 0.21 + seed * 1.3) * 0.022;
  runtime.lookCurrent.x = runtime.lookFrom.x + (runtime.lookTarget.x - runtime.lookFrom.x) * eased + driftX;
  runtime.lookCurrent.y = runtime.lookFrom.y + (runtime.lookTarget.y - runtime.lookFrom.y) * eased + driftY;
}

function applyStatePose(runtime, elapsedMs = 0) {
  const vrm = runtime.vrm;
  const humanoid = vrm?.humanoid;
  if (!humanoid) return;
  const t = elapsedMs / 1000;
  const state = runtime.state || 'idle';
  updateBlinkAndLook(runtime, performance.now());
  const usingClip = !!(runtime.actions && (state === 'speaking' ? runtime.actions.speaking : runtime.actions.idle));
  setRuntimeAction(runtime, state === 'speaking' ? 'speaking' : 'idle');
  const amp = state === 'speaking' ? 1 : state === 'thinking' ? 0.7 : state === 'error' ? 0.25 : 0.58;
  const breathing = Math.sin(t * (state === 'idle' ? 0.78 : state === 'thinking' ? 0.58 : 1.18)) * 0.034 * amp;
  const sway = Math.sin(t * (state === 'idle' ? 0.38 : state === 'thinking' ? 0.32 : state === 'speaking' ? 1.05 : 0.28)) * 0.072 * amp;
  const nod = Math.sin(t * (state === 'speaking' ? 3.15 : 0.82)) * (state === 'speaking' ? 0.035 : 0.014);
  const talkBeat = state === 'speaking' ? Math.sin(t * 2.65) : 0;
  const lookX = runtime.lookCurrent?.x || 0;
  const lookY = runtime.lookCurrent?.y || 0;
  const head = humanoid.getNormalizedBoneNode?.('head');
  const spine = humanoid.getNormalizedBoneNode?.('spine');
  const chest = humanoid.getNormalizedBoneNode?.('chest');
  const neck = humanoid.getNormalizedBoneNode?.('neck');
  const leftUpperArm = humanoid.getNormalizedBoneNode?.('leftUpperArm');
  const rightUpperArm = humanoid.getNormalizedBoneNode?.('rightUpperArm');
  const leftLowerArm = humanoid.getNormalizedBoneNode?.('leftLowerArm');
  const rightLowerArm = humanoid.getNormalizedBoneNode?.('rightLowerArm');
  const leftHand = humanoid.getNormalizedBoneNode?.('leftHand');
  const rightHand = humanoid.getNormalizedBoneNode?.('rightHand');
  if (!usingClip) {
    if (spine) {
      spine.rotation.z = sway * 0.24;
      spine.rotation.x = 0.035 + breathing + (state === 'error' ? 0.12 : 0);
    }
    if (chest) {
      chest.rotation.x = 0.025 + breathing * 0.8 + (state === 'speaking' ? Math.max(0, talkBeat) * 0.012 : 0);
      chest.rotation.y = state === 'speaking' ? talkBeat * 0.018 : sway * 0.16;
      chest.rotation.z = sway * 0.08;
    }
    if (leftUpperArm) {
      leftUpperArm.rotation.x = 0.04 + Math.sin(t * 0.43) * 0.012;
      leftUpperArm.rotation.y = -0.08 + Math.sin(t * 0.37 + 0.6) * 0.012;
      leftUpperArm.rotation.z = 0.98 + Math.sin(t * 0.55) * 0.018 + (state === 'speaking' ? Math.max(0, talkBeat) * 0.028 : 0);
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.x = 0.04 + Math.sin(t * 0.41 + 0.3) * 0.012;
      rightUpperArm.rotation.y = 0.08 + Math.sin(t * 0.36 + 0.9) * 0.012;
      rightUpperArm.rotation.z = -0.98 - Math.sin(t * 0.52 + 0.8) * 0.018 - (state === 'speaking' ? Math.max(0, -talkBeat) * 0.028 : 0);
    }
    if (leftLowerArm) {
      leftLowerArm.rotation.x = -0.10 + Math.sin(t * 0.48 + 0.2) * 0.018;
      leftLowerArm.rotation.y = -0.34 + (state === 'speaking' ? Math.sin(t * 1.8) * 0.035 : Math.sin(t * 0.34) * 0.015);
      leftLowerArm.rotation.z = 0.32 + (state === 'speaking' ? Math.sin(t * 1.9) * 0.038 : Math.sin(t * 0.42) * 0.014);
    }
    if (rightLowerArm) {
      rightLowerArm.rotation.x = -0.10 + Math.sin(t * 0.45 + 0.8) * 0.018;
      rightLowerArm.rotation.y = 0.34 + (state === 'speaking' ? Math.sin(t * 1.75 + 1.1) * 0.035 : Math.sin(t * 0.31 + 0.5) * 0.015);
      rightLowerArm.rotation.z = -0.32 - (state === 'speaking' ? Math.sin(t * 1.85 + 1.3) * 0.038 : Math.sin(t * 0.39 + 0.5) * 0.014);
    }
    if (leftHand) {
      leftHand.rotation.x = -0.12 + Math.sin(t * 0.62 + 0.4) * 0.02;
      leftHand.rotation.y = -0.06 + Math.sin(t * 0.46 + 0.2) * 0.012;
      leftHand.rotation.z = 0.14 + Math.sin(t * 0.74) * 0.018;
    }
    if (rightHand) {
      rightHand.rotation.x = -0.12 + Math.sin(t * 0.58 + 0.9) * 0.02;
      rightHand.rotation.y = 0.06 + Math.sin(t * 0.44 + 0.7) * 0.012;
      rightHand.rotation.z = -0.14 - Math.sin(t * 0.7 + 0.4) * 0.018;
    }
  }
  if (neck) {
    neck.rotation.x = nod + lookY * 0.055 + (state === 'thinking' ? 0.05 : 0) + (state === 'error' ? -0.04 : 0);
    neck.rotation.y = lookX * 0.07;
  }
  if (head) {
    head.rotation.y = sway + lookX * 0.16 + (state === 'speaking' ? talkBeat * 0.012 : 0);
    head.rotation.x = nod - lookY * 0.10 + (state === 'thinking' ? 0.06 : 0) + (state === 'error' ? 0.16 : 0);
    head.rotation.z = state === 'thinking' ? -0.06 : state === 'error' ? 0.08 : sway * 0.22;
  }
  const freshVoiceLevel = runtime.lastVoiceLevelAt && (performance.now() - runtime.lastVoiceLevelAt) < 180;
  const fallbackMouth = runtime.speaking ? (0.12 + (Math.sin(t * 10.5) * 0.5 + 0.5) * 0.34) : 0;
  const mouth = freshVoiceLevel ? clamp(Number(runtime.voiceLevel || 0) * 1.35, 0, 1) : fallbackMouth;
  applyExpression(runtime, state, mouth, runtime.blinkValue || 0, runtime.lookCurrent || { x: 0, y: 0 });
}

function startLoop(runtime) {
  const loop = (now) => {
    if (runtime.disposed) return;
    const elapsed = now - runtime.startedAt;
    const delta = Math.min(0.05, runtime.clock.getDelta());
    runtime.mixer?.update?.(delta);
    runtime.vrm?.update?.(delta);
    if (runtime.visual?.vrm?.lookAtCamera !== false && runtime.vrm?.lookAt?.target && runtime.camera) {
      runtime.vrm.lookAt.target.position.copy(runtime.camera.position);
    }
    applyStatePose(runtime, elapsed);
    runtime.renderer.render(runtime.scene, runtime.camera);
    runtime.rafId = requestAnimationFrame(loop);
  };
  runtime.rafId = requestAnimationFrame(loop);
}

function resizeRuntime(runtime) {
  const rect = runtime.container.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width || 300));
  const height = Math.max(1, Math.floor(rect.height || 280));
  runtime.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  runtime.renderer.setSize(width, height, false);
  runtime.camera.aspect = width / height;
  runtime.camera.updateProjectionMatrix();
}

export async function mountVrmStage(container, visual = {}, options = {}) {
  if (!container) return null;
  unmountVrmStage(container);
  const vrmConfig = visual?.vrm || visual || {};
  const modelUrl = String(vrmConfig.modelUrl || '').trim();
  if (!modelUrl) {
    setPlaceholder(container, 'No VRM model configured', 'Add a .vrm model URL or path in Settings for this agent.');
    return null;
  }
  setPlaceholder(container, 'Loading VRM…', `Fetching ${modelUrl}`, 'loading');
  try {
    const { THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils, createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } = await loadVrmLibs();
    const runtime = {
      container,
      visual,
      options,
      state: 'idle',
      speaking: false,
      voiceLevel: 0,
      lastVoiceLevelAt: 0,
      blinkValue: 0,
      nextBlinkAt: performance.now() + 1200 + Math.random() * 1800,
      lookFrom: { x: 0, y: 0 },
      lookTarget: { x: 0, y: 0 },
      lookCurrent: { x: 0, y: 0 },
      lookStartedAt: performance.now(),
      lookDurationMs: 1800,
      nextLookAt: performance.now() + 1600 + Math.random() * 2200,
      gazeSeed: Math.random() * Math.PI * 2,
      disposed: false,
      startedAt: performance.now(),
      clock: new THREE.Clock(),
      THREE,
      createVRMAnimationClip,
      actions: {},
      activeActionName: '',
      THREE_VRM_PRESETS: {
        aa: 'aa', oh: 'oh', ee: 'ee', ih: 'ih', ou: 'ou',
        happy: 'happy', angry: 'angry', sorrow: 'sad', relaxed: 'relaxed', neutral: 'neutral',
        blink: 'blink', blinkLeft: 'blinkLeft', blinkRight: 'blinkRight', lookUp: 'lookUp', lookDown: 'lookDown', lookLeft: 'lookLeft', lookRight: 'lookRight'
      },
    };
    runtimeMap.set(container, runtime);

    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.className = 'sa-vrm-canvas';
    container.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    runtime.renderer = renderer;

    const scene = new THREE.Scene();
    runtime.scene = scene;
    const camera = new THREE.PerspectiveCamera(28 / clamp(Number(vrmConfig.cameraZoom || 1), 0.4, 3), 1, 0.01, 40);
    camera.position.set(0, Number(vrmConfig.cameraY || 1.25), 2.25);
    runtime.camera = camera;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x2e355f, 1.45);
    const dir = new THREE.DirectionalLight(0xffffff, 1.25);
    dir.position.set(1.8, 2.3, 2.5);
    const fill = new THREE.DirectionalLight(0x99bbff, 0.55);
    fill.position.set(-1.2, 1.4, 1.6);
    scene.add(hemi, dir, fill);

    const loader = new GLTFLoader();
    loader.crossOrigin = 'anonymous';
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const animationLoader = new GLTFLoader();
    animationLoader.crossOrigin = 'anonymous';
    animationLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(modelUrl);
    if (runtime.disposed) return null;
    const vrm = gltf.userData?.vrm;
    if (!vrm) throw new Error('Loaded file did not expose a VRM runtime');
    VRMUtils.removeUnnecessaryVertices?.(gltf.scene);
    VRMUtils.removeUnnecessaryJoints?.(gltf.scene);
    vrm.scene.scale.setScalar(Number(vrmConfig.scale || visual?.scale || 1) || 1);
    const rotationY = Number.isFinite(Number(vrmConfig.rotationY ?? visual?.rotationY))
      ? Number(vrmConfig.rotationY ?? visual?.rotationY)
      : Math.PI;
    vrm.scene.rotation.y = rotationY;
    scene.add(vrm.scene);
    runtime.vrm = vrm;
    runtime.animationLoader = animationLoader;
    runtime.mixer = new THREE.AnimationMixer(vrm.scene);
    try {
      if (vrm.lookAt && VRMLookAtQuaternionProxy) {
        const lookAtQuatProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
        lookAtQuatProxy.name = 'lookAtQuaternionProxy';
        vrm.scene.add(lookAtQuatProxy);
      }
    } catch {}
    applyBasePose(runtime);

    const idleAnimUrl = String(vrmConfig.idleAnimUrl || '').trim();
    const speakingAnimUrl = String(vrmConfig.speakingAnimUrl || DEFAULT_SPEAKING_VRMA_URL).trim();
    if (idleAnimUrl) await loadVrmAnimationAction(runtime, idleAnimUrl, 'idle');
    if (speakingAnimUrl) await loadVrmAnimationAction(runtime, speakingAnimUrl, 'speaking');
    setRuntimeAction(runtime, 'idle');

    runtime.resizeObserver = new ResizeObserver(() => resizeRuntime(runtime));
    runtime.resizeObserver.observe(container);
    resizeRuntime(runtime);
    startLoop(runtime);
    return runtime;
  } catch (err) {
    const runtime = runtimeMap.get(container);
    if (runtime) cleanupRuntime(runtime);
    runtimeMap.delete(container);
    setPlaceholder(container, 'VRM failed to load', err?.message || 'Could not initialize three-vrm for this model.', 'error');
    return null;
  }
}

export function setVrmState(container, state = 'idle') {
  const runtime = runtimeMap.get(container);
  if (!runtime) return;
  runtime.state = String(state || 'idle');
}

export function setVrmSpeaking(container, speaking = false) {
  const runtime = runtimeMap.get(container);
  if (!runtime) return;
  runtime.speaking = !!speaking;
  if (!runtime.speaking) {
    runtime.voiceLevel = 0;
    runtime.lastVoiceLevelAt = 0;
  }
  if (runtime.speaking) runtime.state = 'speaking';
}

export function setVrmMouthLevel(container, level = 0) {
  const runtime = runtimeMap.get(container);
  if (!runtime) return;
  const safeLevel = clamp(Number(level) || 0, 0, 1);
  runtime.voiceLevel = safeLevel;
  runtime.lastVoiceLevelAt = performance.now();
  runtime.speaking = safeLevel > 0.025 || runtime.speaking;
  if (runtime.speaking) runtime.state = 'speaking';
}

export function refreshVrmStage(container, visual = {}) {
  const runtime = runtimeMap.get(container);
  if (!runtime) return mountVrmStage(container, visual);
  runtime.visual = visual || {};
  return runtime;
}

export function unmountVrmStage(container) {
  const runtime = runtimeMap.get(container);
  if (!runtime) {
    container?.replaceChildren?.();
    return;
  }
  cleanupRuntime(runtime);
  runtimeMap.delete(container);
}
