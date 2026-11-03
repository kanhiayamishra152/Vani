// Vani AI — multi-joint /anime action library for the VRM humanoid rig.
// Tracks are OFFSETS from the calibrated rest pose, in radians, normalized
// humanoid bone space (VRM 0.x and 1.0 both map through three-vrm).
// Left-side arm Z offsets are positive-down; right-side mirrored.
// Triggered ONLY by /anime commands — never randomly.

const Z = { t: 0 };
export const ANIME_DEFS = {
  namaste: {
    duration: 3.0,
    bones: {
      leftUpperArm:  [{ t: 0 }, { t: 0.28, z: -0.72, y: -0.55 }, { t: 0.72, z: -0.72, y: -0.55 }, { t: 1 }],
      rightUpperArm: [{ t: 0 }, { t: 0.28, z: 0.72, y: 0.55 }, { t: 0.72, z: 0.72, y: 0.55 }, { t: 1 }],
      leftLowerArm:  [{ t: 0 }, { t: 0.28, z: 1.45 }, { t: 0.72, z: 1.45 }, { t: 1 }],
      rightLowerArm: [{ t: 0 }, { t: 0.28, z: -1.45 }, { t: 0.72, z: -1.45 }, { t: 1 }],
      leftHand:      [{ t: 0 }, { t: 0.3, z: 0.25 }, { t: 0.7, z: 0.25 }, { t: 1 }],
      rightHand:     [{ t: 0 }, { t: 0.3, z: -0.25 }, { t: 0.7, z: -0.25 }, { t: 1 }],
      spine:         [{ t: 0 }, { t: 0.32, x: 0.1 }, { t: 0.5, x: 0.24 }, { t: 0.68, x: 0.1 }, { t: 1 }],
      head:          [{ t: 0 }, { t: 0.32, x: 0.08 }, { t: 0.5, x: 0.18 }, { t: 0.68, x: 0.08 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.3, values: { happy: 0.65 } }, { t: 0.75, values: { happy: 0.65 } }, { t: 1 }],
  },
  wave: {
    duration: 2.3,
    bones: {
      rightUpperArm: [{ t: 0 }, { t: 0.22, z: 1.12, y: 0.18 }, { t: 0.8, z: 1.12, y: 0.18 }, { t: 1 }],
      rightLowerArm: [{ t: 0 }, { t: 0.22, z: 0.45 }, { t: 0.36, z: 0.95 }, { t: 0.5, z: 0.35 }, { t: 0.64, z: 0.95 }, { t: 0.8, z: 0.45 }, { t: 1 }],
      rightHand:     [{ t: 0 }, { t: 0.3, z: 0.25 }, { t: 0.44, z: -0.2 }, { t: 0.58, z: 0.25 }, { t: 0.72, z: -0.2 }, { t: 1 }],
      head:          [{ t: 0 }, { t: 0.25, z: 0.07 }, { t: 0.8, z: 0.07 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.2, values: { happy: 0.75 } }, { t: 0.85, values: { happy: 0.75 } }, { t: 1 }],
  },
  bow: {
    duration: 2.5,
    bones: {
      spine: [{ t: 0 }, { t: 0.3, x: 0.34 }, { t: 0.62, x: 0.34 }, { t: 1 }],
      chest: [{ t: 0 }, { t: 0.3, x: 0.14 }, { t: 0.62, x: 0.14 }, { t: 1 }],
      head:  [{ t: 0 }, { t: 0.3, x: 0.2 }, { t: 0.62, x: 0.2 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.3, values: { relaxed: 0.4 } }, { t: 0.7, values: { relaxed: 0.4 } }, { t: 1 }],
  },
  jump: {
    duration: 1.5,
    root: [{ t: 0, y: 0 }, { t: 0.16, y: -0.09 }, { t: 0.42, y: 0.34 }, { t: 0.62, y: 0 }, { t: 0.74, y: -0.06 }, { t: 1, y: 0 }],
    bones: {
      leftUpperLeg:  [{ t: 0 }, { t: 0.16, x: -0.4 }, { t: 0.42, x: 0.25 }, { t: 0.74, x: -0.3 }, { t: 1 }],
      rightUpperLeg: [{ t: 0 }, { t: 0.16, x: -0.4 }, { t: 0.42, x: 0.25 }, { t: 0.74, x: -0.3 }, { t: 1 }],
      leftLowerLeg:  [{ t: 0 }, { t: 0.16, x: 0.7 }, { t: 0.42, x: 0.35 }, { t: 0.74, x: 0.55 }, { t: 1 }],
      rightLowerLeg: [{ t: 0 }, { t: 0.16, x: 0.7 }, { t: 0.42, x: 0.35 }, { t: 0.74, x: 0.55 }, { t: 1 }],
      leftUpperArm:  [{ t: 0 }, { t: 0.16, z: 0.2 }, { t: 0.42, z: -0.85 }, { t: 0.7, z: 0.1 }, { t: 1 }],
      rightUpperArm: [{ t: 0 }, { t: 0.16, z: -0.2 }, { t: 0.42, z: 0.85 }, { t: 0.7, z: -0.1 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.3, values: { happy: 0.9 } }, { t: 0.8, values: { happy: 0.9 } }, { t: 1 }],
  },
  spin: {
    duration: 1.9,
    root: [{ t: 0, rotY: 0 }, { t: 0.85, rotY: Math.PI * 2 }, { t: 1, rotY: Math.PI * 2 }],
    bones: {
      leftUpperArm:  [{ t: 0 }, { t: 0.2, z: -0.35 }, { t: 0.8, z: -0.35 }, { t: 1 }],
      rightUpperArm: [{ t: 0 }, { t: 0.2, z: 0.35 }, { t: 0.8, z: 0.35 }, { t: 1 }],
      head: [{ t: 0 }, { t: 0.2, z: 0.05 }, { t: 0.85, z: 0 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.2, values: { happy: 0.6 } }, { t: 0.85, values: { happy: 0.6 } }, { t: 1 }],
  },
  dance: {
    duration: 4.2,
    root: [{ t: 0, y: 0 }, { t: 0.125, y: 0.04 }, { t: 0.25, y: 0 }, { t: 0.375, y: 0.04 }, { t: 0.5, y: 0 }, { t: 0.625, y: 0.04 }, { t: 0.75, y: 0 }, { t: 0.875, y: 0.04 }, { t: 1, y: 0 }],
    bones: {
      hips:  [{ t: 0 }, { t: 0.125, z: 0.1 }, { t: 0.375, z: -0.1 }, { t: 0.625, z: 0.1 }, { t: 0.875, z: -0.1 }, { t: 1 }],
      spine: [{ t: 0 }, { t: 0.125, y: 0.14 }, { t: 0.375, y: -0.14 }, { t: 0.625, y: 0.14 }, { t: 0.875, y: -0.14 }, { t: 1 }],
      leftUpperArm:  [{ t: 0 }, { t: 0.25, z: -1.0, y: -0.2 }, { t: 0.5, z: -0.2 }, { t: 0.75, z: -1.0, y: -0.2 }, { t: 1 }],
      rightUpperArm: [{ t: 0 }, { t: 0.25, z: 0.2 }, { t: 0.5, z: 1.0, y: 0.2 }, { t: 0.75, z: 0.2 }, { t: 1 }],
      leftLowerArm:  [{ t: 0 }, { t: 0.25, z: 0.6 }, { t: 0.5, z: 0.15 }, { t: 0.75, z: 0.6 }, { t: 1 }],
      rightLowerArm: [{ t: 0 }, { t: 0.25, z: -0.15 }, { t: 0.5, z: -0.6 }, { t: 0.75, z: -0.15 }, { t: 1 }],
      head: [{ t: 0 }, { t: 0.25, z: 0.1 }, { t: 0.5, z: -0.1 }, { t: 0.75, z: 0.1 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.1, values: { happy: 0.8 } }, { t: 0.9, values: { happy: 0.8 } }, { t: 1 }],
  },
  think: {
    duration: 3.2,
    bones: {
      rightUpperArm: [{ t: 0 }, { t: 0.3, z: 0.55, y: 0.55 }, { t: 0.78, z: 0.55, y: 0.55 }, { t: 1 }],
      rightLowerArm: [{ t: 0 }, { t: 0.3, z: -1.5 }, { t: 0.78, z: -1.5 }, { t: 1 }],
      rightHand: [{ t: 0 }, { t: 0.3, x: -0.2 }, { t: 0.78, x: -0.2 }, { t: 1 }],
      head: [{ t: 0 }, { t: 0.35, x: 0.1, z: 0.09, y: 0.08 }, { t: 0.78, x: 0.1, z: 0.09, y: 0.08 }, { t: 1 }],
      leftUpperArm: [{ t: 0 }, { t: 0.3, z: -0.15, y: -0.15 }, { t: 0.78, z: -0.15, y: -0.15 }, { t: 1 }],
      leftLowerArm: [{ t: 0 }, { t: 0.3, z: 0.5 }, { t: 0.78, z: 0.5 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.35, values: { neutral: 0.4 } }, { t: 0.8, values: { neutral: 0.4 } }, { t: 1 }],
  },
  nod: {
    duration: 1.7,
    bones: {
      head: [{ t: 0 }, { t: 0.18, x: 0.24 }, { t: 0.36, x: -0.04 }, { t: 0.55, x: 0.2 }, { t: 0.75, x: 0 }, { t: 1 }],
      neck: [{ t: 0 }, { t: 0.18, x: 0.08 }, { t: 0.55, x: 0.08 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.2, values: { happy: 0.35 } }, { t: 0.8, values: { happy: 0.35 } }, { t: 1 }],
  },
  headshake: {
    duration: 1.9,
    bones: {
      head: [{ t: 0 }, { t: 0.16, y: 0.34 }, { t: 0.36, y: -0.34 }, { t: 0.56, y: 0.28 }, { t: 0.76, y: -0.2 }, { t: 1 }],
      neck: [{ t: 0 }, { t: 0.16, y: 0.1 }, { t: 0.36, y: -0.1 }, { t: 1 }],
    },
  },
  happy: {
    duration: 2.1,
    root: [{ t: 0, y: 0 }, { t: 0.18, y: 0.07 }, { t: 0.36, y: 0 }, { t: 0.54, y: 0.07 }, { t: 0.72, y: 0 }, { t: 1, y: 0 }],
    bones: {
      leftUpperArm:  [{ t: 0 }, { t: 0.2, z: -0.5 }, { t: 0.5, z: -0.2 }, { t: 0.7, z: -0.5 }, { t: 1 }],
      rightUpperArm: [{ t: 0 }, { t: 0.2, z: 0.5 }, { t: 0.5, z: 0.2 }, { t: 0.7, z: 0.5 }, { t: 1 }],
      leftLowerArm:  [{ t: 0 }, { t: 0.2, z: 0.5 }, { t: 0.7, z: 0.5 }, { t: 1 }],
      rightLowerArm: [{ t: 0 }, { t: 0.2, z: -0.5 }, { t: 0.7, z: -0.5 }, { t: 1 }],
      spine: [{ t: 0 }, { t: 0.2, x: -0.05 }, { t: 0.7, x: -0.05 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.15, values: { happy: 1 } }, { t: 0.85, values: { happy: 1 } }, { t: 1 }],
  },
  shy: {
    duration: 2.8,
    bones: {
      head: [{ t: 0 }, { t: 0.3, x: 0.14, y: 0.28 }, { t: 0.75, x: 0.14, y: 0.28 }, { t: 1 }],
      spine: [{ t: 0 }, { t: 0.3, x: 0.08 }, { t: 0.75, x: 0.08 }, { t: 1 }],
      leftUpperArm:  [{ t: 0 }, { t: 0.3, z: -0.95, y: -0.42 }, { t: 0.75, z: -0.95, y: -0.42 }, { t: 1 }],
      rightUpperArm: [{ t: 0 }, { t: 0.3, z: 0.95, y: 0.42 }, { t: 0.75, z: 0.95, y: 0.42 }, { t: 1 }],
      leftLowerArm:  [{ t: 0 }, { t: 0.3, z: 1.5 }, { t: 0.75, z: 1.5 }, { t: 1 }],
      rightLowerArm: [{ t: 0 }, { t: 0.3, z: -1.5 }, { t: 0.75, z: -1.5 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.3, values: { happy: 0.3, blush: 0.8 } }, { t: 0.78, values: { happy: 0.3, blush: 0.8 } }, { t: 1 }],
  },
  surprised: {
    duration: 1.9,
    root: [{ t: 0, y: 0 }, { t: 0.15, y: 0.04 }, { t: 0.5, y: 0.02 }, { t: 1, y: 0 }],
    bones: {
      spine: [{ t: 0 }, { t: 0.15, x: -0.14 }, { t: 0.6, x: -0.1 }, { t: 1 }],
      head: [{ t: 0 }, { t: 0.15, x: -0.12 }, { t: 0.6, x: -0.08 }, { t: 1 }],
      leftUpperArm:  [{ t: 0 }, { t: 0.15, z: -0.45 }, { t: 0.6, z: -0.35 }, { t: 1 }],
      rightUpperArm: [{ t: 0 }, { t: 0.15, z: 0.45 }, { t: 0.6, z: 0.35 }, { t: 1 }],
      leftLowerArm:  [{ t: 0 }, { t: 0.15, z: 0.4 }, { t: 0.6, z: 0.3 }, { t: 1 }],
      rightLowerArm: [{ t: 0 }, { t: 0.15, z: -0.4 }, { t: 0.6, z: -0.3 }, { t: 1 }],
    },
    expr: [{ t: 0 }, { t: 0.12, values: { surprised: 1, oh: 0.7 } }, { t: 0.65, values: { surprised: 0.8, oh: 0.5 } }, { t: 1 }],
  },
};

const smooth = t => t * t * (3 - 2 * t);

function sampleTrack(track, p) {
  if (!track || !track.length) return null;
  if (p <= track[0].t) return track[0];
  if (p >= track[track.length - 1].t) return track[track.length - 1];
  for (let i = 1; i < track.length; i++) {
    if (p <= track[i].t) {
      const a = track[i - 1], b = track[i];
      const k = smooth((p - a.t) / Math.max(1e-5, b.t - a.t));
      const out = { t: p };
      for (const key of ['x', 'y', 'z', 'rotY']) {
        const av = a[key] ?? 0, bv = b[key] ?? 0;
        out[key] = av + (bv - av) * k;
      }
      if (a.values || b.values) {
        out.values = {};
        const keys = new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})]);
        for (const key of keys) out.values[key] = (a.values?.[key] ?? 0) + ((b.values?.[key] ?? 0) - (a.values?.[key] ?? 0)) * k;
      }
      return out;
    }
  }
  return track[track.length - 1];
}

/** Sample an action at normalized progress p∈[0,1]. */
export function sampleAction(name, p) {
  const def = ANIME_DEFS[name];
  if (!def) return null;
  const bones = {};
  for (const [bone, track] of Object.entries(def.bones || {})) bones[bone] = sampleTrack(track, p);
  return {
    duration: def.duration,
    bones,
    root: sampleTrack(def.root, p) || { x: 0, y: 0, rotY: 0 },
    expr: sampleTrack(def.expr, p)?.values || {},
  };
}
