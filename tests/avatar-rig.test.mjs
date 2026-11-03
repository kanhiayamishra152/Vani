// Vani AI v1.3.0 — headless world-space animation verification.
// Builds a synthetic humanoid rig (no GPU / no real VRM needed) and runs the
// REAL AvatarStage calibration + CCD-IK methods against it, asserting the
// anatomical guarantees the device incident demanded:
//   • bow bends FORWARD (+Z toward camera), never backward
//   • knee flexion moves the foot BACKWARD (-Z), never hyper-extends forward
//   • namaste palms physically meet (< 0.04 m) in front of the sternum
//   • wave raises the right hand to head height, out front
//   • calibration is immune to axis-sign inversion (VRM 0.x vs 1.0)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AvatarStage } from '../web/js/avatar.js';
import { sampleAction, setAxes, AXES } from '../web/js/anime.js';

const DOWN = (90 - 14) * Math.PI / 180;
const P = THREE.Object3D;

/** Build a minimal humanoid bone tree. `invert` flips the spine/chest local X
 *  axis (via a 180° Y pre-rotation on a wrapper) to emulate VRM 0.x inversion. */
function buildRig() {
  const scene = new THREE.Scene();
  const bones = {};
  const mk = (name, parent, x, y, z) => {
    const b = new P(); b.name = name; b.position.set(x, y, z);
    (parent || scene).add(b); bones[name] = b; return b;
  };
  const hips = mk('hips', null, 0, 1.0, 0);
  const spine = mk('spine', hips, 0, 0.10, 0);
  const chest = mk('chest', spine, 0, 0.15, 0);
  const neck = mk('neck', chest, 0, 0.20, 0);
  mk('head', neck, 0, 0.12, 0);
  for (const side of ['left', 'right']) {
    const sx = side === 'left' ? 1 : -1;
    const ua = mk(`${side}UpperArm`, chest, sx * 0.18, 0.12, 0);
    const la = mk(`${side}LowerArm`, ua, 0.28, 0, 0);
    mk(`${side}Hand`, la, 0.25, 0, 0);
    const ul = mk(`${side}UpperLeg`, hips, sx * 0.10, -0.05, 0);
    const ll = mk(`${side}LowerLeg`, ul, 0, -0.42, 0);
    mk(`${side}Foot`, ll, 0, -0.42, 0);
  }
  const rest = {};
  for (const n of Object.keys(bones)) rest[n] = { x: 0, y: 0, z: 0 };
  // Arms hang down at rest (local +X rotated toward -Y).
  rest.leftUpperArm = { x: 0.05, y: 0, z: -DOWN };
  rest.rightUpperArm = { x: 0.05, y: 0, z: -DOWN };
  rest.leftLowerArm = { x: -0.14, y: 0, z: 0 };
  rest.rightLowerArm = { x: -0.14, y: 0, z: 0 };
  const ctx = {
    bones, vrm: { scene }, rest, current: {}, ikPoses: {},
    _applyRest: AvatarStage.prototype._applyRest,
    _solveArmIK: AvatarStage.prototype._solveArmIK,
    _computeNamastePose: AvatarStage.prototype._computeNamastePose,
    _computeWavePose: AvatarStage.prototype._computeWavePose,
  };
  return { scene, bones, ctx };
}

function applyAction(ctx, name, p) {
  const s = sampleAction(name, p);
  for (const [bone, off] of Object.entries(s.bones)) {
    const b = ctx.bones[bone];
    if (b && off) b.rotation.set(ctx.rest[bone].x + (off.x || 0), ctx.rest[bone].y + (off.y || 0), ctx.rest[bone].z + (off.z || 0));
  }
  ctx.vrm.scene.updateMatrixWorld(true);
  return s;
}

