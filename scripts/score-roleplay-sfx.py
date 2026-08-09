#!/usr/bin/env python3
import json, math, os, re, subprocess, sys
from pathlib import Path
from collections import defaultdict

ROOT = Path('/root/.openclaw/workspace/openclaw-command-center')
CATALOG = ROOT / 'public/assets/roleplay-sfx/ameafterdark/catalog.json'
OUT_JSON = ROOT / 'public/assets/roleplay-sfx/ameafterdark/scored-catalog.json'
OUT_MD = ROOT / 'public/assets/roleplay-sfx/ameafterdark/scored-report.md'
WEIGHTS_JSON = ROOT / 'public/assets/roleplay-sfx/ameafterdark/weighted-recommendations.json'


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True)


def ffprobe_json(path):
    cmd = ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', str(path)]
    return json.loads(run(cmd).stdout)


def volumedetect(path):
    cmd = ['ffmpeg', '-hide_banner', '-i', str(path), '-af', 'volumedetect', '-f', 'null', '-']
    proc = subprocess.run(cmd, capture_output=True, text=True)
    text = (proc.stderr or '') + '\n' + (proc.stdout or '')
    def grab(name):
        m = re.search(rf'{re.escape(name)}:\s*(-?\d+(?:\.\d+)?)\s*dB', text)
        return float(m.group(1)) if m else None
    return {
        'mean_volume_db': grab('mean_volume'),
        'max_volume_db': grab('max_volume'),
    }


def silencedetect(path):
    cmd = ['ffmpeg', '-hide_banner', '-i', str(path), '-af', 'silencedetect=noise=-38dB:d=0.08', '-f', 'null', '-']
    proc = subprocess.run(cmd, capture_output=True, text=True)
    text = (proc.stderr or '') + '\n' + (proc.stdout or '')
    starts = [float(x) for x in re.findall(r'silence_start:\s*([0-9.]+)', text)]
    ends = [float(x) for x in re.findall(r'silence_end:\s*([0-9.]+)', text)]
    durs = [float(x) for x in re.findall(r'silence_end:\s*[0-9.]+\s*\|\s*silence_duration:\s*([0-9.]+)', text)]
    leading = 0.0
    trailing = 0.0
    if starts and starts[0] <= 0.02 and durs:
        leading = durs[0]
    if durs and ends:
        trailing = durs[-1]
    return {
        'leading_silence_s': leading,
        'trailing_silence_s': trailing,
        'silence_segments': len(durs),
        'total_silence_s': sum(durs),
    }


def parse_title_hints(title):
    t = title.lower()
    score = 0.0
    if any(x in t for x in ['intense', 'extreme']): score += 0.18
    elif 'high' in t: score += 0.12
    elif 'medium' in t: score += 0.08
    elif 'low' in t: score += 0.04
    if 'mouth closed' in t: score += 0.06
    if 'edited-take' in t: score -= 0.02
    if any(x in t for x in ['orgasm', 'teasing', 'licks', 'kisses', 'sighs']): score += 0.04
    return score


def score_clip(item, stats):
    duration = stats['duration_s'] or 0
    lead = stats['leading_silence_s'] or 0
    trail = stats['trailing_silence_s'] or 0
    mean_db = stats['mean_volume_db'] if stats['mean_volume_db'] is not None else -30
    max_db = stats['max_volume_db'] if stats['max_volume_db'] is not None else -8
    silence_segments = stats['silence_segments'] or 0
    score = 0.5

    if item['bucket'] == 'loops':
        if 1.5 <= duration <= 6.5: score += 0.16
        elif 0.9 <= duration <= 8.5: score += 0.08
        else: score -= 0.10
    else:
        if 0.25 <= duration <= 3.2: score += 0.18
        elif duration <= 5.0: score += 0.08
        else: score -= 0.08

    if lead <= 0.05: score += 0.10
    elif lead <= 0.18: score += 0.04
    elif lead > 0.45: score -= 0.12
    else: score -= 0.04

    if trail > 0.8: score -= 0.06
    elif trail > 0.35: score -= 0.02

    if -23 <= mean_db <= -11: score += 0.10
    elif -28 <= mean_db <= -8: score += 0.05
    else: score -= 0.08

    if -4.5 <= max_db <= -0.2: score += 0.08
    elif max_db > -0.1: score -= 0.10
    elif max_db < -10: score -= 0.06

    if silence_segments >= 5: score -= 0.08
    elif silence_segments >= 3: score -= 0.03

    score += parse_title_hints(item['title'])
    score = max(0.0, min(1.0, score))
    if score >= 0.82: tier = 'S'
    elif score >= 0.68: tier = 'A'
    elif score >= 0.54: tier = 'B'
    elif score >= 0.40: tier = 'C'
    else: tier = 'D'
    return score, tier


def weight_from_score(score):
    if score >= 0.88: return 1.0
    if score >= 0.78: return 0.85
    if score >= 0.68: return 0.7
    if score >= 0.58: return 0.5
    if score >= 0.46: return 0.3
    return 0.15


items = json.loads(CATALOG.read_text())
scored = []
for idx, item in enumerate(items, 1):
    rel = item['assetPath'].lstrip('/')
    path = ROOT / 'public' / rel.replace('assets/', 'assets/', 1)
    meta = ffprobe_json(path)
    fmt = meta.get('format', {})
    vol = volumedetect(path)
    sil = silencedetect(path)
    stats = {
        'duration_s': float(fmt.get('duration', 0) or 0),
        'bit_rate': int(fmt.get('bit_rate', 0) or 0),
        **vol,
        **sil,
    }
    score, tier = score_clip(item, stats)
    scored.append({
        **item,
        'stats': stats,
        'qualityScore': round(score, 4),
        'tier': tier,
        'weight': weight_from_score(score),
    })
    if idx % 15 == 0:
        print(f'scored {idx}/{len(items)}')

OUT_JSON.write_text(json.dumps(scored, indent=2) + '\n')

by_tag = defaultdict(list)
for item in scored:
    for tag in item.get('tags', []):
        by_tag[(item['bucket'], tag)].append(item)

weighted = {'loops': {}, 'accents': {}}
lines = ['# AmeAfterDark SFX Scoring Report', '']
for (bucket, tag), arr in sorted(by_tag.items()):
    arr.sort(key=lambda x: (-x['qualityScore'], x['title']))
    weighted[bucket][tag] = [
        {
            'assetPath': x['assetPath'],
            'title': x['title'],
            'score': x['qualityScore'],
            'tier': x['tier'],
            'weight': x['weight'],
        }
        for x in arr
    ]
    lines.append(f'## {bucket}:{tag} ({len(arr)})')
    lines.append('')
    for x in arr[:8]:
        s = x['stats']
        lines.append(f"- {x['tier']} {x['qualityScore']:.3f} w={x['weight']:.2f} — {x['title']} | dur={s['duration_s']:.2f}s lead={s['leading_silence_s']:.2f}s trail={s['trailing_silence_s']:.2f}s mean={s['mean_volume_db']}dB max={s['max_volume_db']}dB")
    lines.append('')

WEIGHTS_JSON.write_text(json.dumps(weighted, indent=2) + '\n')
OUT_MD.write_text('\n'.join(lines) + '\n')
print(f'wrote {OUT_JSON}')
print(f'wrote {WEIGHTS_JSON}')
print(f'wrote {OUT_MD}')
