#!/bin/sh
# Builds the single-file program (installer + daemon) into dist/ with
# PyInstaller. Works on Linux and, from Git Bash, on Windows; a build only
# runs on the system it was made on. Needs: pip install pyinstaller websockets
set -e
cd "$(dirname "$0")"
PYTHON=${PYTHON:-python3}
command -v "$PYTHON" >/dev/null || PYTHON=python
NVDA=
case $(uname -s) in
    Linux) NAME=steam-overlay-access-linux; WINDOWED= ;;
    *) NAME=steam-overlay-access; WINDOWED=--noconsole
       # NVDA's controller client, matching this Python's bitness (the release workflow fetches it).
       if [ -f nvdaControllerClient.dll ]; then NVDA="--add-binary nvdaControllerClient.dll:."
       else echo "Warning: nvdaControllerClient.dll not found here; this build will not speak through NVDA." >&2; fi ;;
esac
"$PYTHON" -m PyInstaller --noconfirm --clean --onefile $WINDOWED --name "$NAME" \
    --add-data agent.js:. --add-data sapi_speak.ps1:. $NVDA \
    --hidden-import speechd \
    --workpath build soa_setup.py
echo "Built dist/$NAME"
