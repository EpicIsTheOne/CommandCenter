#!/usr/bin/env python3
import json
import os
import sys
import tempfile
from pocketsphinx import AudioFile, get_model_path

MODEL = get_model_path()
HMM = os.path.join(MODEL, 'en-us', 'en-us')

WORDS = {
    'astra': 'AE S T R AH',
    'astra(2)': 'AA S T R AH',
    'astra(3)': 'AE S T ER AH',
    'miyabi': 'M IY Y AA B IY',
    'miyaby': 'M IY Y AA B IY',
    'miyabby': 'M IY Y AE B IY',
    'mina': 'M IY N AH',
    'meena': 'M IY N AH',
    'lyra': 'L AY R AH',
    'lira': 'L IH R AH',
    'niko': 'N IY K OW',
    'nico': 'N IH K OW',
    'pip': 'P IH P',
    'mochi': 'M OW CH IY',
}

ALIASES = {
    'orchestrator': ['astra'],
    'builder': ['miyabi', 'miyaby', 'miyabby'],
    'qa': ['mina', 'meena'],
    'researcher': ['lyra', 'lira'],
    'comms': ['niko', 'nico'],
    'emotional-support-1': ['pip'],
    'emotional-support-2': ['mochi'],
}

THRESHOLDS = {
    'astra': 1e-14,
    'miyabi': 1e-14,
    'miyaby': 1e-14,
    'miyabby': 1e-14,
    'mina': 1e-16,
    'meena': 1e-16,
    'jane': 1e-16,
    'janedoe': 1e-16,
    'lyra': 1e-16,
    'lira': 1e-16,
    'niko': 1e-16,
    'nico': 1e-16,
    'pip': 1e-6,
    'mochi': 1e-14,
}

with tempfile.NamedTemporaryFile('w', suffix='.dict', delete=False) as f:
    for word, pron in WORDS.items():
        f.write(f'{word} {pron}\n')
    DICT = f.name

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        audio = req.get('audio')
        detected = None
        for agent_id, aliases in ALIASES.items():
            for alias in aliases:
                phrase = alias.lower()
                speech = AudioFile(audio_file=audio, hmm=HMM, lm=False, keyphrase=phrase, kws_threshold=THRESHOLDS.get(phrase, 1e-16), dict=DICT)
                hit = False
                for seg in speech:
                    if seg.hypothesis():
                        hit = True
                        break
                if hit:
                    detected = {'agentId': agent_id, 'alias': alias}
                    break
            if detected:
                break
        sys.stdout.write(json.dumps({'ok': True, 'match': detected}) + '\n')
        sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(json.dumps({'ok': False, 'error': str(e)}) + '\n')
        sys.stdout.flush()
dout.flush()
