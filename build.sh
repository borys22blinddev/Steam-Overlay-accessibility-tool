#!/bin/sh
# Builds the single-file program (installer + daemon) into dist/ with
# PyInstaller. Works on Linux, on macOS and, from Git Bash, on Windows; a build
# only runs on the system it was made on. Needs: pip install pyinstaller
# websockets (on macOS also the Xcode command line tools, for swiftc).
set -e
cd "$(dirname "$0")"
PYTHON=${PYTHON:-python3}
command -v "$PYTHON" >/dev/null || PYTHON=python
EXTRA=
case $(uname -s) in
    Linux) NAME=steam-overlay-access-linux; WINDOWED= ;;
    Darwin) NAME=steam-overlay-access-mac; WINDOWED=
        swiftc -O mac_speak.swift -o mac_speak
        EXTRA='--add-binary mac_speak:.' ;;
    *) NAME=steam-overlay-access; WINDOWED=--noconsole ;;
esac
"$PYTHON" -m PyInstaller --noconfirm --clean --onefile $WINDOWED --name "$NAME" \
    --add-data agent.js:. --add-data sapi_speak.ps1:. $EXTRA \
    --hidden-import speechd \
    --workpath build soa_setup.py
echo "Built dist/$NAME"
