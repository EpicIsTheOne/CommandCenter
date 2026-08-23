// Command Center 3D Spaces — an optional immersive view over REAL app state.
// Every object maps to live data from /api/overview + WS events:
//   agent -> workstation (screen color = state)   task -> holo panel
//   machine -> server rack                        space -> floor plate
// Performance contract: capped pixel ratio, visibility/page-blur pause,
// adaptive frame skip under load, full disposal on teardown.
import * as THREE from '../vendor/three.module.js';

const BASE = window.__BASE_PATH__ || '';
const STATE_COLORS = {
  idle: 0x2f9e6c, thinking: 0xe0b13e, coding: 0x3ea8ff, tool_use: 0xb07ae0,
  responding: 0x36e0a8, working: 0x3ea8ff, blocked: 0xe06432, failed: 0xd83a3a,
  completed: 0x59c96a, disconnected: 0x555f6e,
};
const STATE_LABELS = {
  idle: 'IDLE', thinking: 'THINKING', coding: 'CODING', tool_use: 'RUNNING TOOL',
  responding: 'RESPONDING', working: 'WORKING', blocked: 'BLOCKED', failed: 'FAILED',
  completed: 'COMPLETED', disconnected: 'OFFLINE',
};

function stateColor(state = '') {
  return STATE_COLORS[String(state || '').toLowerCase()] || STATE_COLORS.idle;
}

function stateLabel(state = '') {
  return STATE_LABELS[String(state || '').toLowerCase()] || String(state || 'idle').replace(/_/g, ' ').toUpperCase();
}

export class SpaceScene {
  constructor({ container, onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.data = { agents: [], tasks: [], machines: [], spaces: [], counts: {} };
    this.currentSpaceId = '';
    this.selectedRef = null; // {kind, id}
    this.disposed = false;
    this.visible = false;
    this.frameSkip = 1;
    this._consecutiveSlowFrames = 0;
    this._clock = new THREE.Clock();
    this._accum = 0;
    this._raycaster = new THREE.Raycaster();
    this._pointerNdc = new THREE.Vector2();
    this._hovered = null;
    this._clickCandidates = [];
    this._labelPool = [];
    this._buildRenderer();
    this._buildScene();
    this._bindEvents();
    // Debug/QA hook: lets headless tests project scene objects to screen space.
    if (typeof window !== 'undefined') window.__cc3dScene = this;
  }

  _buildRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setSize(this.container.clientWidth || 1280, this.container.clientHeight || 720);
    this.renderer.domElement.classList.add('cc3d-canvas');
    this.container.appendChild(this.renderer.domElement);
  }

  _buildScene() {
    const scene = new THREE.Scene();
    scene.background = null;
    scene.fog = new THREE.Fog(0x0a0e14, 42, 110);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(52, (this.container.clientWidth || 16) / (this.container.clientHeight || 9), 0.1, 400);
    this.camera.position.set(18, 15, 22);
    this.camera.lookAt(0, 1.5, 0);

    // Camera orbit rig (custom minimal orbit — no external controls dep)
    this.orbit = { theta: Math.PI * 0.25, phi: 0.98, radius: 34, targetY: 1.5 };
    this._applyCamera();

    const hemi = new THREE.HemisphereLight(0x8fb7d8, 0x14181f, 0.85);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.75);
    dir.position.set(12, 26, 10);
    scene.add(dir);
    const rim = new THREE.DirectionalLight(0x3ea8ff, 0.28);
    rim.position.set(-14, 10, -12);
    scene.add(rim);

    // Size once on first visibility — the container is hidden at construction
    // time (display:none reports 0x0), so trust the CSS flex layout instead.
    this._sized = false;
    this._sizeOnce = () => {
      if (this._sized || this.disposed || !this.visible) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this._sized = true;
    };

    // Floor plate for the current Space
    this.floorGroup = new THREE.Group();
    scene.add(this.floorGroup);
    const grid = new THREE.GridHelper(60, 60, 0x3f6f96, 0x22405c);
    if (grid.material) {
      grid.material.transparent = true;
      if ('opacity' in grid.material) grid.material.opacity = 0.85;
    }
    this.floorGroup.add(grid);

