qSuite
======

qDocs, qDrive and a link to QMS -- running from your own machine, with no
website in the middle.


Starting it
-----------

  Windows        double-click  start.bat
  macOS / Linux  ./start.sh    (or: python3 start.py)

Either one serves this folder on 127.0.0.1 and opens your browser. Needs
Python 3 and nothing else -- no install, no dependencies, no build step.

To stop it, press Ctrl+C in the terminal window.


Why does it need a little server?
---------------------------------

Browsers only provide the cryptography qDrive uses (crypto.subtle) in what
they call a "secure context". https:// counts, and so does http://127.0.0.1 --
but a file:// path does not, on every browser. Opening index.html directly
would leave qDrive quietly unable to work, so the launcher serves the files
over loopback instead.

The server binds to 127.0.0.1 only, so nothing on your network can reach it.


What works offline
------------------

qDocs    Everything. Documents are stored in your browser's own storage on
         this machine, and never sent anywhere. No account required. Exports
         to .txt, .md, .html, .docx and PDF all run locally.

qDrive   Storing, browsing and saving files works entirely offline.
         *Pairing* two of your devices needs:
           - a Qwertious account signed in on both (it is what proves the
             two devices are yours), and
           - either a reachable Qwertious node, or the "Use a code" fallback,
             which needs no server at all beyond getting the two devices
             connected.

qwOS     Everything except external browsing. The desktop, filesystem,
         apps and -- crucially -- editing the system's own source all work
         offline. Two things need more than the bundle has:
           - the encrypted stores (Passwords, Vault) need a signed-in
             Qwertious account to derive a key from, so they ask you to
             sign in and otherwise stay locked;
           - the Browser app's external pages go through a PHP proxy that
             is not included; internal qwos:// routes work fine.

QMS      Not included. It is a server application -- it needs PHP and the
         message history, which live on the website. The qSuite launcher
         links to the hosted copy instead.


A note on qDrive and privacy
----------------------------

Files you add are immediately available to your *own* other devices. "Own"
is enforced with cryptography, not a setting: a device has to prove it holds
your account's private key before it is told anything, so a stranger who can
see that your device is online still cannot ask it for a single filename.

Use Hide on a file to keep it off that list.

If a direct connection between your devices cannot be made, traffic falls
back to a relay node. The relay only ever carries ciphertext -- the two
devices establish their own end-to-end encryption first, so a relay operator
sees encrypted bytes and nothing else.


Pointing at your own node
-------------------------

Edit lib/qsuite-config.js and change QNP_NODES to your node's base URL.
Running your own is a few minutes' work -- the authenticator package is
linked from the Qwertious Accounts page.


Layout
------

  index.html          the launcher page
  qsuite.css          shared design tokens
  docs/               qDocs
  drive/              qDrive
  qwOS/               qwOS -- its src/ is the running system, and editable
  lib/                shared crypto and networking
    qip.js            identity (Qwertious Accounts)
    qrp-web.js        authenticated rendezvous
    transport-webrtc.js
    qnp-client.js     relay transport
    qnp-lobby.js      device discovery
    qsuite-p2p.js     connection handling
    qsuite-config.js  which nodes to use
