#!/usr/bin/env python3
"""Host smoke test for the Vani Phonon-UltraLight Paradee pack.

Checks the adapter against the original graph with a fixed random seed and
runs sherpa-onnx's phoneme-input path for every voice, without needing Android.
"""
import pathlib
import sys

import numpy as np
import onnx
import onnxruntime as ort
import sherpa_onnx as sherpa


def seeded_session(path):
    model = onnx.load(str(path))
    for node in model.graph.node:
        if node.op_type == "RandomNormalLike":
            node.attribute.append(onnx.helper.make_attribute("seed", 123.0))
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    return ort.InferenceSession(model.SerializeToString(), opts, providers=["CPUExecutionProvider"])


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: verify-paradee.py <original.onnx> <adapted-pack-dir>")
    original = pathlib.Path(sys.argv[1])
    pack = pathlib.Path(sys.argv[2])
    sessions = [seeded_session(original), seeded_session(pack / "model.onnx")]
    ids = np.array([[0, 50, 83, 54, 57, 4, 0]], dtype=np.int64)
    for sid in range(4):
        expected = sessions[0].run(None, {
            "input_ids": ids, "speed": np.array([1.0], np.float32), "voice": np.array([sid], np.int64),
        })[0]
        actual = sessions[1].run(None, {
            "input_ids": ids, "speed": np.array([1.0], np.float32), "style": np.array([[sid]], np.float32),
        })[0]
        np.testing.assert_array_equal(expected, actual)
        print(f"voice {sid}: adapted ONNX output matches exactly ({actual.size} samples)")

    config = sherpa.OfflineTtsConfig(model=sherpa.OfflineTtsModelConfig(
        kokoro=sherpa.OfflineTtsKokoroModelConfig(
            model=str(pack / "model.onnx"), voices=str(pack / "voices.bin"), tokens=str(pack / "tokens.txt"),
        ), num_threads=1,
    ))
    tts = sherpa.OfflineTts(config)
    assert tts.sample_rate == 24000 and tts.num_speakers == 4
    for sid in range(4):
        generation = sherpa.GenerationConfig()
        generation.sid = sid
        generation.silence_scale = 1.0
        generation.phoneme_codepoints = [[ord(c) for c in "həlˈoʊ."]]
        audio = tts.generate("", generation)
        assert audio.sample_rate == 24000 and len(audio.samples) > 0
        assert np.isfinite(audio.samples).all()
        print(f"voice {sid}: sherpa generated {len(audio.samples)} finite samples at 24 kHz")


if __name__ == "__main__":
    main()
