#!/usr/bin/env python3
"""
qSuite launcher.

Serves this folder on 127.0.0.1 and opens it in your browser.

Why a server at all, when these are just HTML files? Because browsers only
expose the cryptography qDrive needs (crypto.subtle) in a "secure context",
and a file:// path is not one on every browser. http://127.0.0.1 always is.
qDocs alone would work from file://, but serving everything the same way
avoids a confusing half-broken suite.

Nothing leaves your machine: the server binds to the loopback interface only,
so it is not reachable from your network.

    python3 start.py             # pick a free port automatically
    python3 start.py 9000        # or ask for a specific one
"""

import http.server
import os
import socket
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Never cache: editing a file and reloading should show the change,
        # and a stale cached script is a baffling way to lose an afternoon.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # Browsers ask for /favicon.ico unprompted. There isn't one, and a 404 for
    # it is normal -- but it is the only thing most users would ever see in
    # this window, and it looks like something is broken.
    def _is_noise(self):
        return str(getattr(self, "path", "")).endswith("/favicon.ico")

    def log_message(self, fmt, *args):
        # SimpleHTTPRequestHandler logs every request to stderr, which buries
        # the one line the user actually needs. Stay quiet unless it matters.
        if self._is_noise():
            return
        if not str(args[1] if len(args) > 1 else "").startswith(("2", "3")):
            sys.stderr.write("  %s\n" % (fmt % args))
            sys.stderr.flush()

    # send_error() routes through log_error, whose format string carries only
    # the status code -- no path -- so filtering the message text would never
    # match. Checking self.path is what actually catches it.
    def log_error(self, fmt, *args):
        if self._is_noise():
            return
        sys.stderr.write("  %s\n" % (fmt % args))
        sys.stderr.flush()


def free_port(preferred=None):
    if preferred:
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((HOST, 0))
        return s.getsockname()[1]


def main():
    preferred = None
    if len(sys.argv) > 1:
        try:
            preferred = int(sys.argv[1])
        except ValueError:
            print("Usage: python3 start.py [port]")
            return 1

    if not os.path.exists(os.path.join(ROOT, "index.html")):
        print("This script must stay in the same folder as index.html.")
        return 1

    port = free_port(preferred)
    socketserver.TCPServer.allow_reuse_address = True

    try:
        httpd = socketserver.TCPServer((HOST, port), Handler)
    except OSError as e:
        print("Could not start on port %d: %s" % (port, e))
        print("Try a different one, e.g.  python3 start.py 9001")
        return 1

    url = "http://%s:%d/" % (HOST, port)
    banner = (
        "\n"
        "  qSuite is running at  %s\n"
        "\n"
        "  qDocs   works completely offline, no account needed.\n"
        "  qDrive  stores files locally; pairing your devices needs a\n"
        "          Qwertious account and a reachable node (or a code).\n"
        "\n"
        "  Press Ctrl+C to stop.\n"
        "\n"
    ) % url
    # flush explicitly: Python block-buffers stdout when it is not a terminal,
    # so piping the launcher to a file or a wrapper would otherwise swallow
    # this until the process exits -- which is exactly when it stops mattering.
    sys.stdout.write(banner)
    sys.stdout.flush()

    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
