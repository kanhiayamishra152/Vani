#!/usr/bin/env python3
"""
Generate the four Vani orb Lottie animations.

WHY A SCRIPT INSTEAD OF COMMITTED JSON
  Hand-writing four Lottie files means four large, error-prone JSON blobs that nobody can
  sanity-check by reading. Generating them here keeps the assets reproducible, makes the
  motion math explicit, and lets the loop points be asserted to be seamless.

MOTION DESIGN
  All four are built from the same primitives - a soft white core, a halo, and (for
  LISTENING) expanding rings - so the orb keeps one identity across states and only the
  *energy* changes. That is the ChatGPT-voice aesthetic: same object, different life.

  Every animation is loop-seamless by construction: the first and last keyframe values are
  identical. LISTENING's rings additionally fade to opacity 0 at both ends, which makes
  them invisible at the wrap point regardless of phase offset.

  Note on the "no GPU shaders" rule: Lottie renders through Skia on the CPU. It is listed
  in the spec as an acceptable pre-rendered option, and it avoids shipping four binary
  video assets in git. OrbView additionally supports a hardware-decoder path (see
  OrbView.kt) for when MP4/WebM assets are dropped into assets/animations/video/.
"""
import json
import os

W = H = 512
FPS = 30
CENTER = [W / 2, H / 2]


# --------------------------------------------------------------------------- #
# Lottie keyframe / property helpers
# --------------------------------------------------------------------------- #
def prop_static(value):
    """A non-animated property: {'a': 0, 'k': value}."""
    return {"a": 0, "k": value}


def prop_anim(keyframes):
    """
    An animated property.

    keyframes: list of dicts with 't' (frame) and 's' (value). Optional 'i'/'o' give
    easing. Hold keyframes (no easing) are supported by Lottie and are what we want for
    hard state changes.
    """
    return {"a": 1, "k": keyframes}


def kf(t, s, ease_in=None, ease_out=None):
    k = {"t": t, "s": s}
    if ease_in is not None and ease_out is not None:
        k["i"] = {"x": [ease_in], "y": [1.0]}
        k["o"] = {"x": [ease_out], "y": [0.0]}
    return k


