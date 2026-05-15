#!/usr/bin/env python3
import os
import sys
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get('WHISPER_MODEL', 'small.en')
COMPUTE_TYPE = os.environ.get('WHISPER_COMPUTE_TYPE', 'int8')
MODEL_DIR = os.environ.get('WHISPER_CACHE_DIR')

_audio = sys.argv[1]

model = WhisperModel(MODEL_SIZE, device='cpu', compute_type=COMPUTE_TYPE, download_root=MODEL_DIR)
segments, info = model.transcribe(_audio, vad_filter=True, beam_size=1, language='en')
text = ' '.join((seg.text or '').strip() for seg in segments).strip()
print(text)
