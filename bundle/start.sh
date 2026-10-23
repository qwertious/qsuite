#!/bin/sh
# qSuite launcher for macOS and Linux.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
    exec python3 "$DIR/start.py" "$@"
fi

# Some systems only have `python`, which may be 2 or 3 -- check before using it.
if command -v python >/dev/null 2>&1; then
    if python -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' 2>/dev/null; then
        exec python "$DIR/start.py" "$@"
    fi
fi

echo
echo "  qSuite needs Python 3, which does not appear to be installed."
echo "  On Debian/Ubuntu:  sudo apt install python3"
echo "  On macOS:          brew install python3   (or install Xcode tools)"
echo
exit 1
