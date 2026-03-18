#!/usr/bin/env python3
"""
Repeated Take Detector

Finds sequential, near-identical repeated paragraphs in transcript text
and generates an HTML visualization with group highlighting.

Usage:
    python find_repeated_takes.py transcript.txt
    python find_repeated_takes.py transcript.txt -o output.html
    python find_repeated_takes.py raw.txt human.txt -o comparison.html
"""

import argparse
import re
import html as html_lib
from difflib import SequenceMatcher
from pathlib import Path

# ── Configuration (mutable via CLI args) ─────────────────────────────────
CONFIG = {
    'min_words': 8,
    'threshold': 0.85,
}

# ── Regex ────────────────────────────────────────────────────────────────
TIMESTAMP_RE = re.compile(r'\[\d{2}:\d{2}:\d{2}\]')
PAUSE_RE     = re.compile(r'\[\d+\.?\d*s\]')
WORD_RE      = re.compile(r'\b[a-zA-Z]+\b')


def clean_text(text):
    """Strip timestamps, pause markers, punctuation → lowercase word list."""
    text = TIMESTAMP_RE.sub(' ', text)
    text = PAUSE_RE.sub(' ', text)
    return [w.lower() for w in WORD_RE.findall(text)]


def split_paragraphs(text):
    """
    Split transcript into paragraphs.
    Strategy: blank-line split → single-line split → timestamp split.
    """
    # 1) Blank-line split
    paras = [p.strip() for p in re.split(r'\n\s*\n', text.strip()) if p.strip()]
    if len(paras) > 1:
        return paras

    # 2) Single-line split
    paras = [p.strip() for p in text.strip().splitlines() if p.strip()]
    if len(paras) > 1:
        return paras

    # 3) Timestamp split — each [HH:MM:SS] starts a new segment
    parts = re.split(r'(?=\[\d{2}:\d{2}:\d{2}\])', text.strip())
    paras = [p.strip() for p in parts if p.strip()]
    return paras if len(paras) > 1 else [text.strip()]


def find_groups(paragraphs):
    """
    Find groups of sequential, near-identical paragraphs.

    Rules:
    - Both segments ≥ CONFIG['min_words'] after cleaning
    - Same first word AND same last word (cleaned)
    - SequenceMatcher.ratio() ≥ CONFIG['threshold'] over full segments
    - Groups must be consecutive (short paragraphs < CONFIG['min_words'] are skipped
      but do NOT break the chain)
    """
    cleaned = [clean_text(p) for p in paragraphs]
    n = len(paragraphs)

    groups = []        # list of lists of paragraph indices
    in_group = set()

    i = 0
    while i < n:
        if i in in_group or len(cleaned[i]) < CONFIG['min_words']:
            i += 1
            continue

        group = [i]
        j = i + 1

        while j < n:
            # Skip short paragraphs — they don't break chains
            if len(cleaned[j]) < CONFIG['min_words']:
                j += 1
                continue

            last_words = cleaned[group[-1]]
            curr_words = cleaned[j]

            # Boundary rule: same first & last word
            if last_words[0] != curr_words[0] or last_words[-1] != curr_words[-1]:
                break

            # Full-segment similarity
            ratio = SequenceMatcher(None, last_words, curr_words).ratio()
            if ratio >= CONFIG['threshold']:
                group.append(j)
                j += 1
            else:
                break

        if len(group) > 1:
            groups.append(group)
            in_group.update(group)

        i += 1

    return groups, cleaned


# ── HTML generation ──────────────────────────────────────────────────────

GROUP_COLORS = [
    '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#06b6d4', '#84cc16',
]


def esc(text):
    """HTML-escape then highlight timestamps & pauses."""
    text = html_lib.escape(text)
    text = re.sub(
        r'(\[\d{2}:\d{2}:\d{2}\])',
        r'<span class="ts">\1</span>',
        text,
    )
    text = re.sub(
        r'(\[\d+\.?\d*s\])',
        r'<span class="pause">\1</span>',
        text,
    )
    return text


def build_section(title, paragraphs, groups, cleaned):
    """Build HTML for one transcript."""
    # group lookup: para_idx → (group_id, take_num, total_takes)
    gmap = {}
    for gid, grp in enumerate(groups, 1):
        for take, idx in enumerate(grp, 1):
            gmap[idx] = (gid, take, len(grp))

    total_groups = len(groups)
    total_takes  = sum(len(g) for g in groups)

    rows = []
    for i, para in enumerate(paragraphs):
        wc = len(cleaned[i])

        if i in gmap:
            gid, take, total = gmap[i]
            color = GROUP_COLORS[(gid - 1) % len(GROUP_COLORS)]

            sim_html = ''
            if take > 1:
                prev_idx = groups[gid - 1][take - 2]
                ratio = SequenceMatcher(None, cleaned[prev_idx], cleaned[i]).ratio()
                sim_html = f' &middot; {ratio:.0%} match'

            rows.append(f'''
      <div class="para grouped" style="border-left-color:{color}">
        <span class="badge" style="background:{color}">Group {gid} &mdash; Take {take}/{total}{sim_html}</span>
        <span class="meta">&#182; {i+1} &middot; {wc} words</span>
        <div class="txt">{esc(para)}</div>
      </div>''')
        else:
            rows.append(f'''
      <div class="para">
        <span class="meta">&#182; {i+1} &middot; {wc} words</span>
        <div class="txt">{esc(para)}</div>
      </div>''')

    return f'''
    <div class="section">
      <h2>{html_lib.escape(title)}</h2>
      <div class="summary">
        {len(paragraphs)} paragraphs &middot;
        <span class="hl">{total_groups} repeated-take group{"s" if total_groups != 1 else ""}</span>
        ({total_takes} total repeated paragraphs)
      </div>
      {''.join(rows)}
    </div>'''