def loop_eased(frames, start, end, mid_scale=1.0):
    """
    A seamless sine-ish ease: value goes start -> end -> start across `frames`.

    Uses only two keyframes plus easing, so the values at frame 0 and frame `frames`
    are identical and the loop wraps invisibly.
    """
    return [
        kf(0, start, ease_in=0.0, ease_out=0.45),
        kf(frames, start, ease_in=0.55, ease_out=1.0),
    ] if mid_scale is None else [
        kf(0, start, ease_in=0.0, ease_out=0.45),
        kf(frames // 2, end, ease_in=0.45, ease_out=0.55),
        kf(frames, start, ease_in=0.55, ease_out=1.0),
    ]


# --------------------------------------------------------------------------- #
# Shape construction
# --------------------------------------------------------------------------- #
def ellipse(w, h, x=0.0, y=0.0):
    return {
        "ty": "el",
        "s": prop_static([w, h]),
        "p": prop_static([x, y]),
    }


def fill(color, opacity=100):
    return {
        "ty": "fl",
        "c": prop_static(color),
        "o": prop_static(opacity),
    }


def stroke(color, width, opacity=100):
    return {
        "ty": "st",
        "c": prop_static(color),
        "o": prop_static(opacity),
        "w": prop_static(width),
        "lc": 2,   # round line cap
        "lj": 2,
    }


def group(items, name, opacity=100, scale=100, rotation=0, pos=(0.0, 0.0)):
    """Wraps shape items in a group with its own transform."""
    transformed = list(items)
    transformed.append({
        "ty": "tr",
        "p": prop_static(list(pos)),
        "a": prop_static([0.0, 0.0]),
        "s": prop_static([scale, scale]),
        "r": prop_static(rotation),
        "o": prop_static(opacity),
    })
    return {"ty": "gr", "it": transformed, "nm": name, "np": len(transformed)}


def shape_layer(name, shapes, opacity_prop=None, scale_prop=None, rotation_prop=None,
                frame_count=120, ind=1):
    """
    Builds a shape layer whose whole-layer transform can be animated.

    The layer transform is what we animate for breathing/pulsing, so the inner groups
    stay simple.
    """
    return {
        "ddd": 0,
        "ind": ind,
        "ty": 4,
        "nm": name,
        "sr": 1,
        "ks": {
            "o": opacity_prop if opacity_prop else prop_static(100),
            "r": rotation_prop if rotation_prop else prop_static(0),
            "p": prop_static(CENTER),
            "a": prop_static([0.0, 0.0]),
            "s": scale_prop if scale_prop else prop_static([100, 100]),
        },
        "ao": 0,
        "shapes": shapes,
        "ip": 0,
        "op": frame_count,
        "st": 0,
        "bm": 0,
    }


def composition(layers, name, frame_count):
    return {
        "v": "5.7.4",
        "fr": FPS,
        "ip": 0,
        "op": frame_count,
        "w": W,
        "h": H,
        "nm": name,
        "ddd": 0,
        "assets": [],
        "layers": layers,
        "markers": [],
    }


# --------------------------------------------------------------------------- #
# Colours (matching res/values/colors.xml)
# --------------------------------------------------------------------------- #
WHITE = [1.0, 1.0, 1.0, 1.0]
CORE = [0.98, 0.98, 0.99, 1.0]
HALO = [0.66, 0.76, 0.94, 1.0]          # #A8C4F0
ACCENT = [0.48, 0.64, 0.97, 1.0]        # #7AA2F7
LIGHT = [0.62, 0.72, 0.94, 1.0]
DIM = [0.42, 0.46, 0.52, 1.0]


def build_idle(frames=120):
    """IDLE - slow, calm breathing. 4s loop."""
    orb_scale = loop_eased(frames, 100.0, 105.0)
    halo_opacity = loop_eased(frames, 22.0, 42.0)
    halo_scale = loop_eased(frames, 100.0, 106.0)

    return composition([
        shape_layer(
            "halo",
            [group([ellipse(360, 360), fill(HALO)], "haloFill")],
            opacity_prop=prop_anim(halo_opacity),
            scale_prop=prop_anim(halo_scale),
            frame_count=frames,
            ind=1,
        ),
        shape_layer(
            "orb",
            [group([ellipse(150, 150), fill(CORE)], "orbFill")],
            scale_prop=prop_anim(orb_scale),
            frame_count=frames,
            ind=2,
        ),
    ], "idle", frames)


def build_listening(frames=120):
    """
    LISTENING - energetic rippling while the user speaks.

    Four rings expand outward and fade. Each ring fades to opacity 0 at both the start
    and the end of its window, so it is invisible at the loop wrap regardless of phase -
    that is what makes the staggered ripple loop seamless.
    """
    orb_scale = loop_eased(frames, 100.0, 108.0)
    halo_opacity = loop_eased(frames, 28.0, 52.0)

    rings = []
    for i in range(4):
        phase = i * (frames // 4)
        span = frames // 4
        keyframes = [
            kf(0, 0),                 # invisible before this ring starts
            kf(phase, 0),
            kf(phase + span * 0.15, 58),
            kf(phase + span * 0.85, 0),
            kf(frames, 0),            # invisible after; matches frame 0
        ]
        scale_kf = [
            kf(0, 40),
            kf(phase, 40),
            kf(phase + span, 175),
            kf(frames, 40),
        ]
        rings.append(shape_layer(
            f"ring{i}",
            [group([ellipse(200, 200), fill(ACCENT)], f"ring{i}Fill")],
            opacity_prop=prop_anim(keyframes),
            scale_prop=prop_anim(scale_kf),
            frame_count=frames,
            ind=10 + i,
        ))

    layers = rings + [
        shape_layer(
            "halo",
            [group([ellipse(330, 330), fill(HALO)], "haloFill")],
            opacity_prop=prop_anim(halo_opacity),
            frame_count=frames,
            ind=1,
        ),
        shape_layer(
            "orb",
            [group([ellipse(150, 150), fill(CORE)], "orbFill")],
            scale_prop=prop_anim(orb_scale),
            frame_count=frames,
            ind=2,
        ),
    ]
    return composition(layers, "listening", frames)


def build_thinking(frames=120):
    """THINKING - swirling, contained motion while the LLM generates."""
    # A full 360 rotation over the loop is seamless by definition.
    spin = prop_anim([
        kf(0, 0, ease_in=0.0, ease_out=0.0),
        kf(frames, 360.0),
    ])
    orb_scale = loop_eased(frames, 100.0, 103.0)
    halo_opacity = loop_eased(frames, 24.0, 46.0)

    # Orbiting accent dots: eight dots on a fixed-radius ring. Each dot's group carries a
    # static angular offset while the layer itself rotates a full turn, so together they
    # sweep the circle while preserving their relative spacing.
    dots = []
    for i in range(8):
        angle = float(i * 45)
        shapes = [group(
            [ellipse(26, 26), fill(ACCENT)], f"dot{i}Fill",
            rotation=angle, pos=(0.0, -130.0),
        )]
        dots.append(shape_layer(
            f"dot{i}", shapes,
            rotation_prop=spin,
            frame_count=frames,
            ind=20 + i,
        ))

    layers = [
        shape_layer(
            "orbit",
            [group([ellipse(300, 300), stroke(DIM, 1.0, 28)], "orbitStroke")],
            frame_count=frames,
            ind=3,
        ),
    ] + dots + [
        shape_layer(
            "halo",
            [group([ellipse(300, 300), fill(HALO)], "haloFill")],
            opacity_prop=prop_anim(halo_opacity),
            rotation_prop=spin,
            frame_count=frames,
            ind=1,
        ),
        shape_layer(
            "orb",
            [group([ellipse(150, 150), fill(CORE)], "orbFill")],
            scale_prop=prop_anim(orb_scale),
            frame_count=frames,
            ind=2,
        ),
    ]
    return composition(layers, "thinking", frames)


def build_speaking(frames=45):
    """
    SPEAKING - active pulsing.

    1.5s loop: a quick expand-contract with a halo that pulses in sync. The first and
    last keyframes match, so it loops cleanly.
    """
    pulse = [
        kf(0, 100.0, ease_in=0.0, ease_out=0.35),
        kf(frames * 0.45, 112.0, ease_in=0.45, ease_out=0.5),
        kf(frames, 100.0, ease_in=0.5, ease_out=1.0),
    ]
    halo_opacity = [
        kf(0, 30.0, ease_in=0.0, ease_out=0.35),
        kf(frames * 0.45, 62.0, ease_in=0.45, ease_out=0.5),
        kf(frames, 30.0, ease_in=0.5, ease_out=1.0),
    ]
    halo_scale = [
        kf(0, 100.0, ease_in=0.0, ease_out=0.35),
        kf(frames * 0.45, 110.0, ease_in=0.45, ease_out=0.5),
        kf(frames, 100.0, ease_in=0.5, ease_out=1.0),
    ]
    return composition([
        shape_layer(
            "halo",
            [group([ellipse(340, 340), fill(HALO)], "haloFill")],
            opacity_prop=prop_anim(halo_opacity),
            scale_prop=prop_anim(halo_scale),
            frame_count=frames,
            ind=1,
        ),
        shape_layer(
            "orb",
            [group([ellipse(150, 150), fill(CORE)], "orbFill")],
            scale_prop=prop_anim(pulse),
            frame_count=frames,
            ind=2,
        ),
    ], "speaking", frames)


# --------------------------------------------------------------------------- #
# Seamlessness assertions
# --------------------------------------------------------------------------- #
def _approx(a, b):
    """Tolerant comparison that treats a 360-degree rotation as equal to 0."""
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return all(_approx(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        d = abs(float(a) - float(b))
        return d < 0.001 or abs(d - 360.0) < 0.001
    return a == b


def validate_structure(comp, name):
    """
    Light structural checks on the generated Lottie.

    Lottie will not tell you at build time that a composition is malformed - it fails at
    render time on the device, which is exactly the class of bug this project cannot
    afford. These checks catch the common mistakes: a missing transform, a shape group
    without a trailing transform, a non-empty animation with no keyframes.
    """
    problems = []
    if not comp["layers"]:
        problems.append(f"{name}: no layers")

    for layer in comp["layers"]:
        for required in ("o", "r", "p", "a", "s"):
            if required not in layer["ks"]:
                problems.append(f"{name}: layer '{layer['nm']}' missing transform '{required}'")

        for shape in layer.get("shapes", []):
            if shape.get("ty") == "gr":
                items = shape.get("it", [])
                if not items or items[-1].get("ty") != "tr":
                    problems.append(
                        f"{name}: group '{shape.get('nm')}' in layer "
                        f"'{layer['nm']}' has no trailing transform"
                    )
                for item in items:
                    if item.get("ty") in ("el", "sh", "rc"):
                        if "s" not in item and item.get("ty") != "sh":
                            problems.append(
                                f"{name}: {item.get('ty')} in '{shape.get('nm')}' missing 's'"
                            )

        for prop_name, prop in layer["ks"].items():
            if prop.get("a") == 1 and not prop["k"]:
                problems.append(
                    f"{name}: layer '{layer['nm']}' animated '{prop_name}' has no keyframes"
                )
    return problems


def assert_seamless(comp, name):
    """A loop is seamless when every animated property's first and last values agree."""
    problems = []
    for layer in comp["layers"]:
        props = layer["ks"]
        for prop_name, prop in props.items():
            if prop.get("a") != 1:
                continue
            keyframes = prop["k"]
            first = keyframes[0]["s"]
            last = keyframes[-1]["s"]
            if not _approx(first, last):
                problems.append(
                    f"{name}: layer '{layer['nm']}' property '{prop_name}' "
                    f"does not loop ({first} -> {last})"
                )
    return problems


def main():
    out_dir = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "app", "src", "main", "assets", "animations",
    )
    out_dir = os.path.normpath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    builders = [
        ("orb_idle", build_idle),
        ("orb_listening", build_listening),
        ("orb_thinking", build_thinking),
        ("orb_speaking", build_speaking),
    ]

    all_problems = []
    for filename, builder in builders:
        comp = builder()
        problems = assert_seamless(comp, filename)
        problems += validate_structure(comp, filename)
        all_problems.extend(problems)

        path = os.path.join(out_dir, f"{filename}.json")
        with open(path, "w") as fh:
            json.dump(comp, fh, separators=(",", ":"))
        size_kb = os.path.getsize(path) / 1024.0
        print(f"  {filename:16s} {comp['op']:>4d} frames  {size_kb:6.1f} KB  -> {os.path.relpath(path)}")

    if all_problems:
        print("\nSEAMLESSNESS CHECK FAILED:")
        for p in all_problems:
            print("  -", p)
        raise SystemExit(1)

    print("\nAll four animations are loop-seamless (first keyframe == last keyframe).")


if __name__ == "__main__":
    main()
