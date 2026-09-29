#!/usr/bin/env python3
"""Build a private collector-only ZIP from an explicit source allowlist.

Developer build tool. End users only extract the ZIP and use Codex's Plugins UI.
No credentials, user workbooks, local app runtimes, Git checkout or network calls.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = 'plugins/threads-collector'
FILES = (
    '.codex-plugin/plugin.json', 'README.md',
    'references/local-settings.md', 'references/collection-source.md',
    'scripts/collection_journal.py', 'scripts/setup_collection.py',
    'scripts/collection_source.py', 'scripts/threads_source/__init__.py',
    'scripts/threads_source/excel_input.py', 'scripts/threads_source/files.py',
    'scripts/threads_source/legacy_jsonl.py', 'scripts/threads_source/service.py',
    'scripts/threads_source/workbook_write.py',
    'skills/threads-collect/SKILL.md', 'skills/threads-collect/agents/openai.yaml',
    'skills/threads-collect/assets/accounts.xlsx',
    'skills/threads-collect/assets/daily-results.xlsx',
    'skills/threads-collect/references/storage-layout.md',
    'skills/threads-collect/references/excel-contract.md',
    'skills/threads-collect/references/journal-contract.md',
    'skills/threads-setup/SKILL.md', 'skills/threads-setup/agents/openai.yaml',
    'skills/threads-plugin-check/SKILL.md', 'skills/threads-plugin-check/agents/openai.yaml',
    'skills/threads-update/SKILL.md', 'skills/threads-update/agents/openai.yaml',
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def guide_html(markdown):
    # This small renderer supports the controlled headings/paragraphs/fences in
    # our shipped guides. Escape all content; no remote resources or scripts.
    blocks = []
    code = None
    def inline(text):
        text = html.escape(text)
        text = re.sub(r'\[([^\]]+)\]\((https://[^\s)]+)\)', r'<a href="\2">\1</a>', text)
        text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
        return re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    for line in markdown.splitlines():
        if line.startswith('```'):
            if code is None:
                code = []
            else:
                blocks.append('<pre>' + html.escape('\n'.join(code)) + '</pre>')
                code = None
        elif code is not None:
            code.append(line)
        elif line.startswith('#'):
            level = min(len(line) - len(line.lstrip('#')), 6)
            blocks.append(f'<h{level}>' + inline(line[level:].strip()) + f'</h{level}>')
        elif line.strip():
            blocks.append('<p>' + inline(line) + '</p>')
    if code is not None:
        raise ValueError('Unclosed guide code fence')
    return ('<!doctype html><html lang="ko"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Threads Windows 테스트 안내</title><style>'
            'body{max-width:850px;margin:48px auto;padding:0 24px;font:17px/1.8 system-ui,sans-serif;color:#1f2937}'
            'h1,h2,h3{line-height:1.4}h2{margin-top:2em}a{color:#4338ca}'
            'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:20px;border-radius:12px}'
            'code{background:#f1f5f9}p{overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}}'
            '</style><body>' + '\n'.join(blocks) + '</body></html>')


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / PLUGIN / '.codex-plugin/plugin.json').read_text())
    catalog = json.loads((ROOT / 'distribution/collector/marketplace.json').read_text())
    if catalog['name'] != 'threads-collector-testing' or len(catalog['plugins']) != 1:
        raise ValueError('Unexpected distribution marketplace')
    if catalog['plugins'][0]['source'] != {'source': 'local', 'path': './' + PLUGIN}:
        raise ValueError('Distribution marketplace must resolve to bundled collector')
    version = manifest['version']
    if not re.fullmatch(r'[0-9A-Za-z.+-]+', version):
        raise ValueError('Invalid filename version')
    name = f'ThreadsCollector-{version}.zip'
    with tempfile.TemporaryDirectory(prefix='tmm-collector-build-') as temporary:
        stage = Path(temporary) / 'ThreadsCollector'
        payload = {f'{PLUGIN}/{path}': ROOT / PLUGIN / path for path in FILES}
        payload['.agents/plugins/marketplace.json'] = ROOT / 'distribution/collector/marketplace.json'
        payload['INSTALL.md'] = ROOT / 'distribution/collector/INSTALL.md'
        for relative, source in payload.items():
            if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(ROOT):
                raise ValueError(f'Invalid package input: {relative}')
            dest = stage / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
        (stage / '설치안내.html').write_text(guide_html((stage / 'INSTALL.md').read_text()), encoding='utf-8')
        hashes = {p.relative_to(stage).as_posix(): digest(p.read_bytes())
                  for p in sorted(stage.rglob('*')) if p.is_file()}
        report = {'plugin': manifest['name'], 'version': version, 'marketplace': catalog['name'],
                  'scope': 'private-windows-final-test', 'windowsManualTest': 'pending',
                  'sha256': hashes}
        (stage / 'PACKAGE.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary_zip = Path(temporary) / name
        with zipfile.ZipFile(temporary_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
            for p in sorted(stage.rglob('*')):
                if p.is_file():
                    info = zipfile.ZipInfo(p.relative_to(stage.parent).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o100644 << 16
                    archive.writestr(info, p.read_bytes())
        target = output / name
        shutil.copyfile(temporary_zip, target)
        with zipfile.ZipFile(target) as archive:
            if archive.testzip() is not None:
                raise ValueError('Corrupt ZIP')
            for relative, expected in hashes.items():
                if digest(archive.read('ThreadsCollector/' + relative)) != expected:
                    raise ValueError(f'Payload mismatch: {relative}')
        checksum = f'{digest(target.read_bytes())}  {name}\n'
        (output / (name + '.sha256')).write_text(checksum, encoding='utf-8')
        print(json.dumps({'file': str(target), 'version': version, 'files': len(hashes) + 1,
                          'bytes': target.stat().st_size, 'sha256': checksum.split()[0]}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'out/collector-distribution')
    build(parser.parse_args().output.resolve())
