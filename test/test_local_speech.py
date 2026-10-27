import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

MODULE_PATH = Path(__file__).resolve().parents[1] / "companion" / "transcribe.py"
SPEC = importlib.util.spec_from_file_location("local_transcribe", MODULE_PATH)
speech = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(speech)


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="shaikh-speech-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.model = self.root / "model"
        self.model.mkdir()
        config = {name: 1 for name in ("n_mels", "n_audio_ctx", "n_audio_state", "n_audio_head", "n_audio_layer",
                                      "n_vocab", "n_text_ctx", "n_text_state", "n_text_head", "n_text_layer")}
        (self.model / "config.json").write_text(json.dumps(config))
        (self.model / "weights.npz").write_bytes(b"fixture")
        self.audio = self.root / "audio.wav"
        self.wav(self.audio)

    @staticmethod
    def wav(filename, *, channels=1, rate=16000, width=2, silence=False):
        with wave.open(str(filename), "wb") as stream:
            stream.setnchannels(channels)
            stream.setsampwidth(width)
            stream.setframerate(rate)
            stream.writeframes((b"\x00\x00" if silence else b"\x00\x20") * channels * 1600)

    def args(self, check=False):
        return argparse.Namespace(model=str(self.model), audio=str(self.audio), check=check)

    def test_model_must_be_complete_absolute_local_directory(self):
        self.assertEqual(speech.local_model(str(self.model)), self.model.resolve())
        for value in ["mlx-community/whisper-small", "https://example.test/model", str(self.root / "missing")]:
            with self.assertRaises(speech.SpeechError) as found:
                speech.local_model(value)
            self.assertEqual(found.exception.code, "unavailable")
        (self.model / "weights.npz").unlink()
        with self.assertRaises(speech.SpeechError):
            speech.local_model(str(self.model))

    def test_audio_is_validated_and_passed_as_samples_not_filename(self):
        observed = {}
        def recognize(audio, **options):
            observed.update({"audio": audio, "options": options})
            return {"text": "  Synthetic local thought. ", "language": "ru", "segments": [{"text": "Synthetic local thought.", "no_speech_prob": 0.1, "avg_logprob": -0.2}]}
        result = speech.run(self.args(), lambda: types.SimpleNamespace(transcribe=recognize))
        self.assertEqual(result, {"text": "Synthetic local thought.", "language": "ru"})
        self.assertEqual(observed["audio"].dtype.name, "float32")
        self.assertEqual(observed["audio"].shape, (1600,))
        self.assertEqual(observed["options"]["path_or_hf_repo"], str(self.model.resolve()))
        self.assertEqual(observed["options"]["task"], "transcribe")
        self.assertIsNone(observed["options"]["verbose"])

    def test_check_needs_no_audio_or_model_generation(self):
        self.audio.unlink()
        backend = types.SimpleNamespace(transcribe=lambda *_a, **_k: self.fail("No generation during check"))
        self.assertEqual(speech.run(self.args(check=True), lambda: backend), {"ready": True, "backend": "mlx-whisper"})

    def test_wrong_audio_format_truncation_and_symlink_are_rejected(self):
        for options in [{"channels": 2}, {"rate": 8000}, {"width": 1}]:
            self.wav(self.audio, **options)
            with self.assertRaises(speech.SpeechError) as found:
                speech.read_wav(str(self.audio))
            self.assertEqual(found.exception.code, "invalid_audio")
        self.wav(self.audio)
        self.audio.write_bytes(self.audio.read_bytes()[:-2])
        with self.assertRaises(speech.SpeechError):
            speech.read_wav(str(self.audio))
        linked = self.root / "link.wav"
        linked.symlink_to(self.audio)
        with self.assertRaises(speech.SpeechError):
            speech.read_wav(str(linked))

    def test_long_and_oversized_audio_rejected_before_inference(self):
        count = 601 * speech.SAMPLE_RATE * 2
        header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + count, b"WAVE", b"fmt ", 16, 1, 1,
                             speech.SAMPLE_RATE, speech.SAMPLE_RATE * 2, 2, 16, b"data", count)
        self.audio.write_bytes(header + b"\x00\x20")
        with self.assertRaises(speech.SpeechError) as found:
            speech.read_wav(str(self.audio))
        self.assertEqual(found.exception.code, "duration_limit")
        with self.audio.open("wb") as stream:
            stream.truncate(speech.MAX_AUDIO_BYTES + 1024 * 1024 + 1)
        with self.assertRaises(speech.SpeechError):
            speech.read_wav(str(self.audio))

    def test_silence_and_low_confidence_hallucination_are_not_returned(self):
        self.wav(self.audio, silence=True)
        with self.assertRaises(speech.SpeechError) as found:
            speech.read_wav(str(self.audio))
        self.assertEqual(found.exception.code, "no_speech")
        with self.assertRaises(speech.SpeechError):
            speech.recognized_text({"text": "Hallucinated phrase", "segments": [{"text": "Hallucinated phrase", "no_speech_prob": 0.99, "avg_logprob": -2.0}]})
        with self.assertRaises(speech.SpeechError):
            speech.recognized_text({"text": " "})
        with self.assertRaises(speech.SpeechError):
            speech.recognized_text({"text": "x" * 20001})

    def test_worker_blocks_socket_and_dns_and_restores_host_process(self):
        original = socket.getaddrinfo
        with speech.no_network():
            with self.assertRaises(OSError):
                socket.getaddrinfo("should-never-resolve.invalid", 443)
            with socket.socket() as connection:
                with self.assertRaises(OSError):
                    connection.connect(("127.0.0.1", 9))
        self.assertIs(socket.getaddrinfo, original)
        self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")

    def test_python_and_native_backend_diagnostics_are_suppressed(self):
        def recognize(_audio, **_options):
            print("PRIVATE TRANSCRIPT")
            os.write(1, b"NATIVE PRIVATE OUTPUT")
            os.write(2, b"NATIVE PRIVATE ERROR")
            return {"text": "Synthetic result"}
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = speech.run(self.args(), lambda: types.SimpleNamespace(transcribe=recognize))
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(result["text"], "Synthetic result")

    def test_cli_failure_json_does_not_contain_path_or_exception_text(self):
        for arguments, expected in [(["--model", "https://private.invalid/model", "--check"], "unavailable"),
                                    (["--unknown"], "invalid_audio")]:
            output = io.StringIO()
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                result = speech.main(arguments)
            data = json.loads(output.getvalue())
            self.assertEqual(result, 1)
            self.assertEqual(data["error"], expected)
            self.assertNotIn("private", output.getvalue())
            self.assertNotIn("Traceback", output.getvalue())
        with patch.object(speech, "run", side_effect=RuntimeError("PRIVATE TRANSCRIPT /private/path")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                speech.main(["--model", str(self.model), "--audio", str(self.audio)])
            self.assertEqual(json.loads(output.getvalue()), {"error": "recognition_failed"})


if __name__ == "__main__":
    unittest.main()
