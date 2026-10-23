#!/usr/bin/env python3
"""
Builds the downloadable qSuite bundle.

    python3 qsuite/build-bundle.py

Writes accounts/downloads/qsuite.zip plus a sibling qsuite.manifest.json, in
the same shape the authenticator download already uses, so the Accounts
dashboard can render size/hash/date for it the same way.

Two things this does beyond zipping a folder:

  1. Copies accounts/qip.js in as lib/qip.js. The live site loads qip.js from
     /accounts/ so there is exactly one copy and it cannot drift; the bundle
     has no /accounts/, so it gets a snapshot instead.
  2. Rewrites the <script src="/accounts/qip.js"> tags to point at that local
     copy. This is the only source difference between the hosted suite and the
     bundle, and it is done here rather than in the source so the hosted copy
     keeps its single-source-of-truth reference.
"""

import hashlib
import json
import os
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QSUITE = os.path.join(ROOT, "qsuite")
OUT_DIR = os.path.join(ROOT, "accounts", "downloads")
OUT_ZIP = os.path.join(OUT_DIR, "qsuite.zip")
OUT_MANIFEST = os.path.join(OUT_DIR, "qsuite.manifest.json")

# What goes in, relative to qsuite/. build-bundle.py and bundle/ itself are
# excluded: the launcher files are placed at the archive root, not under
# bundle/, and the build script is not something a user of the bundle needs.
INCLUDE_DIRS = ["docs", "drive", "lib"]
INCLUDE_FILES = ["index.html", "qsuite.css"]

# qwOS ships too, from its own directory at the site root. Its entry point is
# PHP, so the bundle gets a generated static index.html instead -- see
# qwos_index_html(). Everything else is plain files and copies straight over.
QWOS_DIR = os.path.join(ROOT, "qwOS")
QWOS_INCLUDE = ["src"]

# Launcher files, copied from bundle/ to the archive root.
LAUNCHER_FILES = ["start.py", "start.bat", "start.sh", "README.txt"]

# Anything matching these is never bundled.
SKIP_SUFFIXES = (".swp", ".tmp", "~")
SKIP_NAMES = {".DS_Store", "Thumbs.db"}


def should_skip(name):
    return name in SKIP_NAMES or name.endswith(SKIP_SUFFIXES)


def read(path):
    with open(path, "rb") as f:
        return f.read()


def localise_qip_reference(data, depth):
    """Point /accounts/qip.js at the bundled copy.

    `depth` is how many directories deep the HTML file sits, so the relative
    path resolves from where it actually lives (drive/index.html needs
    ../lib/qip.js, a root-level page would need lib/qip.js).
    """
    prefix = "../" * depth
    return data.replace(
        b'src="/accounts/qip.js"',
        ('src="%slib/qip.js"' % prefix).encode("utf-8"),
    )


def qwos_index_html():
    """A static entry point for qwOS, standing in for its index.php.

    The PHP does three things: emit a session id, work out the base path, and
    inject the Qwertious Accounts node list. In the bundle there is no PHP and
    no accounts server reachable by default, so this hardcodes the equivalents
    and lets qwOS run in guest mode -- the filesystem, apps and editing all
    work; only the encrypted stores (which need an account key) ask you to
    sign in.
    """
    source = os.path.join(QWOS_DIR, "index.php")
    with open(source, encoding="utf-8") as f:
        html = f.read()

    # Strip the leading PHP block.
    marker = "?><!DOCTYPE html>"
    if marker in html:
        html = "<!DOCTYPE html>" + html.split(marker, 1)[1]

    # Substitute the values the PHP would have produced.
    html = html.replace(
        '<?= htmlspecialchars($basePath, ENT_QUOTES) ?>/src/styles/qwos.css',
        "src/styles/qwos.css")
    html = html.replace(
        '<?= htmlspecialchars($basePath, ENT_QUOTES) ?>/src/kernel/core.js',
        "src/kernel/core.js")
    html = html.replace("<?= json_encode($config) ?>",
                        '{"sessionId":"local","basePath":""}')
    html = html.replace("<?= json_encode(array_values($qipNodes)) ?>", "[]")

    # No accounts server in the bundle, so the sign-in scripts would 404.
    html = html.replace('<link rel="stylesheet" href="/accounts/qip.css">', "")
    html = html.replace('<script src="/accounts/qip.js" defer></script>', "")
    html = html.replace('<script src="/accounts/qip-ui.js" defer></script>', "")

    if "<?" in html:
        raise SystemExit("qwOS index.php has PHP this build does not know how to "
                         "substitute -- update qwos_index_html()")
    return html.encode("utf-8")


