#!/usr/bin/env python3
import json
import os
import sys
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get('WAKE_WHISPER_MODEL', 'tiny.en')
COMPUTE_TYPE = os.environ.get('WAKE_WHISPER_COMPUTE_TYPE', 'int8')
MODEL_DIR = os.environ.get('WHISPER_CACHE_DIR')

model = WhisperModel(MODEL_SIZE, device='cpu', compute_type=COMPUTE_TYPE, download_root=MODEL_DIR)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        audio = req.get('audio')
        segments, info = model.transcribe(audio, vad_filter=True, beam_size=1, language='en')
        text = ' '.join((seg.text or '').strip() for seg in segments).strip()
        sys.stdout.write(json.dumps({'ok': True, 'text': text}) + '\n')
        sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(json.dumps({'ok': False, 'error': str(e)}) + '\n')
        sys.stdout.flush()
