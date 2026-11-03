// Vani AI — OC-Lily VRM stage (three.js + @pixiv/three-vrm).
// v1.3.0 ANTI-FREEZE + EMPIRICAL KINEMATICS:
//   * Safe VRAM budget: antialias:false, pixelRatio <= 1.35, powerPreference
//     "default", anisotropy capped at 4. OC-Lily remains the owner's original
//     VRM; scripts/prepare-vrm-safe.mjs only audits it, never downscales it.
//   * Chunked async load (fetch -> parse -> compileAsync) with a progress bar;
//     the staging ArrayBuffer is released the instant parsing finishes.
//   * calibrateHumanoidAxes() measures VRM 0.x/1.0 bone sign inversions in WORLD
//     space so bow bends forward, knees bend backward, and namaste/wave use an
//     iterative world-space IK solver (hands physically meet < 0.04 m).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { sampleAction, setAxes, AXES } from './anime.js';
import { clamp } from './util.js';

const POSE_BONES = ['hips', 'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export class AvatarStage {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;                 // { batterySaver, fpsTarget, onArrive, onReady, onError, onProgress }
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
    this.ikPoses = {};
    this.speakLevel = 0;
    this.visemeIdx = 0;
    this.visemeT = 0;
    this.blinkT = 2.5;
    this.blink = 0;
    this.disposed = false;
    this.paused = false;
    this.lastFrameWall = performance.now();
    this.maxTextureDim = 0;
  }

  async init() {
    const c = this.container;
    // SAFE VRAM BUDGET (Adreno 613): no MSAA backbuffer, DPR capped at 1.35,
    // "default" power preference. Edge smoothing comes from 1.35x supersampling.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'default' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    this.renderer.setSize(c.clientWidth || 360, c.clientHeight || 640);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    c.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, (c.clientWidth || 360) / (c.clientHeight || 640), 0.1, 30);
    this.camera.position.set(0, 1.05, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.05, 0);
    this.controls.enableRotate = true;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enableZoom = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 3.8;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.25;
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(0.8, 2.2, 1.6);
    this.scene.add(key);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this._observeResize();

    // ---- Chunked, non-blocking load with progress + staging-buffer release ----
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    let gltf;
    try {
      this.opts.onProgress?.('mesh', 0);
      let arrayBuffer = await this._fetchVRM('assets/vrm/OC-Lily.vrm',
        p => this.opts.onProgress?.('mesh', p));
      this.opts.onProgress?.('mesh', 1);
      await new Promise(r => setTimeout(r, 0)); // yield a frame so the bar paints
      gltf = await new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
      arrayBuffer = null; // FREE the ~44 MB staging buffer immediately after parse
      this.opts.onProgress?.('shaders', 0);
      await new Promise(r => setTimeout(r, 0));
    } catch (e) {
      this.opts.onError?.(e);
      throw e;
    }
    if (this.disposed) return;
    const vrm = gltf.userData.vrm;
    if (!vrm) { const e = new Error('VRM extension missing'); this.opts.onError?.(e); throw e; }
    if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);

    // Cap anisotropy (VRAM/bandwidth) and audit texture dimensions.
    const aniso = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.maxTextureDim = 0;
    vrm.scene.traverse(o => {
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        for (const key of Object.keys(m)) {
          const v = m[key];
          if (v && v.isTexture) {
            v.anisotropy = aniso; v.needsUpdate = true;
            const img = v.image;
            if (img && (img.width || img.height)) this.maxTextureDim = Math.max(this.maxTextureDim, img.width || 0, img.height || 0);
          }
        }
      }
    });
    if (this.maxTextureDim > 0) console.debug(`[avatar] original texture audit: max ${this.maxTextureDim}px (preserved, not resampled)`);

    this.vrm = vrm;
    this.root.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.camera;

    for (const name of POSE_BONES) {
      const n = vrm.humanoid?.getNormalizedBoneNode(name);
      if (n) this.bones[name] = n;
    }
    this.calibrateRestPose();
    this.calibrateHumanoidAxes();

    // Async shader compile (KHR_parallel_shader_compile) — never blocks the UI.
    this.opts.onProgress?.('shaders', 0.5);
    try {
      if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera);
      else this.renderer.compile(this.scene, this.camera);
    } catch { /* first render will compile lazily */ }
    if (this.disposed) return;
    this.opts.onProgress?.('ready', 1);

    this.state = 'idle';
    this.opts.onReady?.();
    this.startLoop();
  }

  /** Stream the VRM with progress; runs off the critical UI frame. */
  async _fetchVRM(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('VRM fetch failed: HTTP ' + res.status);
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !res.body.getReader) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0, lastYield = performance.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) onProgress?.(Math.min(1, received / total));
      const now = performance.now();
      if (now - lastYield > 12) { lastYield = now; await new Promise(r => setTimeout(r, 0)); }
    }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const ch of chunks) { buf.set(ch, off); off += ch.length; }
    return buf.buffer;
  }

  /** Arms rest ~14° outside the torso; sign auto-detected by measuring the hand. */
  calibrateRestPose() {
    const vrm = this.vrm;
    const DOWN = (90 - 14) * Math.PI / 180;
    for (const side of ['left', 'right']) {
      const upper = this.bones[`${side}UpperArm`];
      const hand = this.bones[`${side}Hand`] || this.bones[`${side}LowerArm`];
      if (!upper || !hand) continue;
      let sign = side === 'left' ? 1 : -1;
      const test = s => {
        upper.rotation.set(0, 0, s * DOWN);
        vrm.scene.updateMatrixWorld(true);
        const shoulderY = upper.getWorldPosition(_v1).y;
        const handY = hand.getWorldPosition(_v2).y;
        return handY < shoulderY - 0.1;
      };
      if (!test(sign)) { sign = -sign; test(sign); }
      this.rest[`${side}UpperArm`] = { x: 0.05, y: 0, z: sign * DOWN };
      this.rest[`${side}LowerArm`] = { x: -0.14, y: 0, z: sign * 0.05 };
      upper.rotation.set(0, 0, 0);
    }
    for (const name of POSE_BONES) {
      if (!this.rest[name]) this.rest[name] = { x: 0, y: 0, z: 0 };
      this.current[name] = { ...this.rest[name] };
    }
    this.vrm.scene.updateMatrixWorld(true);
  }

  _applyRest() {
    for (const name of POSE_BONES) {
      const b = this.bones[name];
      if (b) b.rotation.set(this.rest[name].x, this.rest[name].y, this.rest[name].z);
    }
    this.vrm.scene.updateMatrixWorld(true);
  }

  /**
   * EMPIRICAL world-space axis calibration (immune to VRM 0.x/1.0 inversions).
   * Measures which local rotation direction moves a bone the anatomically
   * correct way, then stores the signs for the action library.
   */
  calibrateHumanoidAxes() {
    const vrm = this.vrm;
    const head = this.bones.head, spine = this.bones.spine || this.bones.chest;
    this._applyRest();
    // Forward pitch: +X on spine should move the head toward the camera (+Z).
    let pitch = 1;
    if (head && spine) {
      const z0 = head.getWorldPosition(_v1).z;
      spine.rotation.x = this.rest.spine.x + 0.25;
      vrm.scene.updateMatrixWorld(true);
      const z1 = head.getWorldPosition(_v1).z;
      pitch = z1 >= z0 ? 1 : -1;
      spine.rotation.x = this.rest.spine.x;
    }
    // Knee flexion: +X on lowerLeg should move the foot BACKWARD (-Z).
    let knee = 1;
    const ll = this.bones.leftLowerLeg, lf = this.bones.leftFoot;
    if (ll && lf) {
      vrm.scene.updateMatrixWorld(true);
      const f0 = lf.getWorldPosition(_v1).z;
      ll.rotation.x = this.rest.leftLowerLeg.x + 0.4;
      vrm.scene.updateMatrixWorld(true);
      const f1 = lf.getWorldPosition(_v1).z;
      knee = f1 <= f0 ? 1 : -1; // positive offset must move foot backward
      ll.rotation.x = this.rest.leftLowerLeg.x;
    }
    // Thigh swing: +X on upperLeg should swing the foot FORWARD (+Z).
    let leg = 1;
    const lu = this.bones.leftUpperLeg;
    if (lu && lf) {
      vrm.scene.updateMatrixWorld(true);
      const f0 = lf.getWorldPosition(_v1).z;
      lu.rotation.x = this.rest.leftUpperLeg.x + 0.4;
      vrm.scene.updateMatrixWorld(true);
      const f1 = lf.getWorldPosition(_v1).z;
      leg = f1 >= f0 ? 1 : -1;
      lu.rotation.x = this.rest.leftUpperLeg.x;
    }
    // Arm forward flexion: +X on upperArm should bring the hand forward (+Z).
    let armFwd = 1;
    const la = this.bones.leftUpperArm, lh = this.bones.leftHand;
    if (la && lh) {
      this._applyRest();
      const h0 = lh.getWorldPosition(_v1).z;
      la.rotation.x = this.rest.leftUpperArm.x + 0.5;
      vrm.scene.updateMatrixWorld(true);
      const h1 = lh.getWorldPosition(_v1).z;
      armFwd = h1 >= h0 ? 1 : -1;
    }
    this._applyRest();
    setAxes({ pitch, knee, leg, armFwd });

    // Precompute world-space IK poses for namaste (palms meet) and wave (hand up).
    try { this.ikPoses.namaste = this._computeNamastePose(); } catch (e) { console.warn('namaste IK', e); }
    this._applyRest();
    try { this.ikPoses.wave = this._computeWavePose(); } catch (e) { console.warn('wave IK', e); }
    this._applyRest();
  }

  /** Iterative CCD IK: drive a hand to a world-space target via shoulder+elbow. */
  _solveArmIK(side, target, iterations = 28) {
    const upper = this.bones[`${side}UpperArm`], lower = this.bones[`${side}LowerArm`], hand = this.bones[`${side}Hand`];
    if (!upper || !lower || !hand) return null;
    const vrm = this.vrm;
    for (let it = 0; it < iterations; it++) {
      vrm.scene.updateMatrixWorld(true);
      if (hand.getWorldPosition(_v1).distanceTo(target) < 0.012) break;
      for (const joint of [lower, upper]) {
        vrm.scene.updateMatrixWorld(true);
        const jPos = joint.getWorldPosition(_v1.clone());
        const hPos = hand.getWorldPosition(_v2.clone());
        const toHand = hPos.sub(jPos).normalize();
        const toTarget = _v3.copy(target).sub(jPos).normalize();
        const axis = new THREE.Vector3().crossVectors(toHand, toTarget);
        const len = axis.length();
        if (len < 1e-6) continue;
        axis.normalize();
        let angle = Math.atan2(len, toHand.dot(toTarget));
        angle = clamp(angle, -0.35, 0.35);
        const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
        const worldQ = joint.getWorldQuaternion(_q1.clone());
        const newWorldQ = q.multiply(worldQ);
        const parentQ = joint.parent.getWorldQuaternion(_q2.clone()).invert();
        joint.quaternion.copy(parentQ.multiply(newWorldQ));
      }
    }
    vrm.scene.updateMatrixWorld(true);
    const grab = b => ({ x: b.rotation.x, y: b.rotation.y, z: b.rotation.z });
    return { [`${side}UpperArm`]: grab(upper), [`${side}LowerArm`]: grab(lower), [`${side}Hand`]: grab(hand) };
  }

  _computeNamastePose() {
    this._applyRest();
    const vrm = this.vrm;
    const chest = this.bones.chest || this.bones.spine;
    if (!chest || !this.bones.leftHand || !this.bones.rightHand) return null;
    vrm.scene.updateMatrixWorld(true);
    const cPos = chest.getWorldPosition(_v1.clone());
    const center = cPos.clone(); center.z += 0.16; center.y -= 0.02; // in front of sternum
    const lx = this.bones.leftHand.getWorldPosition(_v2).x;
    const signL = Math.sign(lx - cPos.x) || 1;
    const lt = center.clone(); lt.x += signL * 0.018;
    const rt = center.clone(); rt.x -= signL * 0.018;
    const L = this._solveArmIK('left', lt);
    const R = this._solveArmIK('right', rt);
    if (!L || !R) return null;
    // Verify the palms actually meet (< 0.04 m); refine once if not.
    vrm.scene.updateMatrixWorld(true);
    const dist = this.bones.leftHand.getWorldPosition(_v1).distanceTo(this.bones.rightHand.getWorldPosition(_v2));
    if (dist > 0.04) { this._solveArmIK('left', lt, 20); this._solveArmIK('right', rt, 20); }
    return { ...L, ...R, _handDist: dist };
  }

  _computeWavePose() {
    this._applyRest();
    const vrm = this.vrm;
    const head = this.bones.head, rh = this.bones.rightHand;
    if (!head || !rh) return null;
    vrm.scene.updateMatrixWorld(true);
    const hPos = head.getWorldPosition(_v1.clone());
    const rx = rh.getWorldPosition(_v2).x;
    const signR = Math.sign(rx - hPos.x) || -1;
    const target = hPos.clone();
    target.z += 0.14; target.y += 0.02; target.x += signR * 0.20; // front-right, head height
    const R = this._solveArmIK('right', target);
    return R;
  }

  walkIn() {
    if (this.disposed || !this.root) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    this.walk = { t: 0, dur: 2.6, side };
    this.state = 'walkin';
    this.root.position.x = side * 1.5;
  }

  performAction(name) {
    if (this.disposed || !this.vrm || !sampleAction(name, 0)) return false;
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
    if (this.disposed || !this.renderer) return;
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const loop = () => {
      if (this.disposed || this.paused || !this.vrm) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const interval = 1000 / this.targetFps();
      if (now - this.last < interval - 1) return;
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      this.lastFrameWall = now;
      this.update(dt);
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() { this.paused = true; cancelAnimationFrame(this.raf); this.raf = null; }
  resume() { if (this.disposed || !this.paused) return; this.paused = false; this.startLoop(); }

  _resize() {
    if (this.disposed || !this.renderer || !this.container) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  _observeResize() {
    try { this.ro?.disconnect(); } catch {}
    this.ro = new ResizeObserver(() => this._resize());
    if (this.container) this.ro.observe(this.container);
  }

  remount(container) {
    if (this.disposed || !this.renderer) return false;
    this.container = container;
    try { container.appendChild(this.renderer.domElement); } catch {}
    this._observeResize();
    this._resize();
    this.paused = false;
    this.startLoop();
    return true;
  }

  update(dt) {
    this.time += dt;
    const targets = {};
    for (const name of POSE_BONES) targets[name] = { ...this.rest[name] };
    let rootX = 0, rootY = 0, rootRotY = 0;
    let expr = {};

    if (this.state === 'idle' || this.state === 'action') {
      targets.spine.x += 0.016 * Math.sin(this.time * 1.35) * AXES.pitch;
      targets.head.y += 0.045 * Math.sin(this.time * 0.55);
      targets.head.x += 0.02 * Math.sin(this.time * 0.9 + 1) * AXES.pitch;
      targets.hips.z = (targets.hips.z || 0) + 0.012 * Math.sin(this.time * 0.4);
    }

    // Walk-in: anatomical gait (thigh swing, backward knee bend only on lift).
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
      targets.leftUpperLeg.x += s * 0.5 * amp * AXES.leg;
      targets.rightUpperLeg.x += -s * 0.5 * amp * AXES.leg;
      targets.leftLowerLeg.x += Math.max(0, Math.sin(phase - 0.9)) * 0.8 * amp * AXES.knee;
      targets.rightLowerLeg.x += Math.max(0, Math.sin(phase + Math.PI - 0.9)) * 0.8 * amp * AXES.knee;
      targets.leftFoot.x += -s * 0.16 * amp * AXES.leg;
      targets.rightFoot.x += s * 0.16 * amp * AXES.leg;
      targets.leftUpperArm.x += -s * 0.24 * amp * AXES.armFwd;
      targets.rightUpperArm.x += s * 0.24 * amp * AXES.armFwd;
      targets.hips.z += s * 0.045 * amp;
      targets.spine.y = (targets.spine.y || 0) + s * 0.05 * amp;
      targets.head.x += 0.02 * amp * AXES.pitch;
      if (p >= 1) {
        this.walk = null;
        this.state = 'idle';
        this.performAction('wave');
        this.opts.onArrive?.();
      }
    }

    // /anime action layer.
    let ikOverride = null, ikWeight = 0, waveOsc = 0;
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
      // World-space IK poses for namaste / wave (rise-hold-fall envelope).
      if (a.name === 'namaste' && this.ikPoses.namaste) {
        ikOverride = this.ikPoses.namaste;
        ikWeight = p < 0.28 ? smooth(p / 0.28) : p < 0.72 ? 1 : smooth((1 - p) / 0.28);
      } else if (a.name === 'wave' && this.ikPoses.wave) {
        ikOverride = this.ikPoses.wave;
        ikWeight = p < 0.2 ? smooth(p / 0.2) : p < 0.82 ? 1 : smooth((1 - p) / 0.18);
        waveOsc = Math.sin(a.t * Math.PI * 2 * 3.5) * 0.38 * ikWeight; // ±22° @ 3.5 Hz
      }
      if (p >= 1) { this.action = null; this.state = 'idle'; }
    }

    // Damped apply.
    const k = 1 - Math.exp(-12 * dt);
    for (const name of POSE_BONES) {
      const bone = this.bones[name];
      if (!bone) continue;
      const cur = this.current[name];
      let tgt = targets[name];
      if (ikOverride && ikOverride[name]) {
        const ik = ikOverride[name], r = this.rest[name];
        tgt = { x: r.x + (ik.x - r.x) * ikWeight, y: r.y + (ik.y - r.y) * ikWeight, z: r.z + (ik.z - r.z) * ikWeight };
        if (name === 'rightLowerArm') tgt.z += waveOsc;
        if (name === 'rightHand') tgt.z += waveOsc * 0.6;
      }
      cur.x += (tgt.x - cur.x) * k;
      cur.y += (tgt.y - cur.y) * k;
      cur.z += (tgt.z - cur.z) * k;
      bone.rotation.set(cur.x, cur.y, cur.z);
    }
    this.root.position.set(rootX, rootY, 0);
    this.root.rotation.y = rootRotY;

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
    try { this.controls?.dispose(); } catch {}
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
    try { this.renderer?.dispose(); } catch {}
    try { this.container.innerHTML = ''; } catch {}
    this.vrm = null; this.scene = null; this.renderer = null; this.controls = null;
  }
}

const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
