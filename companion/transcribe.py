#!/usr/bin/env python3
"""Local-only Whisper adapter. Audio and the successful JSON transcript stay on Mac."""

import argparse
import contextlib
import importlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import sys
import wave

SAMPLE_RATE = 16000
MAX_SECONDS = 600
MAX_AUDIO_BYTES = SAMPLE_RATE * MAX_SECONDS * 2
MAX_TEXT_LENGTH = 20000
BACKEND = "mlx-whisper"


class SpeechError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__("Local speech recognition could not complete.")


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise SpeechError("invalid_audio")


def offline_environment():
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE",
                 "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_PROGRESS_BARS", "DO_NOT_TRACK"):
        os.environ[name] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"


@contextlib.contextmanager
def no_network():
    """This separate worker never needs a socket, including for model loading."""
    def blocked(*args, **kwargs):
        raise OSError("Network access is disabled for local speech recognition.")

    originals = [(socket.socket, "connect", socket.socket.connect),
                 (socket.socket, "connect_ex", socket.socket.connect_ex)]
    for name in ("create_connection", "getaddrinfo", "gethostbyname", "gethostbyname_ex"):
        originals.append((socket, name, getattr(socket, name)))
    try:
        for owner, name, _ in originals:
            setattr(owner, name, blocked)
        yield
    finally:
        for owner, name, original in reversed(originals):
            setattr(owner, name, original)


@contextlib.contextmanager
def quiet_backend():
    """Suppress Python progress and native-library diagnostics, which may hold text."""
    saved = []
    with open(os.devnull, "w") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            try:
                for descriptor in (1, 2):
                    saved.append((descriptor, os.dup(descriptor)))
                    os.dup2(sink.fileno(), descriptor)
                yield
            finally:
                for descriptor, original in reversed(saved):
                    os.dup2(original, descriptor)
                    os.close(original)


def local_model(value):
    candidate = Path(value)
    if not candidate.is_absolute():
        raise SpeechError("unavailable")
    try:
        model = candidate.resolve(strict=True)
        config_path = model / "config.json"
        weights = [model / "weights.safetensors", model / "weights.npz"]
        if not model.is_dir() or not config_path.is_file() or config_path.stat().st_size > 65536:
            raise SpeechError("unavailable")
        if not any(item.is_file() and 0 < item.stat().st_size <= 4 * 1024 ** 3 for item in weights):
            raise SpeechError("unavailable")
        config = json.loads(config_path.read_text(encoding="utf-8"))
        for name in ("n_mels", "n_audio_ctx", "n_audio_state", "n_audio_head", "n_audio_layer",
                     "n_vocab", "n_text_ctx", "n_text_state", "n_text_head", "n_text_layer"):
            if not isinstance(config.get(name), int) or isinstance(config[name], bool) or not 0 < config[name] < 1000000:
                raise SpeechError("unavailable")
        return model
    except SpeechError:
        raise
    except Exception:
        raise SpeechError("unavailable") from None


def read_wav(value):
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.is_symlink():
        raise SpeechError("invalid_audio")
    try:
        audio_path = candidate.resolve(strict=True)
        if not audio_path.is_file() or audio_path.stat().st_size > MAX_AUDIO_BYTES + 1024 * 1024:
            raise SpeechError("invalid_audio")
        with wave.open(str(audio_path), "rb") as stream:
            if stream.getnchannels() != 1 or stream.getframerate() != SAMPLE_RATE \
                    or stream.getsampwidth() != 2 or stream.getcomptype() != "NONE":
                raise SpeechError("invalid_audio")
            count = stream.getnframes()
            if count > SAMPLE_RATE * MAX_SECONDS:
                raise SpeechError("duration_limit")
            if count == 0:
                raise SpeechError("no_speech")
            raw = stream.readframes(count + 1)
            if len(raw) != count * 2 or len(raw) > MAX_AUDIO_BYTES:
                raise SpeechError("invalid_audio")
        import numpy as np
        audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if not bool(np.isfinite(audio).all()) or float(np.max(np.abs(audio))) < 0.0001:
            raise SpeechError("no_speech")
        return audio
    except SpeechError:
        raise
    except Exception:
        raise SpeechError("invalid_audio") from None


