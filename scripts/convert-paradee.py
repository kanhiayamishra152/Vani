#!/usr/bin/env python3
"""Adapt Paradee 1.2 to the sherpa-onnx 2.0.1 Kokoro model contract.

Paradee's graph takes (input_ids, speed, voice:int64). Sherpa's Kokoro
backend supplies (input_ids, style:float, speed). The wrapper only inserts
Cast/Reshape nodes and metadata; all learned weights and audio math remain
byte-for-byte the original Paradee INT8 graph. The technique is based on the
Apache-2.0 Paradee Android adapter by skypie0102.
"""
import json
import pathlib
import struct
import sys

import onnx
from onnx import TensorProto, helper


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: convert-paradee.py <paradee_int8.onnx> <config.json> <out-dir>")
    src, config_path, out_arg = map(pathlib.Path, sys.argv[1:])
    out = out_arg
    out.mkdir(parents=True, exist_ok=True)
    cfg = json.loads(config_path.read_text(encoding="utf-8"))
    if str(cfg.get("version")) != "1.2" or len(cfg.get("voices", [])) != 4:
        raise ValueError("Paradee 1.2 with exactly four voices is required")

    model = onnx.load(str(src))
    graph = model.graph
    inputs = {x.name: x for x in graph.input}
    if list(inputs) != ["input_ids", "speed", "voice"]:
        raise ValueError(f"unexpected Paradee inputs: {list(inputs)}")
    del graph.input[:]
    graph.input.extend([
        inputs["input_ids"],
        helper.make_tensor_value_info("style", TensorProto.FLOAT, [1, 1]),
        inputs["speed"],
    ])
    graph.initializer.append(helper.make_tensor("paradee_voice_shape", TensorProto.INT64, [1], [1]))
    graph.node.insert(0, helper.make_node("Reshape", ["paradee_voice_float", "paradee_voice_shape"], ["paradee_voice_flat"]))
    graph.node.insert(0, helper.make_node("Cast", ["style"], ["paradee_voice_float"], to=TensorProto.FLOAT))
    graph.node.insert(2, helper.make_node("Cast", ["paradee_voice_flat"], ["voice"], to=TensorProto.INT64))

    # Kokoro reads these properties to expose four speakers at 24 kHz.
    metadata = {
        "sample_rate": "24000",
        "version": "1",
        "n_speakers": "4",
        "style_dim": "512,1,1",
        "voice": "en-us",
        "speaker_names": ",".join(cfg["voices"]),
    }
    for key, value in metadata.items():
        entry = model.metadata_props.add()
        entry.key = key
        entry.value = value
    onnx.checker.check_model(model)
    onnx.save(model, str(out / "model.onnx"))

    # Each row is a 512-float style vector containing the integer speaker id.
    (out / "voices.bin").write_bytes(b"".join(struct.pack("<f", float(sid)) * 512 for sid in range(4)))
    with (out / "tokens.txt").open("w", encoding="utf-8") as f:
        for char, index in cfg["vocab"].items():
            f.write(f"{char} {index}\n" if char != " " else f"{index}\n")
    (out / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "NOTICE.txt").write_text(
        "Phonon Ultra-Light is packaged for Vani AI.\n"
        "Model: Paradee-8M v1.2, sahilmahendrakar/Paradee-8M-v1.2.\n"
        "Model license: Apache-2.0. Weights are unchanged; only the input adapter is added.\n"
        "Text frontend: piper-phonemize (separate native dependency; see its license).\n",
        encoding="utf-8",
    )
    print(f"Wrote adapted four-voice Paradee pack to {out}")


if __name__ == "__main__":
    main()
