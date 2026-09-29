"""Prepare the app-owned CLI before Mac development starts; no global installation."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ('bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg',
            'codex-resources/zsh/bin/zsh', 'codex-package.json',
            'LICENSE', 'NOTICE', 'codex-path/ripgrep.LICENSE-MIT')


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def unpack(archive_path, destination, target):
    prefix = PurePosixPath('package/vendor') / target
    with tarfile.open(archive_path, 'r:gz') as archive:
        seen = set()
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name:
                raise RuntimeError('Unsafe Codex package path')
            if not path.is_relative_to(prefix):
                continue
            relative = path.relative_to(prefix)
            if not member.isfile() or not relative.parts or relative in seen:
                raise RuntimeError('Unexpected Codex package entry')
            seen.add(relative)
            output = destination.joinpath(*relative.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, output.open('wb') as file:
                shutil.copyfileobj(source, file)
            # Preserve executability without setuid/setgid bits from the archive.
            output.chmod(0o755 if member.mode & 0o111 else 0o644)


def verify_layout(destination, version, target):
    expected = {'layoutVersion': 1, 'version': version, 'target': target,
                'variant': 'codex', 'entrypoint': 'bin/codex',
                'resourcesDir': 'codex-resources', 'pathDir': 'codex-path'}
    if json.loads((destination / 'codex-package.json').read_text()) != expected:
        raise RuntimeError('Unexpected Codex package metadata')
    for relative in REQUIRED:
        file = destination / relative
        if file.is_symlink() or not file.is_file():
            raise RuntimeError('Missing Codex dependency: ' + relative)
        if relative.startswith('bin/') or relative.endswith(('/rg', '/zsh')):
            if not file.stat().st_mode & 0o111:
                raise RuntimeError('Codex dependency is not executable: ' + relative)


def inventory(destination):
    return [{'path': p.relative_to(destination).as_posix(), 'sha256': digest(p),
             'executable': bool(p.stat().st_mode & 0o111)}
            for p in sorted(destination.rglob('*'))
            if p.is_file() and p.name != 'runtime-files.json']


def verified_cache(destination, fingerprint, version, target):
    try:
        if destination.is_symlink() or any(p.is_symlink() for p in destination.rglob('*')):
            return False
        verify_layout(destination, version, target)
        return json.loads((destination / 'runtime-files.json').read_text()) == {
            'fingerprint': fingerprint, 'files': inventory(destination)}
    except (OSError, ValueError, RuntimeError):
        return False


def download(item, cache):
    path = cache / item['name']
    if not path.is_file() or digest(path) != item['sha256']:
        request = urllib.request.Request(item['url'], headers={'User-Agent': 'ThreadsMediaManager-build'})
        with urllib.request.urlopen(request, timeout=120) as response, path.open('wb') as file:
            shutil.copyfileobj(response, file)
    if digest(path) != item['sha256']:
        raise RuntimeError('Runtime checksum mismatch: ' + item['name'])
    return path


def prepare(arch):
    manifest = json.loads((ROOT / 'scripts/macos-codex.json').read_text())
    windows = json.loads((ROOT / 'scripts/windows-runtime.json').read_text())
    if arch not in manifest['platforms'] or manifest['version'] != windows['codexVersion']:
        raise RuntimeError('Unsupported Mac architecture or inconsistent Codex version')
    asset = manifest['platforms'][arch]
    licenses = [item for item in windows['downloads']
                if item['name'] in ('codex.LICENSE', 'codex.NOTICE', 'ripgrep.LICENSE-MIT')]
    fingerprint = hashlib.sha256(json.dumps([manifest['version'], asset, licenses], sort_keys=True).encode()).hexdigest()
    output = ROOT / 'build/codex' / ('darwin-' + arch)
    if verified_cache(output, fingerprint, manifest['version'], asset['target']):
        return
    cache = ROOT / 'build/downloads'
    cache.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    archive = download({**asset, 'name': 'codex-darwin-' + arch + '-' + manifest['version'] + '.tgz'}, cache)
    with tempfile.TemporaryDirectory(prefix='codex-prepare-', dir=output.parent) as directory:
        prepared = Path(directory) / 'runtime'
        prepared.mkdir()
        unpack(archive, prepared, asset['target'])
        for item in licenses:
            relative = ('codex-path/' + item['name'] if item['name'].startswith('ripgrep.')
                        else item['name'].removeprefix('codex.'))
            shutil.copyfile(download(item, cache), prepared / relative)
        verify_layout(prepared, manifest['version'], asset['target'])
        (prepared / 'runtime-files.json').write_text(json.dumps({
            'fingerprint': fingerprint, 'files': inventory(prepared)}, indent=2) + '\n')
        # This directory contains only generated app runtime files, never credentials.
        if output.exists():
            shutil.rmtree(output)
        prepared.rename(output)
    print('Prepared app-owned Codex CLI ' + manifest['version'] + ' for Mac ' + arch)


if __name__ == '__main__':
    if sys.platform != 'darwin' or len(sys.argv) != 2:
        raise SystemExit('Mac development only: provide the Electron architecture.')
    prepare(sys.argv[1])