def generate_html(sections):
    """
    sections: list of (title, paragraphs, groups, cleaned)
    """
    has_tabs = len(sections) > 1

    tab_buttons = ''
    if has_tabs:
        btns = []
        for i, (title, *_) in enumerate(sections):
            active = ' active' if i == 0 else ''
            btns.append(
                f'<button class="tab{active}" onclick="showTab({i})">'
                f'{html_lib.escape(title)}</button>'
            )
        tab_buttons = '<div class="tabs">' + ''.join(btns) + '</div>'

    bodies = []
    for i, (title, paragraphs, groups, cleaned) in enumerate(sections):
        vis = '' if i == 0 else ' style="display:none"'
        bodies.append(f'<div class="tab-body" id="tab{i}"{vis}>'
                      + build_section(title, paragraphs, groups, cleaned)
                      + '</div>')

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Repeated Take Detector</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:'SF Mono','Cascadia Code',Consolas,monospace;background:#09090b;color:#d4d4d8;padding:2rem;line-height:1.7}}
h1{{color:#fff;font-size:1.5rem;margin-bottom:1.5rem}}
h2{{color:#e4e4e7;font-size:1.1rem;margin-bottom:.5rem}}
.tabs{{display:flex;gap:4px;margin-bottom:1.5rem;border-bottom:1px solid #27272a;padding-bottom:0}}
.tab{{background:none;border:none;color:#71717a;font-family:inherit;font-size:.85rem;padding:.6rem 1.2rem;cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}}
.tab:hover{{color:#d4d4d8}}
.tab.active{{color:#fff;border-bottom-color:#fff}}
.summary{{color:#71717a;font-size:.8rem;margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:1px solid #27272a}}
.summary .hl{{color:#22c55e;font-weight:700}}
.para{{padding:1rem 1.2rem;margin-bottom:.6rem;border-radius:8px;background:#18181b;border:1px solid #27272a;border-left:4px solid #27272a;position:relative}}
.para.grouped{{background:#052e16;border-color:#14532d}}
.badge{{display:inline-block;font-size:.7rem;font-weight:700;color:#000;padding:2px 10px;border-radius:4px;margin-right:.6rem;vertical-align:middle}}
.meta{{font-size:.65rem;color:#52525b}}
.txt{{font-size:.82rem;white-space:pre-wrap;margin-top:.4rem}}
.ts{{color:#60a5fa}}
.pause{{color:#fbbf24;background:rgba(251,191,36,.1);padding:0 3px;border-radius:3px}}
</style>
</head>
<body>
<h1>Repeated Take Detector</h1>
{tab_buttons}
{''.join(bodies)}
<script>
function showTab(n){{
  document.querySelectorAll('.tab-body').forEach((el,i)=>el.style.display=i===n?'':'none');
  document.querySelectorAll('.tab').forEach((el,i)=>{{el.classList.toggle('active',i===n)}});
}}
</script>
</body>
</html>'''


# ── Main ─────────────────────────────────────────────────────────────────

def process_file(filepath):
    text = Path(filepath).read_text(encoding='utf-8')
    paragraphs = split_paragraphs(text)
    groups, cleaned = find_groups(paragraphs)
    title = Path(filepath).stem.replace('_', ' ').replace('-', ' ').title()
    return title, paragraphs, groups, cleaned


def main():
    ap = argparse.ArgumentParser(description='Find repeated takes in transcripts')
    ap.add_argument('files', nargs='+', help='One or more transcript text files')
    ap.add_argument('-o', '--output', default='repeated_takes.html',
                    help='Output HTML file (default: repeated_takes.html)')
    ap.add_argument('--min-words', type=int, default=8,
                    help='Minimum words per segment (default: 8)')
    ap.add_argument('--threshold', type=float, default=0.85,
                    help='Similarity threshold 0-1 (default: 0.85)')
    args = ap.parse_args()

    CONFIG['min_words'] = args.min_words
    CONFIG['threshold'] = args.threshold

    sections = []
    for f in args.files:
        title, paragraphs, groups, cleaned = process_file(f)
        n_groups = len(groups)
        n_takes  = sum(len(g) for g in groups)
        print(f'{f}: {len(paragraphs)} paragraphs, '
              f'{n_groups} group(s) ({n_takes} repeated paragraphs)')
        sections.append((title, paragraphs, groups, cleaned))

    html = generate_html(sections)
    Path(args.output).write_text(html, encoding='utf-8')
    print(f'\nGenerated: {args.output}')


if __name__ == '__main__':
    main()