def load_backend():
    try:
        backend = importlib.import_module("mlx_whisper")
        assets = Path(backend.__file__).parent / "assets"
        if not all((assets / name).is_file() for name in ("mel_filters.npz", "multilingual.tiktoken")):
            raise SpeechError("unavailable")
        # A missing/raced-away local model must never turn into a Hub download.
        def no_download(*args, **kwargs):
            raise SpeechError("unavailable")
        backend.load_models.snapshot_download = no_download
        return backend
    except SpeechError:
        raise
    except Exception:
        raise SpeechError("unavailable") from None


def check_backend():
    """Cheap health check: no model weights, Torch import or remote lookups."""
    try:
        package = importlib.util.find_spec("mlx_whisper")
        if not package or not package.origin:
            raise SpeechError("unavailable")
        assets = Path(package.origin).parent / "assets"
        if not all((assets / name).is_file() for name in ("mel_filters.npz", "multilingual.tiktoken")):
            raise SpeechError("unavailable")
        for name in ("mlx", "numpy", "numba", "torch", "tiktoken", "huggingface_hub", "scipy"):
            if importlib.util.find_spec(name) is None:
                raise SpeechError("unavailable")
    except SpeechError:
        raise
    except Exception:
        raise SpeechError("unavailable") from None


def recognized_text(result):
    if not isinstance(result, dict) or not isinstance(result.get("text"), str):
        raise SpeechError("recognition_failed")
    text = result["text"].strip()
    if not text:
        raise SpeechError("no_speech")
    if len(text) > MAX_TEXT_LENGTH or "\x00" in text:
        raise SpeechError("recognition_failed")
    segments = result.get("segments")
    if isinstance(segments, list) and segments:
        plausible = [segment for segment in segments if isinstance(segment, dict)
                     and isinstance(segment.get("text"), str) and segment["text"].strip()
                     and float(segment.get("no_speech_prob", 0)) <= 0.8
                     and float(segment.get("avg_logprob", 0)) >= -1.5]
        if not plausible:
            raise SpeechError("no_speech")
    output = {"text": text}
    language = result.get("language")
    if isinstance(language, str) and re.fullmatch(r"[a-z]{2,3}", language):
        output["language"] = language
    return output


def run(args, backend_loader=None):
    offline_environment()
    model = local_model(args.model)
    with no_network(), quiet_backend():
        if args.check:
            if backend_loader is None:
                check_backend()
            else:
                backend_loader()
            return {"ready": True, "backend": BACKEND}
        if not args.audio:
            raise SpeechError("invalid_audio")
        audio = read_wav(args.audio)
        backend = (backend_loader or load_backend)()
        try:
            result = backend.transcribe(audio, path_or_hf_repo=str(model), verbose=None,
                                        temperature=0.0, condition_on_previous_text=False,
                                        task="transcribe", word_timestamps=False)
            return recognized_text(result)
        except SpeechError:
            raise
        except Exception:
            raise SpeechError("recognition_failed") from None


def main(argv=None):
    requested = list(sys.argv[1:] if argv is None else argv)
    checking = "--check" in requested
    try:
        parser = QuietParser(description="Local-only speech recognition", add_help=False)
        parser.add_argument("--model", required=True)
        parser.add_argument("--audio")
        parser.add_argument("--check", action="store_true")
        args = parser.parse_args(requested)
        result = run(args)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except SpeechError as error:
        print(json.dumps({"error": error.code, **({"ready": False, "backend": BACKEND} if checking else {})}), flush=True)
        return 1
    except Exception:
        print(json.dumps({"error": "recognition_failed", **({"ready": False, "backend": BACKEND} if checking else {})}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