def main():
    if not os.path.isdir(QSUITE):
        print("Cannot find qsuite/ -- run this from anywhere, but keep the file in place.")
        return 1

    qip_src = os.path.join(ROOT, "accounts", "qip.js")
    if not os.path.exists(qip_src):
        print("Cannot find accounts/qip.js -- the bundle needs it for identity.")
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    entries = []  # (archive name, bytes)

    # 1. Launcher files at the archive root.
    for name in LAUNCHER_FILES:
        path = os.path.join(QSUITE, "bundle", name)
        if not os.path.exists(path):
            print("Missing launcher file: bundle/%s" % name)
            return 1
        entries.append((name, read(path)))

    # 2. Top-level app files.
    for name in INCLUDE_FILES:
        path = os.path.join(QSUITE, name)
        data = read(path)
        if name.endswith(".html"):
            data = localise_qip_reference(data, 0)
        entries.append((name, data))

    # 3. The app directories.
    for directory in INCLUDE_DIRS:
        base = os.path.join(QSUITE, directory)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for filename in sorted(filenames):
                if should_skip(filename):
                    continue
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, QSUITE).replace(os.sep, "/")
                data = read(full)
                if filename.endswith(".html"):
                    data = localise_qip_reference(data, rel.count("/"))
                entries.append((rel, data))

    # 4. The identity library snapshot.
    entries.append(("lib/qip.js", read(qip_src)))

    # 5. qwOS, with a generated static entry point in place of its index.php.
    if os.path.isdir(QWOS_DIR):
        entries.append(("qwOS/index.html", qwos_index_html()))
        for directory in QWOS_INCLUDE:
            base = os.path.join(QWOS_DIR, directory)
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
                for filename in sorted(filenames):
                    if should_skip(filename) or filename.endswith(".php"):
                        continue  # network_proxy.php needs a PHP host; skip it
                    full = os.path.join(dirpath, filename)
                    rel = "qwOS/" + os.path.relpath(full, QWOS_DIR).replace(os.sep, "/")
                    entries.append((rel, read(full)))

    # Deterministic order and a fixed timestamp, so rebuilding without source
    # changes produces a byte-identical zip -- which means the published
    # SHA-256 only changes when something real changed.
    entries.sort(key=lambda e: e[0])
    fixed_time = (2026, 1, 1, 0, 0, 0)

    with zipfile.ZipFile(OUT_ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            info = zipfile.ZipInfo("qsuite/" + name, date_time=fixed_time)
            info.compress_type = zipfile.ZIP_DEFLATED
            # Make start.py/start.sh executable when unzipped on Unix.
            executable = name in ("start.py", "start.sh")
            info.external_attr = (0o755 if executable else 0o644) << 16
            zf.writestr(info, data)

    raw = read(OUT_ZIP)
    manifest = {
        "file": "qsuite.zip",
        "size_bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "built": int(time.time()),
        "file_count": len(entries),
    }
    with open(OUT_MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    print("Wrote %s" % os.path.relpath(OUT_ZIP, ROOT))
    print("  %d files, %.1f KB" % (len(entries), len(raw) / 1024.0))
    print("  sha256 %s" % manifest["sha256"])
    for name, data in entries:
        print("    %-34s %7d" % (name, len(data)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
