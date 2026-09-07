"""Trusted file operations run only inside a conversation's Docker sandbox."""
import json, os, pathlib, subprocess, sys, base64, uuid, difflib, tempfile, resource, time
ROOT = pathlib.Path('/workspace/repo')
STORE = pathlib.Path('/workspace/.nixre-checkpoints')
MAX_BYTES = 20 * 1024 * 1024
MAX_FILES = 2000

def safe(name):
    p = pathlib.PurePosixPath(name)
    if not name or p.is_absolute() or '\\' in name or any(x in ('', '.', '..', '.git') for x in name.split('/')):
        raise ValueError('Invalid workspace path')
    dest = ROOT
    for part in p.parts:
        dest = dest / part
        if dest.is_symlink():
            raise ValueError('Symlink paths are not supported')
    return dest

def read(name):
    p = safe(name)
    if not p.exists(): return None
    if not p.is_file() or p.stat().st_size > 49152: raise ValueError('File exceeds the 48 KiB review limit')
    return p.read_text()

def files():
    data = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    names = sorted(set(x.decode() for x in data.split(b'\0') if x))
    if len(names) > MAX_FILES: raise ValueError('Checkpoint exceeds 2000 files')
    return names

def checkpoint():
    snapshot, total = {}, 0
    for name in files():
        p = safe(name)
        if not p.exists(): continue
        if not p.is_file(): raise ValueError('Only regular files are supported in checkpoints')
        size = p.stat().st_size
        total += size
        if total > MAX_BYTES: raise ValueError('Checkpoint exceeds 20 MiB')
        snapshot[name] = {'data': base64.b64encode(p.read_bytes()).decode(), 'mode': p.stat().st_mode & 0o777}
    STORE.mkdir(exist_ok=True)
    if STORE.is_symlink(): raise ValueError('Invalid checkpoint directory')
    ident = uuid.uuid4().hex
    (STORE / (ident + '.json')).write_text(json.dumps(snapshot))
    for old in sorted(STORE.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)[20:]:
        if not old.is_symlink(): old.unlink()
    return {'id': ident, 'files': len(snapshot), 'bytes': total}

def run(a):
    op = a['op']
    if op == 'read':
        content = read(a['path'])
        patch = ''.join(difflib.unified_diff((content or '').splitlines(True), a.get('proposed', '').splitlines(True), fromfile='before/' + a['path'], tofile='after/' + a['path']))
        return {'content': content, 'patch': patch}
    if op == 'list': return {'files': files()}
    if op == 'search':
        query = str(a['query'])
        if not query or len(query) > 256: raise ValueError('Invalid search query')
        with tempfile.TemporaryFile() as log:
            result = subprocess.run(['git', '-C', str(ROOT), 'grep', '-n', '-I', '-E', '--untracked', '-e', query], stdout=log, stderr=subprocess.DEVNULL, timeout=15, preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (1048576, 1048576)))
            log.seek(0)
            matches = log.read(1048576).decode(errors='replace').splitlines()
        if result.returncode not in (0, 1): raise ValueError('Search failed or exceeded output limit')
        return {'matches': matches}
    if op == 'checkpoint': return checkpoint()
    if op == 'apply':
        if read(a['path']) != a['before']: raise ValueError('File changed since review; request a fresh proposal')
        dest = safe(a['path'])
        checkpoint_result = checkpoint()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(a['content'])
        return {'checkpoint': checkpoint_result, 'path': a['path']}
    if op == 'restore':
        ident = a['id']
        if len(ident) != 32 or any(c not in '0123456789abcdef' for c in ident): raise ValueError('Invalid checkpoint')
        saved = STORE / (ident + '.json')
        if STORE.is_symlink() or saved.is_symlink(): raise ValueError('Invalid checkpoint path')
        snapshot = json.loads(saved.read_text())
        current = files()
        # Validate every path before modifying any file; never rewrite git history/index.
        for name in set(current) | set(snapshot): safe(name)
        backup = checkpoint()
        for name in current:
            p = safe(name)
            if name not in snapshot and p.is_file(): p.unlink()
        for name, entry in snapshot.items():
            p = safe(name)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(base64.b64decode(entry['data']))
            p.chmod(entry['mode'])
        return {'restored': ident, 'checkpoint': backup}
    if op == 'checks':
        checks = []
        # Bounded discovery of root and common package directories.
        for folder in ['', 'backend', 'ui', 'frontend', 'server', 'client']:
            name = (folder + '/' if folder else '') + 'package.json'
            p = safe(name)
            if not p.exists(): continue
            scripts = json.loads(p.read_text()).get('scripts', {})
            for script in ['test', 'lint', 'build']:
                if script in scripts:
                    checks.append({'label': name + ': ' + script, 'cwd': folder, 'argv': ['npm', 'run', script]})
        if safe('pytest.ini').exists() or safe('pyproject.toml').exists():
            checks.append({'label': 'Python tests', 'cwd': '', 'argv': ['python3', '-m', 'pytest', '-q']})
        return {'checks': checks}
    if op == 'verify':
        results = []
        deadline = time.monotonic() + 600
        for check in run({'op': 'checks'})['checks']:
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    results.append({'label': check['label'], 'exitCode': 124, 'output': 'Skipped: verification reached its 10 minute limit'})
                    continue
                with tempfile.TemporaryFile() as log:
                    result = subprocess.run(check['argv'], cwd=ROOT / check['cwd'], stdout=log, stderr=log, timeout=min(120, remaining), preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (1048576, 1048576)))
                    log.seek(max(0, log.tell() - 12000))
                    output = log.read().decode(errors='replace')
                results.append({'label': check['label'], 'exitCode': result.returncode, 'output': output})
            except subprocess.TimeoutExpired:
                results.append({'label': check['label'], 'exitCode': 124, 'output': 'Timed out after 120 seconds'})
        return {'results': results}
    raise ValueError('Unknown workspace operation')

try:
    print(json.dumps(run(json.load(sys.stdin))))
except Exception as error:
    print(json.dumps({'error': str(error)}))
    sys.exit(1)
