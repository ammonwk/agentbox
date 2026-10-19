#!/usr/bin/python3
"""Stop a tmux pane's cgroup when the agent it belongs to exits."""
import os
import json
from pathlib import Path
import re
import selectors
import subprocess
import sys


def start(pid):
    return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]


def watch(pid, born, scope, dependencies):
    if not re.fullmatch(r'(?:tmux-spawn|agentbox-command)-[a-f0-9-]+\.scope', scope):
        raise ValueError('not an agent-owned scope')
    descriptors = []
    try:
        with selectors.DefaultSelector() as events:
            for owner in [{'pid': pid, 'start': born}, *dependencies]:
                fd = os.pidfd_open(owner['pid'])
                descriptors.append(fd)
                if start(owner['pid']) != owner['start']:
                    return
                events.register(fd, selectors.EVENT_READ)
            events.select()
    except (ProcessLookupError, FileNotFoundError):
        pass
    finally:
        for fd in descriptors:
            os.close(fd)


def arm(pid, dependencies=()):
    scope = Path(f'/proc/{pid}/cgroup').read_text().strip().split('/')[-1]
    if not re.fullmatch(r'(?:tmux-spawn|agentbox-command)-[a-f0-9-]+\.scope', scope):
        raise RuntimeError(f'agent did not start in a tmux pane scope: {scope}')
    born = start(pid)
    env = dict(os.environ, XDG_RUNTIME_DIR=f'/run/user/{os.getuid()}')
    subprocess.run(['systemd-run', '--user', '--quiet', '--collect', '--service-type=exec',
                    '--unit=' + f'agentbox-owner-{pid}-{born}',
                    '--property=BindsTo=' + scope, '--property=After=' + scope,
                    '--property=ExecStopPost=/usr/bin/systemctl --user --no-block stop ' + scope,
                    '/usr/bin/python3', str(Path(__file__).resolve()), 'watch', str(pid), born, scope,
                    json.dumps([owner for owner in dependencies if owner['pid'] != pid])],
                   env=env, check=True)
    return scope


def launch(argv):
    arm(os.getpid())
    os.execvpe(argv[0], argv, os.environ)


if __name__ == '__main__':
    if sys.argv[1] == 'watch':
        watch(int(sys.argv[2]), sys.argv[3], sys.argv[4], json.loads(sys.argv[5]) if len(sys.argv) > 5 else [])
    elif sys.argv[1] == 'arm':
        print(arm(int(sys.argv[2])))
    elif sys.argv[1] == 'launch':
        launch(sys.argv[2:])
    else:
        raise ValueError('expected launch or watch')
