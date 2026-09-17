#!/usr/bin/env python3
"""Update the current user's native Codex and Claude installs, without a shell."""

import fcntl
import os
from pathlib import Path
import selectors
import re
import signal
import stat
import subprocess
import sys
import time

OUTPUT_LIMIT = 64 * 1024
VERSION_TIMEOUT = 15
UPDATE_TIMEOUT = 300
NATIVE_ROOTS = {
    "codex": ".codex/packages/standalone",
    "claude": ".local/share/claude/versions",
}


def native_binary(home, provider):
    launcher = home / ".local/bin" / provider
    target = launcher.resolve(strict=True)
    root = (home / NATIVE_ROOTS[provider]).resolve(strict=True)
    if not target.is_relative_to(root) or not stat.S_ISREG(target.stat().st_mode):
        raise ValueError(f"{provider}: expected a native installation under {root}")
    if not os.access(target, os.X_OK):
        raise ValueError(f"{provider}: native binary is not executable")
    return launcher


def run_command(binary, argument, home, timeout):
    # No runner.env, authentication tokens, npm configuration, or shell startup files.
    env = {
        "HOME": str(home),
        "PATH": f"{home}/.local/bin:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
    }
    process = subprocess.Popen(
        [str(binary), argument], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=home, env=env,
        start_new_session=True,
    )
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(f"{binary.name} {argument}: timed out")
                for key, _ in selector.select(min(remaining, 0.2)):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fd)
                    else:
                        output.extend(chunk)
                        if len(output) > OUTPUT_LIMIT:
                            raise RuntimeError(f"{binary.name} {argument}: output exceeded 64 KiB")
            remaining = deadline - time.monotonic()
            try:
                code = process.wait(timeout=max(0, remaining))
            except subprocess.TimeoutExpired as error:
                raise RuntimeError(f"{binary.name} {argument}: timed out") from error
        if code:
            # Provider output may contain sensitive diagnostics; do not journal it.
            raise RuntimeError(f"{binary.name} {argument}: exited {code}")
        return bytes(output).decode("utf-8", errors="replace").strip()
    finally:
        # Also clean up descendants that retained the output pipe after parent exit.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()


def version_tuple(provider, banner):
    prefix = r"codex-cli " if provider == "codex" else ""
    suffix = "" if provider == "codex" else r" \(Claude Code\)"
    match = re.fullmatch(prefix + r"(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[A-Za-z0-9.-]{1,64})?" + suffix, banner)
    if match is None:
        raise ValueError(f"{provider}: unexpected version banner")
    return tuple(int(part) for part in match.groups())


def update_provider(home, provider):
    binary = native_binary(home, provider)
    before = run_command(binary, "--version", home, VERSION_TIMEOUT)
    before_version = version_tuple(provider, before)
    # Validate again before the mutation, and after the vendor swaps its symlink.
    binary = native_binary(home, provider)
    run_command(binary, "update", home, UPDATE_TIMEOUT)
    binary = native_binary(home, provider)
    after = run_command(binary, "--version", home, VERSION_TIMEOUT)
    after_version = version_tuple(provider, after)
    if after_version < before_version:
        raise ValueError(f"{provider}: version decreased after update")
    # repr escapes control characters; cap version strings independently of pipe limit.
    print(f"{provider}: {before[:160]!r} -> {after[:160]!r}", flush=True)


def update_all(home):
    failed = False
    for provider in NATIVE_ROOTS:
        try:
            update_provider(home, provider)
        except (OSError, ValueError, RuntimeError) as error:
            failed = True
            print(f"{provider}: update failed: {error}", file=sys.stderr, flush=True)
    return 1 if failed else 0


def main():
    home = Path.home()
    lock_directory = home / ".local/state/codevo-provider-updates"
    lock_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (lock_directory / "update.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another provider update is already running.", file=sys.stderr)
            return 1
        return update_all(home)


if __name__ == "__main__":
    sys.exit(main())