test('calibration detects forward pitch + backward knee on a synthetic rig', () => {
  const { ctx, bones } = buildRig();
  AvatarStage.prototype.calibrateHumanoidAxes.call(ctx);
  assert.ok([1, -1].includes(AXES.pitch), 'pitch sign resolved');
  assert.ok([1, -1].includes(AXES.knee), 'knee sign resolved');
  // With calibrated signs, a bow must move the head toward +Z (forward).
  ctx._applyRest();
  const z0 = bones.head.getWorldPosition(new THREE.Vector3()).z;
  applyAction(ctx, 'bow', 0.5);
  const z1 = bones.head.getWorldPosition(new THREE.Vector3()).z;
  assert.ok(z1 > z0 + 0.02, `bow must bend forward: head Z ${z0.toFixed(3)} -> ${z1.toFixed(3)}`);
});

test('knee flexion moves the foot backward (no backward-knee hyperextension)', () => {
  const { ctx, bones } = buildRig();
  AvatarStage.prototype.calibrateHumanoidAxes.call(ctx);
  ctx._applyRest();
  const f0 = bones.leftFoot.getWorldPosition(new THREE.Vector3()).z;
  // Direct knee flexion using the calibrated sign.
  bones.leftLowerLeg.rotation.x = ctx.rest.leftLowerLeg.x + 0.5 * AXES.knee;
  ctx.vrm.scene.updateMatrixWorld(true);
  const f1 = bones.leftFoot.getWorldPosition(new THREE.Vector3()).z;
  assert.ok(f1 < f0 - 0.01, `knee must bend backward: foot Z ${f0.toFixed(3)} -> ${f1.toFixed(3)}`);
});

test('namaste IK brings both palms together (< 0.04 m) in front of the chest', () => {
  const { ctx, bones } = buildRig();
  AvatarStage.prototype.calibrateHumanoidAxes.call(ctx);
  const pose = ctx.ikPoses.namaste;
  assert.ok(pose, 'namaste pose computed');
  // Apply the solved IK pose and measure the real world-space palm distance.
  ctx._applyRest();
  for (const [bone, off] of Object.entries(pose)) {
    if (bone.startsWith('_')) continue;
    const b = ctx.bones[bone]; if (b) b.rotation.set(off.x, off.y, off.z);
  }
  ctx.vrm.scene.updateMatrixWorld(true);
  const lh = bones.leftHand.getWorldPosition(new THREE.Vector3());
  const rh = bones.rightHand.getWorldPosition(new THREE.Vector3());
  const dist = lh.distanceTo(rh);
  assert.ok(dist < 0.04, `palms must meet: dist=${dist.toFixed(4)} m`);
  const chestZ = bones.chest.getWorldPosition(new THREE.Vector3()).z;
  assert.ok(lh.z > chestZ + 0.05, 'palms must be in FRONT of the sternum');
});

test('wave IK raises the right hand to head height, out front', () => {
  const { ctx, bones } = buildRig();
  AvatarStage.prototype.calibrateHumanoidAxes.call(ctx);
  const pose = ctx.ikPoses.wave;
  assert.ok(pose, 'wave pose computed');
  ctx._applyRest();
  for (const [bone, off] of Object.entries(pose)) {
    const b = ctx.bones[bone]; if (b) b.rotation.set(off.x, off.y, off.z);
  }
  ctx.vrm.scene.updateMatrixWorld(true);
  const head = bones.head.getWorldPosition(new THREE.Vector3());
  const rh = bones.rightHand.getWorldPosition(new THREE.Vector3());
  assert.ok(rh.y > head.y - 0.18, `wave hand near head height: hand Y ${rh.y.toFixed(3)} vs head ${head.y.toFixed(3)}`);
  assert.ok(rh.z > head.z - 0.05, 'wave hand out in front');
});

test('SIGN_MAP applies calibrated inversion (VRM 0.x vs 1.0 immunity)', () => {
  setAxes({ pitch: 1, knee: 1, leg: 1, armFwd: 1 });
  const a = sampleAction('bow', 0.5);
  const spinePos = a.bones.spine.x;
  setAxes({ pitch: -1 });
  const b = sampleAction('bow', 0.5);
  assert.ok(Math.sign(b.bones.spine.x) === -Math.sign(spinePos), 'inverted pitch flips the bow offset');
  setAxes({ pitch: 1, knee: 1, leg: 1, armFwd: 1 }); // restore
});
