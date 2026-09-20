#!/usr/bin/env python3
"""One-command start for research mode. No Docker, no database server.

    python3 start.py          (macOS / Linux)
    py start.py               (Windows)

Sets up everything in a local folder, starts both servers and opens the
browser. Uses a SQLite file instead of PostgreSQL and needs no Redis, so
nothing has to be installed beyond Python and Node.

Research mode is forced on: the system analyses real products but cannot
list, buy or ship anything. See docs/research-mode.md.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import platform
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = ROOT / ".venv"
DB_PATH = ROOT / "arbitrage.sqlite3"
CREDENTIALS_FILE = ROOT / ".research-login.txt"
ENV_FILE = ROOT / ".env"

#: The only settings this launcher takes from .env. Everything else it decides
#: itself - a DATABASE_URL or a RESEARCH_MODE picked up by accident would
#: silently change what this install is allowed to do.
ENV_PASSTHROUGH = (
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_ENVIRONMENT",
    "EBAY_MARKETPLACE",
    "AMAZON_MARKETPLACE",
)

BACKEND_PORT = 8000
FRONTEND_PORT = 3000
IS_WINDOWS = platform.system() == "Windows"

GREEN, YELLOW, RED, DIM, BOLD, RESET = (
    ("\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m")
    if not IS_WINDOWS or os.environ.get("WT_SESSION")
    else ("", "", "", "", "", "")
)


def say(message: str) -> None:
    print(f"{message}", flush=True)


def step(number: int, total: int, message: str) -> None:
    print(f"\n{BOLD}[{number}/{total}]{RESET} {message}", flush=True)


def fail(message: str, remedy: str = "") -> None:
    print(f"\n{RED}Stopped:{RESET} {message}", file=sys.stderr)
    if remedy:
        print(f"\n{remedy}\n", file=sys.stderr)
    sys.exit(1)


def venv_bin(name: str) -> Path:
    folder = VENV / ("Scripts" if IS_WINDOWS else "bin")
    return folder / (f"{name}.exe" if IS_WINDOWS else name)


def run(command: list[str], *, cwd: Path, quiet: bool = True, env: dict | None = None) -> None:
    result = subprocess.run(  # noqa: S603 - fixed command lists, no shell
        command,
        cwd=cwd,
        check=False,
        env={**os.environ, **(env or {})},
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.PIPE if quiet else None,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or "").strip()
        fail(
            f"`{' '.join(command[:3])} ...` failed",
            detail[-1500:] if detail else "Re-run with the output shown to see why.",
        )


def check_prerequisites() -> None:
    # Deliberately kept: this script must still run on an older interpreter in
    # order to tell the user which version they need. noqa: UP036
    if sys.version_info < (3, 11):  # noqa: UP036
        fail(
            f"Python 3.11 or newer is required (you have {sys.version.split()[0]}).",
            "Install it from https://www.python.org/downloads/ and run this again.",
        )
    if shutil.which("node") is None:
        fail(
            "Node.js is not installed. The web interface needs it.",
            "Install the LTS version from https://nodejs.org/ (take the default\n"
            "options), close and reopen your terminal, then run this again.",
        )
    version = subprocess.run(
        ["node", "--version"], capture_output=True, text=True, check=False
    ).stdout.strip()
    try:
        major = int(version.lstrip("v").split(".")[0])
    except (ValueError, IndexError):
        major = 0
    if major < 20:
        fail(
            f"Node.js 20 or newer is required (you have {version}).",
            "Install the LTS version from https://nodejs.org/ and run this again.",
        )
    say(f"  {GREEN}ok{RESET} Python {sys.version.split()[0]}, Node {version}")


def ensure_backend() -> None:
    if not venv_bin("python").exists():
        say("  creating a private Python environment (one-off)")
        run([sys.executable, "-m", "venv", str(VENV)], cwd=ROOT)
    say("  installing backend packages (one-off, can take a minute)")
    run(
        [str(venv_bin("python")), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
        cwd=ROOT,
    )
    run(
        [
            str(venv_bin("python")), "-m", "pip", "install", "--quiet",
            "-r", str(BACKEND / "requirements.txt"),
        ],
        cwd=ROOT,
    )
    say(f"  {GREEN}ok{RESET} backend ready")


def ensure_frontend() -> None:
    if not (FRONTEND / "node_modules").exists():
        say("  installing web interface packages (one-off, can take 2-3 minutes)")
        run(["npm", "install", "--no-audit", "--no-fund"], cwd=FRONTEND)
    say("  building the web interface (can take a minute)")
    run(
        ["npm", "run", "build"],
        cwd=FRONTEND,
        env={"NEXT_PUBLIC_API_BASE_URL": f"http://127.0.0.1:{BACKEND_PORT}"},
    )
    say(f"  {GREEN}ok{RESET} web interface ready")


def marketplace_keys() -> dict[str, str]:
    """Read-only marketplace credentials from .env, if there are any.

    Two eBay application keys turn the eBay side from "type what you see" into
    real listings with real item numbers. They grant public read access and
    nothing more, which is why research mode accepts them.
    """
    if not ENV_FILE.exists():
        return {}
    found: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        value = value.strip().strip("\"'")
        if name in ENV_PASSTHROUGH and value:
            found[name] = value
    # One key without the other cannot authenticate, and half-configured is
    # the state most likely to look like a bug. Take both or neither.
    if bool(found.get("EBAY_CLIENT_ID")) != bool(found.get("EBAY_CLIENT_SECRET")):
        found.pop("EBAY_CLIENT_ID", None)
        found.pop("EBAY_CLIENT_SECRET", None)
    return found


def ensure_database_matches_the_code() -> None:
    """Rebuild the local database when an update added a column to it.

    The local install creates any table it is missing, but it cannot add a
    column to a table that already exists - so a database made by an older
    version fails on the first query that reads a new one. Rather than leave
    that as a crash to decode, the mismatch is detected here.

    Rebuilding is safe *because of what this file holds*: prices you typed and
    the analyses derived from them, every one re-enterable and none of it
    money. The old file is moved aside rather than deleted, so nothing is
    lost even so.
    """
    if not DB_PATH.exists():
        return

    import sqlite3

    # Each entry is a table and a column that a release added to it. A
    # database missing any of them predates that release.
    expected = {"profit_calculations": "net_vat"}
    missing = []
    try:
        with sqlite3.connect(DB_PATH) as db:
            for table, column in expected.items():
                rows = db.execute(f"PRAGMA table_info({table})").fetchall()
                if not rows:
                    continue  # the table is absent; it will be created
                if column not in {row[1] for row in rows}:
                    missing.append(f"{table}.{column}")
    except sqlite3.DatabaseError:
        missing.append("unreadable")

    if not missing:
        return

    backup = DB_PATH.with_suffix(".sqlite3.old")
    backup.unlink(missing_ok=True)
    DB_PATH.rename(backup)
    say(
        f"  {YELLOW}note{RESET} your database was made by an older version "
        f"(no {', '.join(missing)})."
    )
    say(f"  starting a fresh one. The old file is kept as {backup.name}.")


# ---------------------------------------------------------------------------
# Connecting eBay
# ---------------------------------------------------------------------------
def write_env(values: dict[str, str]) -> None:
    """Merge settings into .env, leaving anything already there alone."""
    lines: list[str] = []
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()

    remaining = dict(values)
    out: list[str] = []
    for line in lines:
        name = line.split("=", 1)[0].strip() if "=" in line else ""
        if name in remaining:
            out.append(f"{name}={remaining.pop(name)}")
        else:
            out.append(line)
    if out and out[-1].strip():
        out.append("")
    out.extend(f"{name}={value}" for name, value in remaining.items())

    ENV_FILE.write_text("\n".join(out).rstrip("\n") + "\n", encoding="utf-8")
    if not IS_WINDOWS:
        # It holds a secret; nobody else on this machine needs to read it.
        ENV_FILE.chmod(0o600)


def check_ebay(client_id: str, client_secret: str, environment: str) -> bool:
    """Ask eBay whether these keys work, and say plainly what came back.

    A key pair that is merely *typed in* proves nothing. This is the one
    question worth answering before anything else: does eBay accept them?
    """
    import base64
    import json
    import urllib.error
    import urllib.request

    host = "api.sandbox.ebay.com" if environment == "sandbox" else "api.ebay.com"
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    request = urllib.request.Request(  # noqa: S310 - fixed https endpoint
        f"https://{host}/identity/v1/oauth2/token",
        data=b"grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        say(f"  {RED}eBay rejected the keys{RESET} (HTTP {error.code}).")
        if error.code in (400, 401):
            say(f"  {DIM}Usually: a typo, or sandbox keys with EBAY_ENVIRONMENT=production.{RESET}")
        detail = body[:200].replace(client_secret, "***")
        say(f"  {DIM}{detail}{RESET}")
        return False
    except urllib.error.URLError as error:
        say(f"  {YELLOW}could not reach eBay{RESET}: {error.reason}")
        say(f"  {DIM}The keys may still be fine - this looks like a network problem.{RESET}")
        return False

    if not payload.get("access_token"):
        say(f"  {RED}eBay returned no token.{RESET}")
        return False
    say(f"  {GREEN}ok{RESET} eBay accepted the keys ({environment}).")
    return True


def masked(secret: str) -> str:
    """Enough of a secret to recognise it by, and no more."""
    if len(secret) <= 8:
        return "too short to be right"
    return f"{secret[:4]}...{secret[-4:]}"


def key_problems(client_id: str, client_secret: str) -> list[str]:
    """Shape checks that catch the mistakes eBay only reports as "failed".

    eBay answers a wrong key pair with one opaque message, so anything we can
    tell from the values themselves is worth saying before the round trip.
    """
    problems = []
    if not client_secret.upper().startswith(("PRD-", "SBX-")):
        problems.append(
            "the Cert ID normally starts with PRD- or SBX-. If yours does not, "
            "you may have copied the Dev ID, which is the row below it."
        )
    if client_id.count("-") < 3:
        problems.append(
            "the App ID normally has several dashes, like "
            "Name-Appname-PRD-xxxxxxxxx-xxxxxxxx. Yours looks short."
        )
    # The last block is the one that gets clipped, because a copy that stops
    # early still looks like a complete key: eBay's tail is 12 characters,
    # and the four before it are 4 each, so a short tail reads as plausible.
    tail = client_secret.rsplit("-", 1)[-1]
    if client_secret.upper().startswith(("PRD-", "SBX-")) and len(tail) < 12:
        problems.append(
            f"the Cert ID ends in a {len(tail)}-character block ({tail}). eBay's "
            "end in 12, so this one looks cut short - check the end of the value "
            "on eBay and copy it again."
        )
    id_is_production = "-PRD-" in client_id.upper()
    secret_is_production = client_secret.upper().startswith("PRD-")
    if id_is_production != secret_is_production:
        problems.append(
            "one key looks like Production and the other like Sandbox. They must "
            "both come from the same row."
        )
    return problems


#: What actually goes wrong, in the order it usually goes wrong.
REJECTION_HELP = [
    "Three things to check, in this order:",
    "  1. The Cert ID may have pasted incompletely. Compare the character",
    "     count above with the value on eBay - it is long and easy to clip.",
    "  2. The App ID and Cert ID must be from the SAME row on eBay.",
    "     The Production row has its own pair; Sandbox has another.",
    "  3. Make sure you copied the Cert ID, not the Dev ID next to it.",
]


def connect_ebay() -> int:
    """Ask for the two eBay keys, store them, and verify them.

    Typed in here rather than pasted into a file: the secret is not echoed,
    does not end up in shell history, and the file is written with the right
    permissions and no quoting to get wrong.
    """
    import getpass

    print(f"\n{BOLD}Connect eBay{RESET}")
    print(f"{DIM}developer.ebay.com -> your name (top right) -> Application Keys.{RESET}")
    print(f"{DIM}Take the Production row, not Sandbox.{RESET}\n")

    client_id = input("  App ID (Client ID):  ").strip()
    # Hidden, because it is a password in everything but name.
    client_secret = getpass.getpass("  Cert ID (Client Secret, hidden):  ").strip()

    if not client_id or not client_secret:
        fail("both keys are needed.", "Run  python3 start.py --connect-ebay  again.")

    # A hidden prompt gives no feedback, so a paste that dropped half the
    # value looks exactly like one that worked. Echoing the shape - never the
    # value - is what makes that visible.
    say(f"\n  read: App ID {len(client_id)} characters, "
        f"Cert ID {len(client_secret)} characters ({masked(client_secret)})")
    for problem in key_problems(client_id, client_secret):
        say(f"  {YELLOW}?{RESET} {problem}")

    environment = "sandbox" if "-SBX-" in client_id.upper() else "production"
    if environment == "sandbox":
        say(f"  {YELLOW}note{RESET} that App ID is a sandbox key.")
        say(f"  {DIM}Sandbox works, but holds almost no listings to find.{RESET}")

    print()
    if not check_ebay(client_id, client_secret, environment):
        print()
        for line in REJECTION_HELP:
            say(f"  {line}")
        print(f"\n  {DIM}Nothing was saved. Run the command again to retry.{RESET}\n")
        return 1

    write_env(
        {
            "EBAY_CLIENT_ID": client_id,
            "EBAY_CLIENT_SECRET": client_secret,
            "EBAY_ENVIRONMENT": environment,
            "EBAY_MARKETPLACE": "EBAY_DE",
        }
    )
    say(f"  {GREEN}ok{RESET} saved to {ENV_FILE.name} (readable only by you).")
    print(f"\n  Now run:  {BOLD}python3 start.py{RESET}")
    print(f"  Then open {BOLD}Find deals{RESET} in the menu.\n")
    return 0


def backend_environment(
    password_override: str | None = None, *, require_login: bool = False
) -> dict[str, str]:
    """Research mode, SQLite, no Redis, no background workers.

    Sign-in is skipped by default: this is a single-user tool bound to this
    machine that cannot spend money. The backend refuses to skip it in
    production or whenever it *can* spend money, whatever is set here.
    """
    password = read_or_create_password(password_override)
    return {
        "DATABASE_URL": f"sqlite:///{DB_PATH}",
        "ENVIRONMENT": "development",
        "RESEARCH_MODE": "true",
        "DEMO_MODE": "true",
        "SIMULATION_MODE": "true",
        "AUTOMATION_LEVEL": "1",
        "LOG_LEVEL": "WARNING",
        "LOG_FORMAT": "console",
        "SECRET_KEY": read_or_create_secret(),
        "CORS_ORIGINS": f"http://localhost:{FRONTEND_PORT}",
        "BOOTSTRAP_USER_EMAIL": "operator@example.com",
        "BOOTSTRAP_USER_PASSWORD": password,
        "LOCAL_NO_AUTH": "false" if require_login else "true",
        "PYTHONUNBUFFERED": "1",
        **marketplace_keys(),
    }


def _stored(key: str, generator) -> str:
    """Keep generated secrets stable across restarts, in a git-ignored file."""
    values: dict[str, str] = {}
    if CREDENTIALS_FILE.exists():
        for line in CREDENTIALS_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                name, _, value = line.partition("=")
                values[name.strip()] = value.strip()
    if key not in values:
        values[key] = generator()
        CREDENTIALS_FILE.write_text(
            "# Local research install. Not for production. Safe to delete.\n"
            + "\n".join(f"{k}={v}" for k, v in values.items())
            + "\n",
            encoding="utf-8",
        )
        if not IS_WINDOWS:
            CREDENTIALS_FILE.chmod(0o600)
    return values[key]


def read_or_create_password(override: str | None = None) -> str:
    if override:
        # Replace whatever was stored, so `--password` is repeatable.
        _forget("LOGIN_PASSWORD")
        return _stored("LOGIN_PASSWORD", lambda: override)
    return _stored("LOGIN_PASSWORD", lambda: secrets.token_urlsafe(12))


def _forget(key: str) -> None:
    if not CREDENTIALS_FILE.exists():
        return
    kept = [
        line
        for line in CREDENTIALS_FILE.read_text(encoding="utf-8").splitlines()
        if not line.startswith(f"{key}=")
    ]
    CREDENTIALS_FILE.write_text("\n".join(kept) + "\n", encoding="utf-8")


def show_login() -> int:
    """Print the saved sign-in details and exit."""
    if not CREDENTIALS_FILE.exists():
        print(
            "No login has been created yet. Run this script once first:\n"
            "    python3 start.py",
            file=sys.stderr,
        )
        return 1
    print("\n  Sign in at http://localhost:3000 with:\n")
    print(f"    email     {BOLD}operator@example.com{RESET}")
    print(f"    password  {BOLD}{read_or_create_password()}{RESET}\n")
    return 0


def read_or_create_secret() -> str:
    return _stored("SECRET_KEY", lambda: secrets.token_urlsafe(48))


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def check_ports_are_free() -> None:
    """Refuse to start on an occupied port.

    Without this the readiness check below can be satisfied by whatever is
    already listening - including a previous run of this script - and the
    script reports success while its own server has quietly failed to bind.
    """
    busy = [port for port in (BACKEND_PORT, FRONTEND_PORT) if port_in_use(port)]
    if not busy:
        return
    ports = " and ".join(str(port) for port in busy)
    verb = "is" if len(busy) == 1 else "are"
    finder = (
        f"netstat -ano | findstr :{busy[0]}"
        if IS_WINDOWS
        else f"lsof -i :{busy[0]}"
    )
    fail(
        f"Port {ports} {verb} already in use.",
        "This is usually another copy of this script still running.\n"
        "Close it (Ctrl+C in its window), then try again.\n\n"
        f"To see what is using it:\n    {finder}",
    )


def wait_for(url: str, *, timeout: float, what: str):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3):
                return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.5)
    fail(f"{what} did not start within {int(timeout)} seconds.")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Start the arbitrage platform in research mode.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--password",
        metavar="TEXT",
        help="set your own sign-in password instead of a generated one",
    )
    parser.add_argument(
        "--show-login",
        action="store_true",
        help="print the saved sign-in details and exit",
    )
    parser.add_argument(
        "--connect-ebay",
        action="store_true",
        help="enter your eBay keys, check them against eBay, and save them",
    )
    parser.add_argument(
        "--require-login",
        action="store_true",
        help="ask for an email and password instead of going straight in",
    )
    args = parser.parse_args()

    if args.show_login:
        return show_login()

    if args.connect_ebay:
        return connect_ebay()

    print(f"\n{BOLD}Arbitrage platform - research mode{RESET}")
    print(f"{DIM}Real analysis. Nothing can be listed, bought or shipped.{RESET}")

    step(1, 4, "Checking what's installed")
    check_prerequisites()

    step(2, 4, "Setting up the backend")
    ensure_backend()

    step(3, 4, "Setting up the web interface")
    ensure_frontend()

    step(4, 4, "Starting")
    ensure_database_matches_the_code()
    check_ports_are_free()
    env = backend_environment(args.password, require_login=args.require_login)
    processes = []
    try:
        processes.append(
            subprocess.Popen(
                [
                    str(venv_bin("python")), "-m", "uvicorn", "app.main:app",
                    "--host", "127.0.0.1", "--port", str(BACKEND_PORT),
                ],
                cwd=BACKEND,
                env={**os.environ, **env},
            )
        )
        wait_for(
            f"http://127.0.0.1:{BACKEND_PORT}/api/health", timeout=60, what="The backend"
        )
        say(f"  {GREEN}ok{RESET} backend on http://127.0.0.1:{BACKEND_PORT}")

        processes.append(
            subprocess.Popen(
                ["npm", "run", "start", "--", "--port", str(FRONTEND_PORT)],
                cwd=FRONTEND,
                env={
                    **os.environ,
                    "NEXT_PUBLIC_API_BASE_URL": f"http://127.0.0.1:{BACKEND_PORT}",
                    "NODE_ENV": "production",
                },
                stdout=subprocess.DEVNULL,
            )
        )
        wait_for(
            f"http://127.0.0.1:{FRONTEND_PORT}/login", timeout=90, what="The web interface"
        )
        say(f"  {GREEN}ok{RESET} web interface on http://localhost:{FRONTEND_PORT}")

        url = f"http://localhost:{FRONTEND_PORT}"
        print(f"\n{GREEN}{BOLD}Ready.{RESET}  {BOLD}{url}{RESET}")
        if args.require_login:
            print("\n  Sign in with:")
            print(f"    email     {BOLD}{env['BOOTSTRAP_USER_EMAIL']}{RESET}")
            print(f"    password  {BOLD}{env['BOOTSTRAP_USER_PASSWORD']}{RESET}")
            print(f"\n  {DIM}Lost it? Run:  python3 start.py --show-login{RESET}")
        else:
            print(f"\n  {DIM}No sign-in needed - just open the link above.{RESET}")
            print(f"  {DIM}Want one? Run:  python3 start.py --require-login{RESET}")
        print(f"\n  {YELLOW}Research mode is on.{RESET} The system analyses real products but")
        print("  cannot list, buy or ship. Nothing you do here spends money.")
        if env.get("EBAY_CLIENT_ID"):
            where = env.get("EBAY_ENVIRONMENT", "production")
            print(f"\n  {GREEN}eBay is connected{RESET} ({where}). 'Find the listing on eBay'")
            print("  returns real listings with their item numbers.")
        else:
            print(f"\n  {DIM}No eBay keys found in .env - the eBay side is typed by hand.{RESET}")
            print(f"  {DIM}See docs/research-mode.md to connect it.{RESET}")
        print("\n  Go to 'Research' in the menu to analyse your own products.")
        print(f"\n{DIM}  Press Ctrl+C to stop.{RESET}\n")

        # Headless or no default browser: the URL is printed above anyway.
        with contextlib.suppress(OSError, webbrowser.Error):
            webbrowser.open(url)

        while True:
            for process in processes:
                if process.poll() is not None:
                    fail(
                        "One of the servers stopped unexpectedly.",
                        "The reason is in the output above this message.",
                    )
            time.sleep(1)
    except KeyboardInterrupt:
        print(f"\n{DIM}Stopping...{RESET}")
    finally:
        for process in processes:
            if process.poll() is None:
                try:
                    if IS_WINDOWS:
                        process.terminate()
                    else:
                        process.send_signal(signal.SIGINT)
                    process.wait(timeout=10)
                except (subprocess.TimeoutExpired, OSError):
                    process.kill()
        print("Stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
