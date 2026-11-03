// Vani AI — OC-Lily VRM stage (three.js + @pixiv/three-vrm).
// Mounted ONLY while Live Talk is open. Adreno 613 guardrails:
//   pixelRatio = min(devicePixelRatio, 1.25)  — never native 2.75
//   dt = min(clockDelta, 0.05)                — spring bones never explode
//   60 FPS active / 24–30 FPS idle, Battery Saver caps further.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { sampleAction } from './anime.js';
import { clamp } from './util.js';

const POSE_BONES = ['hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

export class AvatarStage {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;                 // { batterySaver(), fpsTarget(), onArrive(), onReady(), onError() }
    this.vrm = null;
    this.raf = null;
    this.last = 0;
    this.time = 0;
    this.state = 'loading';           // loading | walkin | idle | action
    this.action = null;
    this.walk = null;
    this.rest = {};
    this.current = {};
    this.bones = {};
    this.speakLevel = 0;
    this.visemeIdx = 0;
    this.visemeT = 0;
    this.blinkT = 2.5;
    this.blink = 0;
    this.disposed = false;
    this.paused = false;
  }

  async init() {
    const c = this.container;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    this.renderer.setSize(c.clientWidth || 360, c.clientHeight || 640);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    c.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, (c.clientWidth || 360) / (c.clientHeight || 640), 0.1, 30);
    this.camera.position.set(0, 1.05, 3.2);
    this.camera.lookAt(0, 0.85, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(0.8, 2.2, 1.6);
    this.scene.add(key);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.ro = new ResizeObserver(() => {
      if (this.disposed) return;
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    });
    this.ro.observe(c);

    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    let gltf;
    try {
      gltf = await loader.loadAsync('assets/vrm/OC-Lily.vrm');
    } catch (e) {
      this.opts.onError?.(e);
      throw e;
    }
    if (this.disposed) return;
    const vrm = gltf.userData.vrm;
    if (!vrm) { const e = new Error('VRM extension missing'); this.opts.onError?.(e); throw e; }
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse(o => { o.frustumCulled = false; });
    this.vrm = vrm;
    this.root.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.camera;

    for (const name of POSE_BONES) {
      const n = vrm.humanoid?.getNormalizedBoneNode(name);
      if (n) this.bones[name] = n;
    }
    this.calibrateRestPose();
    this.state = 'idle';
    this.opts.onReady?.();
    this.startLoop();
  }

  /** Arms hang naturally ~10° from the torso across VRM 0.x/1.0 rigs.
   *  Sign is auto-detected by measuring where the hand lands. */
  calibrateRestPose() {
    const vrm = this.vrm;
    const DOWN = (90 - 10) * Math.PI / 180; // 80° from horizontal T-pose
    for (const side of ['left', 'right']) {
      const upper = this.bones[`${side}UpperArm`];
      const hand = this.bones[`${side}Hand`] || this.bones[`${side}LowerArm`];
      if (!upper || !hand) continue;
      let sign = side === 'left' ? 1 : -1;
      const test = s => {
        upper.rotation.set(0, 0, s * DOWN);
        vrm.scene.updateMatrixWorld(true);
        const shoulderY = upper.getWorldPosition(new THREE.Vector3()).y;
        const handY = hand.getWorldPosition(new THREE.Vector3()).y;
        return handY < shoulderY - 0.1;
      };
      if (!test(sign)) { sign = -sign; test(sign); }
      this.rest[`${side}UpperArm`] = { x: 0, y: 0, z: sign * DOWN };
      this.rest[`${side}LowerArm`] = { x: 0, y: 0, z: sign * 0.06 };
      upper.rotation.set(0, 0, 0);
    }
    for (const name of POSE_BONES) {
      if (!this.rest[name]) this.rest[name] = { x: 0, y: 0, z: 0 };
      this.current[name] = { ...this.rest[name] };
    }
    this.vrm.scene.updateMatrixWorld(true);
  }

  /** Cinematic entrance: walk in from a screen edge, stop center, face camera. */
  walkIn() {
    const side = Math.random() < 0.5 ? -1 : 1;
    this.walk = { t: 0, dur: 2.6, side };
    this.state = 'walkin';
    this.root.position.x = side * 1.5;
  }

  performAction(name) {
    if (!this.vrm || !sampleAction(name, 0)) return false;
    this.action = { name, t: 0 };
    this.state = 'action';
    return true;
  }

  setSpeaking(level) { this.speakLevel = clamp(level || 0, 0, 1); }

  targetFps() {
    const saver = !!this.opts.batterySaver?.();
    const active = this.state === 'walkin' || this.state === 'action' || this.speakLevel > 0.03;
    if (active) return saver ? 30 : (this.opts.fpsTarget?.() || 60);
    return saver ? 24 : 28;
  }

  startLoop() {
    this.last = performance.now();
    const loop = () => {
      if (this.disposed || this.paused) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const interval = 1000 / this.targetFps();
      if (now - this.last < interval - 1) return;
      const dt = Math.min((now - this.last) / 1000, 0.05); // clamp BEFORE vrm.update
      this.last = now;
      this.update(dt);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.paused = true;
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }
  resume() {
    if (this.disposed || !this.paused) return;
    this.paused = false;
    this.startLoop();
  }

  update(dt) {
    this.time += dt;
    const targets = {};
    for (const name of POSE_BONES) targets[name] = { ...this.rest[name] };
    let rootX = 0, rootY = 0, rootRotY = 0;
    let expr = {};

    // Idle breathing + subtle head life.
    if (this.state === 'idle' || this.state === 'action') {
      targets.spine.x += 0.016 * Math.sin(this.time * 1.35);
      targets.head.y += 0.045 * Math.sin(this.time * 0.55);
      targets.head.x += 0.02 * Math.sin(this.time * 0.9 + 1);
      targets.hips.z = (targets.hips.z || 0) + 0.012 * Math.sin(this.time * 0.4);
    }

    // Walk-in locomotion.
    if (this.state === 'walkin' && this.walk) {
      const w = this.walk;
      w.t += dt;
      const p = clamp(w.t / w.dur, 0, 1);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      rootX = w.side * 1.5 * (1 - ease);
      const amp = p > 0.82 ? Math.max(0, 1 - (p - 0.82) / 0.18) : 1;
      const phase = w.t * Math.PI * 2 * 1.85;
      const s = Math.sin(phase);
      rootY = Math.abs(s) * 0.032 * amp;
      const face = 1 - clamp((p - 0.78) / 0.22, 0, 1);
      rootRotY = (w.side === -1 ? 1 : -1) * (Math.PI / 2) * (face * face * (3 - 2 * face));
      targets.leftUpperLeg.x += s * 0.52 * amp;
      targets.rightUpperLeg.x += -s * 0.52 * amp;
      targets.leftLowerLeg.x += Math.max(0, Math.sin(phase - 0.9)) * 0.85 * amp;
      targets.rightLowerLeg.x += Math.max(0, Math.sin(phase + Math.PI - 0.9)) * 0.85 * amp;
      targets.leftFoot.x += -s * 0.18 * amp;
      targets.rightFoot.x += s * 0.18 * amp;
      const lSign = Math.sign(this.rest.leftUpperArm.z) || 1;
      const rSign = Math.sign(this.rest.rightUpperArm.z) || -1;
      targets.leftUpperArm.x += -s * 0.32 * amp;
      targets.rightUpperArm.x += s * 0.32 * amp;
      targets.hips.z += s * 0.045 * amp;
      targets.spine.y = (targets.spine.y || 0) + s * 0.05 * amp;
      if (p >= 1) {
        this.walk = null;
        this.state = 'idle';
        this.performAction('wave');
        this.opts.onArrive?.();
      }
    }

    // /anime action layer.
    if (this.state === 'action' && this.action) {
      const a = this.action;
      const sampled = sampleAction(a.name, 0);
      a.t += dt;
      const p = clamp(a.t / sampled.duration, 0, 1);
      const s = sampleAction(a.name, p);
      for (const [bone, off] of Object.entries(s.bones)) {
        if (!targets[bone] || !off) continue;
        targets[bone].x += off.x || 0;
        targets[bone].y += off.y || 0;
        targets[bone].z += off.z || 0;
      }
      rootY += s.root.y || 0;
      rootX += s.root.x || 0;
      rootRotY += s.root.rotY || 0;
      expr = s.expr || {};
      if (p >= 1) { this.action = null; this.state = 'idle'; }
    }

    // Damped apply.
    const k = 1 - Math.exp(-12 * dt);
    for (const name of POSE_BONES) {
      const bone = this.bones[name];
      if (!bone) continue;
      const cur = this.current[name], tgt = targets[name];
      cur.x += (tgt.x - cur.x) * k;
      cur.y += (tgt.y - cur.y) * k;
      cur.z += (tgt.z - cur.z) * k;
      bone.rotation.set(cur.x, cur.y, cur.z);
    }
    this.root.position.set(rootX, rootY, 0);
    this.root.rotation.y = rootRotY;

    // Expressions: blink + viseme lip-sync + action emotions.
    const em = this.vrm.expressionManager;
    if (em) {
      this.blinkT -= dt;
      if (this.blinkT <= 0) { this.blink = 1; this.blinkT = 2.2 + Math.random() * 3.5; }
      this.blink = Math.max(0, this.blink - dt * 7);
      em.setValue('blink', this.blink > 0.5 ? (1 - this.blink) * 2 : this.blink * 2);
      this.visemeT += dt;
      if (this.visemeT > 0.09) { this.visemeT = 0; this.visemeIdx = (this.visemeIdx + 1 + Math.floor(Math.random() * 2)) % VISEMES.length; }
      const mouth = clamp(this.speakLevel * 2.4, 0, 1);
      VISEMES.forEach((v, i) => {
        const base = expr[v] || 0;
        em.setValue(v, Math.max(base, i === this.visemeIdx ? mouth : mouth * 0.12));
      });
      for (const name of ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral', 'blush']) {
        if (!(name in expr)) em.setValue(name, 0);
      }
      for (const [name, v] of Object.entries(expr)) em.setValue(name, v);
    }

    this.vrm.update(dt);
  }

  dispose() {
    this.disposed = true;
    this.pause();
    try { this.ro?.disconnect(); } catch {}
    try { if (this.vrm) VRMUtils.deepDispose(this.vrm.scene); } catch {}
    try {
      this.scene?.traverse(o => {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        for (const m of mats) {
          for (const key of Object.keys(m)) { const v = m[key]; if (v && v.isTexture) v.dispose(); }
          m.dispose?.();
        }
      });
    } catch {}
    try { this.renderer?.dispose(); this.renderer?.forceContextLoss(); } catch {}
    try { this.container.innerHTML = ''; } catch {}
    this.vrm = null; this.scene = null; this.renderer = null;
  }
}
