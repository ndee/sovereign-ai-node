#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
from collections.abc import Sequence
from dataclasses import dataclass


ANSI_ESCAPE_RE = re.compile(rb"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


@dataclass(frozen=True)
class PromptStep:
    name: str
    pattern: str
    response: bytes


PROMPT_STEPS: tuple[PromptStep, ...] = (
    PromptStep("action", "Choose an action:", b"\r"),
    PromptStep("openrouter_model", "OpenRouter model [", b"\r"),
    PromptStep("openrouter_api_key", "OpenRouter API key (sk-or-...):", b"sk-ci-fake-key-not-used\r"),
    PromptStep("connectivity_mode", "Choose how users should connect:", b"2\r"),
    PromptStep("matrix_domain", "Matrix homeserver domain", b"ci.local.test\r"),
    PromptStep("matrix_public_base_url", "Matrix public base URL", b"http://127.0.0.1:8008\r"),
    PromptStep("operator_username", "Operator username", b"\r"),
    PromptStep("alert_room_name", "Alert room name", b"\r"),
    PromptStep("matrix_federation", "Enable Matrix federation?", b"\r"),
    # Accept the default bot selection (mail-sentinel and any other
    # defaultInstall: true entries) rather than opting into every bot with
    # "a". The "all" path pulls in bots that rely on a bot-instance record
    # the installer only creates for defaultInstall bots (mail-sentinel has
    # a legacy-synthesis carve-out at resolveRequestedBotInstances), so
    # selecting a non-default bot through interactive currently trips
    # BOT_BINDING_RESOLUTION_FAILED in openclaw_configure. Interactive CI
    # already asserts prompts and flow; exercising every bundled bot isn't
    # the value this job is providing. If we want coverage for non-default
    # bots it belongs in a dedicated job with the right stubs.
    PromptStep("bot_selection", "Choose bots to install", b"\r"),
    PromptStep("mail_sentinel_poll_interval", "Mail Sentinel poll interval", b"\r"),
    PromptStep("mail_sentinel_lookback_window", "Mail Sentinel lookback window", b"\r"),
    PromptStep("imap_configure", "Configure IMAP now? (choose no to keep IMAP pending)", b"\r"),
    PromptStep("write_request", "Write the request file and continue?", b"\r"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Drive the installer wizard through a PTY for CI interactive coverage.",
    )
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--bots-source-dir", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--idle-timeout-seconds", type=int, default=180)
    parser.add_argument("--overall-timeout-seconds", type=int, default=1800)
    return parser.parse_args()


def strip_ansi(data: bytes) -> str:
    sanitized = ANSI_ESCAPE_RE.sub(b"", data).replace(b"\r", b"\n")
    return sanitized.decode("utf-8", errors="replace")


def set_pty_size(fd: int, rows: int = 40, columns: int = 120) -> None:
    size = struct.pack("HHHH", rows, columns, 0, 0)
    termios.tcsetwinsize(fd, (rows, columns))
    try:
        import fcntl

        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def terminate_process_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if poll_child(pid) is not None:
            return
        time.sleep(0.2)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        return


def poll_child(pid: int) -> int | None:
    waited_pid, status = os.waitpid(pid, os.WNOHANG)
    if waited_pid == 0:
        return None
    return os.waitstatus_to_exitcode(status)


def format_tail(value: str, max_chars: int = 4000) -> str:
    if len(value) <= max_chars:
        return value
    return value[-max_chars:]


def spawn_installer(
    command: Sequence[str],
    transcript_path: str,
    idle_timeout_seconds: int,
    overall_timeout_seconds: int,
) -> int:
    pid, master_fd = pty.fork()
    if pid == 0:
        os.execvpe(command[0], list(command), os.environ)
    set_pty_size(master_fd)

    transcript_dir = os.path.dirname(transcript_path)
    if transcript_dir:
        os.makedirs(transcript_dir, exist_ok=True)

    prompt_index = 0
    seen_output = ""
    start_time = time.monotonic()
    last_output_at = start_time

    with open(transcript_path, "wb") as transcript:
        try:
            while True:
                exit_code = poll_child(pid)
                if exit_code is not None:
                    try:
                        chunk = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    transcript.write(chunk)
                    transcript.flush()
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                    continue

                now = time.monotonic()
                if now - start_time > overall_timeout_seconds:
                    raise TimeoutError("interactive installer exceeded the overall timeout")
                if now - last_output_at > idle_timeout_seconds:
                    raise TimeoutError("interactive installer stopped producing output")

                ready, _, _ = select.select([master_fd], [], [], 1.0)
                if not ready:
                    continue

                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    break
                if not chunk:
                    continue

                transcript.write(chunk)
                transcript.flush()

                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()

                last_output_at = time.monotonic()
                seen_output = format_tail(seen_output + strip_ansi(chunk), max_chars=20_000)

                while prompt_index < len(PROMPT_STEPS):
                    step = PROMPT_STEPS[prompt_index]
                    if step.pattern not in seen_output:
                        break
                    os.write(master_fd, step.response)
                    print(f"\n[interactive-driver] responded to {step.name}", flush=True)
                    prompt_index += 1
                    if prompt_index == len(PROMPT_STEPS):
                        seen_output = ""
                    break
        except Exception:
            terminate_process_group(pid)
            raise
        finally:
            try:
                os.close(master_fd)
            except OSError:
                pass

    exit_code = poll_child(pid)
    if exit_code is None:
        terminate_process_group(pid)
        exit_code = poll_child(pid)
    return 1 if exit_code is None else exit_code


if __name__ == "__main__":
    args = parse_args()
    command = (
        "sudo",
        "env",
        f"PATH={os.environ.get('PATH', '')}",
        "bash",
        "scripts/install.sh",
        "--source-dir",
        args.source_dir,
        "--bots-source-dir",
        args.bots_source_dir,
    )

    try:
        exit_code = spawn_installer(
            command,
            args.transcript,
            idle_timeout_seconds=args.idle_timeout_seconds,
            overall_timeout_seconds=args.overall_timeout_seconds,
        )
    except TimeoutError as error:
        print(f"\n[interactive-driver] {error}", file=sys.stderr)
        raise SystemExit(1) from error
    except Exception as error:  # pragma: no cover - exercised via CI
        print(f"\n[interactive-driver] {error}", file=sys.stderr)
        raise SystemExit(1) from error

    raise SystemExit(exit_code)
