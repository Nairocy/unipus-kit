#!/usr/bin/env python3
"""把一段音频转成带时间戳的文本，供 unipus-kit 的听力/视频题作答使用。

用法:
  python scripts/transcribe.py <input.wav|mp3|mp4> <output.txt>

依赖（可选，缺失时 media.mjs 会跳过转写而不报错）:
  pip install faster-whisper

模型:
  默认读环境变量 UP_WHISPER_DIR，否则用 'small.en'（首次会从 HuggingFace 下载）。
  ⚠️ 墙内建议先把模型下载到本地目录，再用 UP_WHISPER_DIR 指过去 —— 直接传 'small.en'
  会让 ctranslate2 去 HF 解析，网络不通时会挂很久。
"""
import os
import sys


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, out = sys.argv[1], sys.argv[2]

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print('faster-whisper 未安装：pip install faster-whisper', file=sys.stderr)
        return 3

    model_dir = os.environ.get('UP_WHISPER_DIR') or 'small.en'
    model = WhisperModel(model_dir, device='cpu', compute_type='int8')
    segments, _ = model.transcribe(src, beam_size=1, vad_filter=False, language='en')

    rows = []
    for s in segments:
        text = s.text.strip()
        if text:
            rows.append('%.2f-%.2f %s' % (s.start, s.end, text))

    os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(rows))
    print('ok %s (%d segments)' % (out, len(rows)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