    this.agentsGroup = new THREE.Group();
    this.tasksGroup = new THREE.Group();
    this.machinesGroup = new THREE.Group();
    scene.add(this.agentsGroup, this.tasksGroup, this.machinesGroup);
  }

  _bindEvents() {
    this._onResize = () => {
      if (this.disposed) return;
      const w = this.container.clientWidth || 1;
      const h = this.container.clientHeight || 1;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);

    const dom = this.renderer.domElement;
    this._onPointerDown = (event) => { this._dragState = { x: event.clientX, y: event.clientY, moved: false }; };
    this._onPointerMove = (event) => {
      if (!this._dragState) return;
      const dx = event.clientX - this._dragState.x;
      const dy = event.clientY - this._dragState.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) this._dragState.moved = true;
      if (event.buttons === 1) {
        this.orbit.theta -= dx * 0.005;
        this.orbit.phi = Math.min(1.45, Math.max(0.25, this.orbit.phi - dy * 0.005));
        this._dragState.x = event.clientX;
        this._dragState.y = event.clientY;
        this._dragState.moved = true;
        this._applyCamera();
      }
    };
    this._onPointerUp = (event) => {
      if (this._dragState?.moved) this._lastDragEnd = Date.now();
      this._dragState = null;
    };
    // Click fires after pointerup; suppress only when an actual drag just ended.
    this._onClick = (event) => {
      if (Date.now() - (this._lastDragEnd || 0) < 200) return;
      this._handleClick(event);
    };
    this._onWheel = (event) => {
      event.preventDefault();
      this.orbit.radius = Math.min(80, Math.max(10, this.orbit.radius + event.deltaY * 0.03));
      this._applyCamera();
    };
    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerup', this._onPointerUp);
    dom.addEventListener('click', this._onClick);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    this._onContext = (event) => event.preventDefault();
    dom.addEventListener('contextmenu', this._onContext);
  }

  _applyCamera() {
    const { theta, phi, radius } = this.orbit;
    this.camera.position.set(
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta),
    );
    this.camera.lookAt(0, this.orbit.targetY, 0);
  }

  _pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointerNdc, this.camera);
    const hits = this._raycaster.intersectObjects(this._clickCandidates, false);
    return hits.length ? hits[0].object : null;
  }

  _handleClick(event) {
    const hit = this._pick(event);
    if (!hit) return;
    const ref = hit.userData?.ccRef;
    if (ref) {
      this.selectedRef = { ...ref };
      this._refreshSelectionHighlight();
      this.onSelect(ref);
    }
  }

  _makeLabel(text, accent = '#9fd8ff') {
    const canvas = document.createElement('canvas');
    const scale = 2;
    const width = 512;
    const height = 112;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(8, 12, 18, 0.82)';
    ctx.roundRect ? ctx.roundRect(0, 0, width, height, 14) : ctx.rect(0, 0, width, height);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(1, 1, width - 2, height - 2, 14) : ctx.rect(1, 1, width - 2, height - 2);
    ctx.stroke();
    ctx.fillStyle = '#eaf4ff';
    ctx.font = '600 44px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(text || '').slice(0, 20), width / 2, height / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(5.4, 1.19, 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  _disposeObject(root) {
    root.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : (node.material ? [node.material] : []);
      for (const material of materials) {
        if (material.map) material.map.dispose();
        material.dispose();
      }
    });
  }

  _clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      this._disposeObject(child);
      group.remove(child);
    }
  }

  setData(data = {}) {
    this.data = {
      agents: Array.isArray(data.agents) ? data.agents : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      machines: Array.isArray(data.machines) ? data.machines : [],
      spaces: Array.isArray(data.spaces) ? data.spaces : [],
      counts: data.counts || {},
    };
    if (this.visible) this.rebuild();
  }

  setCurrentSpace(spaceId = '') {
    this.currentSpaceId = String(spaceId || '');
    if (this.visible) this.rebuild();
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.visible) {
      // The container just became visible; size to its real box now.
      this._sizeOnce();
      this.rebuild();
      this.startLoop();
    } else {
      this.stopLoop();
    }
  }

  rebuild() {
    if (this.disposed) return;
    this._clearGroup(this.agentsGroup);
    this._clearGroup(this.tasksGroup);
    this._clearGroup(this.machinesGroup);
    this._clickCandidates = [];

    const space = this.data.spaces.find((entry) => entry.id === this.currentSpaceId) || null;
    const memberIds = space ? new Set([
      ...space.members.agents.ids,
      ...space.members.tasks.ids,
      ...space.members.machines.ids,
    ]) : null;

    let agents = this.data.agents.filter((agent) => !memberIds || memberIds.has(agent.id));
    let tasks = this.data.tasks.filter((task) => !memberIds || memberIds.has(task.id) || task.spaceId === this.currentSpaceId);
    let machines = this.data.machines.filter((machine) => machine.kind === 'local' || !memberIds || memberIds.has(machine.id));
    if (!agents.length && this.data.agents.length) agents = this.data.agents.slice(0, 12);
    if (!tasks.length && this.data.tasks.length) tasks = this.data.tasks.slice(0, 12);

    // Agents -> workstations in a ring
    const ringRadius = Math.min(9 + agents.length * 0.9, 17);
    agents.forEach((agent, index) => {
      const angle = (index / Math.max(agents.length, 1)) * Math.PI * 2;
      const station = this._buildWorkstation(agent);
      station.position.set(Math.cos(angle) * ringRadius, 0, Math.sin(angle) * ringRadius);
      station.rotation.y = -angle + Math.PI / 2;
      this.agentsGroup.add(station);
      this._registerClickable(station, { kind: 'agent', id: agent.id, label: agent.label });

      const label = this._makeLabel(agent.label, '#' + new THREE.Color(stateColor(agent.state)).getHexString());
      label.position.set(Math.cos(angle) * ringRadius, 5.1, Math.sin(angle) * ringRadius);
      label.userData.ccRef = { kind: 'agent', id: agent.id, label: agent.label };
      this.agentsGroup.add(label);
      this._labelPool.push(label);
      this._clickCandidates.push(label);
    });

    // Tasks -> holo panels on an inner arc
    tasks.slice(0, 12).forEach((task, index) => {
      const active = !['completed', 'cancelled', 'failed'].includes(String(task.state || ''));
      const panel = this._buildTaskPanel(task, active);
      const angle = (index / Math.max(tasks.slice(0, 12).length, 1)) * Math.PI * 2 + Math.PI / Math.max(tasks.slice(0, 12).length, 2);
      const radius = ringRadius * 0.55;
      panel.position.set(Math.cos(angle) * radius, 1.6, Math.sin(angle) * radius);
      panel.rotation.y = -angle + Math.PI / 2;
      this.tasksGroup.add(panel);
      this._registerClickable(panel, { kind: 'task', id: task.id, label: task.title });
    });

    // Machines -> racks along the back edge
    machines.forEach((machine, index) => {
      const rack = this._buildServerRack(machine);
      rack.position.set(-18 + index * 7, 0, -20);
      this.machinesGroup.add(rack);
      this._registerClickable(rack, { kind: 'machine', id: machine.id, label: machine.label });
    });

    this._refreshSelectionHighlight();
  }

  _registerClickable(root, ref) {
    root.traverse((node) => {
      if (node.isMesh) {
        node.userData.ccRef = ref;
        this._clickCandidates.push(node);
      }
    });
  }

  _buildWorkstation(agent) {
    const group = new THREE.Group();
    const screenColor = stateColor(agent.state);
    const online = agent.online !== false;

    // Desk
    const deskMaterial = new THREE.MeshStandardMaterial({ color: 0x232b38, roughness: 0.85 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.22, 2.4), deskMaterial);
    desk.position.y = 1.55;
    group.add(desk);
    for (const [lx, lz] of [[-2.0, -0.95], [2.0, -0.95], [-2.0, 0.95], [2.0, 0.95]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.55, 0.16), new THREE.MeshStandardMaterial({ color: 0x161c26 }));
      leg.position.set(lx, 0.78, lz);
      group.add(leg);
    }
    // Monitor
    const monitorBody = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.5, 0.09), new THREE.MeshStandardMaterial({ color: 0x0d1117, roughness: 0.6 }));
    monitorBody.position.set(0, 2.65, -0.55);
    monitorBody.rotation.x = -0.08;
    group.add(monitorBody);
    const screenMaterial = new THREE.MeshBasicMaterial({ color: online ? screenColor : 0x22262e });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.38, 1.3), screenMaterial);
    screen.position.set(0, 2.65, -0.49);
    screen.rotation.x = -0.08;
    group.add(screen);
    group.userData.screenMaterial = screenMaterial;
    // Status light strip
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 0.05), new THREE.MeshBasicMaterial({ color: online ? screenColor : 0x333a44 }));
    strip.position.set(0, 1.86, -0.5);
    group.add(strip);
    group.userData.stripMaterial = strip.material;
    // Chair
    const chairSeat = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.14, 1.1), new THREE.MeshStandardMaterial({ color: 0x2c3342 }));
    chairSeat.position.set(0, 0.92, 1.7);
    group.add(chairSeat);
    const chairBack = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.15, 0.12), new THREE.MeshStandardMaterial({ color: 0x2c3342 }));
    chairBack.position.set(0, 1.55, 2.2);
    group.add(chairBack);
    // Offline dim
    if (!online) group.traverse((node) => { if (node.isMesh && node.material?.color) node.material.color.multiplyScalar(0.55); });
    return group;
  }

  _buildTaskPanel(task, active) {
    const group = new THREE.Group();
    const tone = active ? 0x36e0a8 : ({ failed: 0xd83a3a, cancelled: 0x666e7a, completed: 0x59c96a })[task.state] || 0x8fa3b8;
    const frame = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.7), new THREE.MeshBasicMaterial({
      color: tone, transparent: true, opacity: active ? 0.32 : 0.16, side: THREE.DoubleSide,
    }));
    group.add(frame);
    const core = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 1.4), new THREE.MeshBasicMaterial({
      color: 0x9fd8ff, transparent: true, opacity: active ? 0.1 : 0.05, side: THREE.DoubleSide,
    }));
    core.position.z = 0.01;
    group.add(core);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.7, 0.1), new THREE.MeshBasicMaterial({ color: tone }));
    bar.position.set(-1.7, 0, 0.02);
    group.add(bar);
    group.userData.pulseMaterial = active ? frame.material : null;
    return group;
  }

  _buildServerRack(machine) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 4.4, 1.8), new THREE.MeshStandardMaterial({ color: 0x18202b, roughness: 0.7 }));
    body.position.y = 2.2;
    group.add(body);
    const load = Number(machine.cpuPercent);
    const ledColor = !machine.online ? 0x333a44 : (load == null ? 0x3ea8ff : (load > 90 ? 0xe06432 : load > 70 ? 0xe0b13e : 0x2f9e6c));
    for (let i = 0; i < 5; i++) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.05), new THREE.MeshBasicMaterial({ color: ledColor }));
      led.position.set(0.85, 0.9 + i * 0.62, 0.93);
      led.userData.ledIndex = i;
      group.add(led);
      if (i === 0) group.userData.leds = [];
      group.userData.leds.push(led);
    }
    return group;
  }

  _refreshSelectionHighlight() {
    // Simple emissive pulse on selected labels via scale
    for (const label of this._labelPool) {
      const isSelected = this.selectedRef && label.userData.ccRef && label.userData.ccRef.kind === this.selectedRef.kind && label.userData.ccRef.id === this.selectedRef.id;
      label.scale.set(isSelected ? 6.4 : 5.4, isSelected ? 1.41 : 1.19, 1);
    }
  }

  startLoop() {
    if (this.disposed || this._raf) return;
    const tick = () => {
      if (this.disposed) return;
      this._raf = requestAnimationFrame(tick);
      if (!this.visible || document.hidden) return; // hard pause when hidden/minimized
      const delta = Math.min(this._clock.getDelta(), 0.1);
      this._accum += delta;
      // Adaptive frame skip: sustained slow frames halve render rate (down to 30->15fps)
      if (delta > 0.04) this._consecutiveSlowFrames++;
      else this._consecutiveSlowFrames = Math.max(0, this._consecutiveSlowFrames - 1);
      this.frameSkip = this._consecutiveSlowFrames > 40 ? 2 : 1;
      if (this.frameSkip === 2 && Math.floor(this._accum * 1000) % 2 === 0) return;

      const t = this._clock.elapsedTime;
      // Animate: thinking/workstations glow-pulse, task panels breathe, rack LEDs blink
      this.scene.traverse(() => {}); // keep hot path lean
      this._animate(t);
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _animate(t) {
    // Screen-strip pulse on agent workstations, panel breathing, rack LED blink.
    for (const station of this.agentsGroup.children) {
      const strip = station.userData?.stripMaterial;
      if (!strip) continue;
      if (!station.userData.baseStripColor) station.userData.baseStripColor = strip.color.getHex();
      const pulse = 0.68 + 0.32 * Math.abs(Math.sin(t * 2.1 + station.position.x));
      strip.color.setHex(station.userData.baseStripColor).multiplyScalar(pulse);
    }
    for (const panel of this.tasksGroup.children) {
      const material = panel.userData?.pulseMaterial;
      if (!material) continue;
      material.opacity = 0.26 + 0.12 * Math.sin(t * 1.7 + panel.position.z);
    }
    for (const rack of this.machinesGroup.children) {
      const leds = rack.userData?.leds;
      if (!Array.isArray(leds)) continue;
      leds.forEach((led, index) => {
        led.visible = ((Math.floor(t * 1.6) + index) % 5) !== 0;
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.stopLoop();
    window.removeEventListener('resize', this._onResize);
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    dom.removeEventListener('pointerup', this._onPointerUp);
    dom.removeEventListener('click', this._onClick);
    dom.removeEventListener('wheel', this._onWheel);
    dom.removeEventListener('contextmenu', this._onContext);
    this._clearGroup(this.agentsGroup);
    this._clearGroup(this.tasksGroup);
    this._clearGroup(this.machinesGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
