# qSuite

XIO's local-first alternative to Microsoft 365 and Google Workspace.

| App | What it does |
|---|---|
| qDocs (`docs/`) | Documents stored in your browser on your own machine, never sent anywhere. Exports to .txt, .md, .html, .docx and PDF locally. No account needed. |
| qDrive (`drive/`) | File storage in the browser, plus direct device-to-device transfer between your own devices over WebRTC, sealed end to end. |

Plain HTML, CSS and JavaScript with no build step. `qsuite.css` is the shared
design system.

## Running it

qDrive needs a secure context for `crypto.subtle`, so serve the folder rather
than opening `index.html` from disk. Any static server on `127.0.0.1` works,
for example:

```bash
python3 -m http.server 8060 --bind 127.0.0.1
```

`bundle/` holds the launchers for the downloadable build (`start.bat`,
`start.sh`, `start.py`) and its user guide; `build-bundle.py` packages it.

## Dependencies outside this repository

qSuite is built to run inside the Qwertious site:

- **Sign-in.** qDrive identifies your devices with a Qwertious account. It
  loads `/accounts/qip.js` (and `qip.css`, `qip-ui.js`) from the
  [QIP](https://plus.qwertious.org/accounts/) identity project, which is not
  part of this repository. qDocs works without it.
- **Relay and lobby.** Pairing devices on different networks uses a QNP node.
  Set yours in `lib/qsuite-config.js` (`QNP_NODES`). With none set, qDrive
  falls back to connection codes.
- **The bundle builder** expects to sit in the site tree next to `accounts/`
  and `qwOS/`, and writes to `accounts/downloads/`.

## License

Copyright (C) 2026 Qwertious

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

In short: use it, change it and share it freely, commercially or not. If you
share it or a modified version, keep this credit, say what you changed, and
release your version under the GPL too, with its source code.
