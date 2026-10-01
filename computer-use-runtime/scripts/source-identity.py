"""Fingerprint maintained executable code, configuration and protected requirements."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

DIRECTORIES = ['src', 'console', 'tests', 'scripts', 'evaluation', 'native/src', 'native/unix', 'learner', 'sdk', 'examples', 'fixtures']
CONFIGURATION = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.console.json', 'vite.config.ts', '.prettierrc.json', '.prettierignore', '.gitattributes', 'native/Cargo.toml', 'native/Cargo.lock', 'REQUEST.md', 'acceptance.json']

def source_identity(root):
    root = Path(root).resolve()
    paths = set()
    for directory in DIRECTORIES:
        paths.update(path for path in (root / directory).rglob('*') if path.is_file() and '__pycache__' not in path.parts and path.suffix in ['.ts', '.vue', '.css', '.html', '.py', '.sh', '.ps1', '.rs', '.txt', '.json', '.toml', '.yaml', '.yml'])
    paths.update(root / name for name in CONFIGURATION if (root / name).is_file())
    paths.update(path for path in (root / 'docs/completion-contract-v1').glob('*') if path.is_file())
    digest = hashlib.sha256()
    files = []
    for path in sorted(paths, key=lambda p: p.relative_to(root).as_posix()):
        name = path.relative_to(root).as_posix()
        data = path.read_bytes()
        content_hash = hashlib.sha256(data).hexdigest()
        digest.update(name.encode() + b'\0' + content_hash.encode() + b'\n')
        files.append({'path': name, 'sha256': content_hash})
    source_hash = digest.hexdigest()
    try:
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True, stderr=subprocess.PIPE).strip()
        origin = 'git'
    except (OSError, subprocess.CalledProcessError) as error:
        try:
            manifest = json.loads((root / 'RELEASE_MANIFEST.json').read_text(encoding='utf-8'))
            released = manifest['sourceIdentity']
            if (not isinstance(released, dict)
                    or not re.fullmatch(r'[0-9a-f]{40}', str(released.get('head', '')))
                    or not re.fullmatch(r'[0-9a-f]{64}', str(released.get('sha256', '')))
                    or released['sha256'] != source_hash):
                raise ValueError('Maintained bytes do not match the released source identity')
            head, origin = released['head'], 'release-manifest'
        except (OSError, ValueError, KeyError, TypeError) as invalid:
            raise RuntimeError('No Git revision or byte-matching release source identity is available') from invalid
    return {'head': head, 'headOrigin': origin, 'sha256': source_hash, 'files': files}

if __name__ == '__main__':
    print(json.dumps(source_identity(Path(__file__).resolve().parent.parent), indent=2))
