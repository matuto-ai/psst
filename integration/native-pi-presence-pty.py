"""Owned, disposable official Pi PTY. JSON control is separate from terminal data.

Only the test driver writes lifecycle commands. Peer delivery never types into the
terminal. All paths/configuration belong to the fresh fixture supplied by parent.
"""
import json, os, pathlib, pty, select, signal, subprocess, sys, time

control = json.loads(pathlib.Path(sys.argv[1]).read_text())
master, slave = pty.openpty()
env = {
    'PATH': os.environ['PATH'], 'HOME': control['home'],
    'PI_CODING_AGENT_DIR': control['agent'], 'PI_OFFLINE': '1',
    'TERM': 'xterm-256color', 'NODE_EXTRA_CA_CERTS': control['cert'],
    'PSST_NAME': control['label'], 'PSST_PI_HOST': control['host'],
    'PSST_PI_OBSERVATIONS': control['observations'],
}
args = [control['node'], control['cli'], '--offline', '--no-extensions', '--no-mcp',
        '--no-skills', '--no-context-files', '--no-approve', '--no-prompt-templates',
        '--no-themes', '--no-tools', '--provider', 'faux', '--model', 'faux-1',
        '--name', control['label'], '-e', control['observer'], '-e', control['extension']]
if control.get('session'):
    args.extend(['--session', control['session']])
proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env,
                        cwd=control['project'], start_new_session=True)
os.close(slave)
terminal = bytearray()
exited = False

def emit(value):
    print(json.dumps(value), flush=True)

def kill_group(sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass

def cleanup():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    # The owned group can outlive its leader. Never limit cleanup to poll()==None.
    kill_group(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        kill_group(signal.SIGKILL)
        proc.wait(timeout=5)
    kill_group(signal.SIGKILL)

def terminate(*_):
    # Repeated cancellation cannot interrupt the finally block's owned cleanup.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    raise InterruptedError()

signal.signal(signal.SIGTERM, terminate)
try:
    emit({'ready': True, 'pid': proc.pid})
    while True:
        readers = [sys.stdin] + ([] if exited else [master])
        readable, _, _ = select.select(readers, [], [], .05)
        if master in readable:
            try:
                terminal.extend(os.read(master, 65536))
                if len(terminal) > 2 * 1024 * 1024:
                    raise RuntimeError('bounded native terminal capture exceeded')
            except OSError:
                pass
        if not exited and proc.poll() is not None:
            exited = True
            emit({'exited': True, 'code': proc.returncode})
        if sys.stdin in readable:
            line = sys.stdin.readline()
            if not line:
                break
            frame = json.loads(line)
            operation = frame['operation']
            if operation == 'write':
                if proc.poll() is not None:
                    raise RuntimeError('native process already exited')
                os.write(master, frame['text'].encode())
                value = True
            elif operation == 'signal':
                selected = {'SIGTERM': signal.SIGTERM, 'SIGKILL': signal.SIGKILL}[frame['signal']]
                kill_group(selected)
                value = True
            elif operation == 'status':
                value = {'live': proc.poll() is None, 'code': proc.returncode}
            elif operation == 'close':
                cleanup()
                emit({'id': frame['id'], 'value': {'live': False, 'code': proc.returncode}})
                break
            else:
                raise RuntimeError('unknown fixture operation')
            emit({'id': frame['id'], 'value': value})
finally:
    cleanup()
    # Private raw output is diagnostic only; never upload it as sanitized evidence.
    pathlib.Path(control['terminal']).write_bytes(terminal)
    os.close(master)
