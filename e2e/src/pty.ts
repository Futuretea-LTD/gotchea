import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Node has no pseudo-terminal API, and `gotchea quiz` refuses to run without a TTY, so Python's
// `pty` module hosts the real CLI. Ctrl-C at the first prompt makes the CLI abandon the quiz, so
// everything captured was printed before any answer was recorded.
const driver = String.raw`
import os, pty, select, signal, struct, sys, time, fcntl, termios
trigger, timeout, argv = sys.argv[1].encode(), float(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    # Wide enough that option lines never wrap, so they can be matched line by line.
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 400, 0, 0))
    os.execvp(argv[0], argv)
out, sent, deadline = b'', False, time.time() + timeout
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if not sent and trigger in out:
        time.sleep(0.3)
        os.write(fd, b'\x03')
        sent = True
else:
    os.kill(pid, signal.SIGKILL)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.stderr.write('exit=%d sent=%d\n' % (os.waitstatus_to_exitcode(status), sent))
`;

/** True when a Python 3 with `pty` is available (macOS and Linux CI images). */
export function ptyAvailable(): boolean {
  if (process.platform === 'win32') return false;
  return spawnSync('python3', ['-c', 'import pty, termios'], { stdio: 'ignore' }).status === 0;
}

/**
 * Runs `argv` in a pseudo-terminal, presses Ctrl-C once `trigger` appears and returns the
 * terminal output with ANSI control sequences removed (`text`) and as written (`raw`).
 */
export async function runInPty(argv: string[], options: { cwd: string; env: Record<string, string>; trigger: string; timeoutSeconds?: number }) {
  const { stdout, stderr } = await exec('python3', ['-c', driver, options.trigger, String(options.timeoutSeconds ?? 60), ...argv], {
    cwd: options.cwd, env: options.env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences
  const text = stdout.replace(/\u001b\][^\u0007]*\u0007|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\r/g, '');
  return { text, raw: stdout, triggered: /sent=1/.test(stderr), status: stderr.trim() };
}
