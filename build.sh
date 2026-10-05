#!/bin/sh
# Builds the single-file program (installer + daemon) into dist/ with
# PyInstaller. Works on Linux and, from Git Bash, on Windows; a build only
# runs on the system it was made on. Needs: pip install pyinstaller websockets
set -e
cd "$(dirname "$0")"
PYTHON=${PYTHON:-python3}
command -v "$PYTHON" >/dev/null || PYTHON=python
case $(uname -s) in
    Linux) NAME=steam-overlay-access-linux; WINDOWED=; EXTRA= ;;
    *) NAME=steam-overlay-access; WINDOWED=--noconsole
       # NVDA's controller client, so that speech goes through NVDA out of the box.
       "$PYTHON" fetch_nvda_client.py build/nvda
       EXTRA="--add-binary build/nvda/nvdaControllerClient.dll:. --add-data build/nvda/nvdaControllerClient-license.txt:." ;;
esac
"$PYTHON" -m PyInstaller --noconfirm --clean --onefile $WINDOWED --name "$NAME" \
    --add-data agent.js:. --add-data sapi_speak.ps1:. $EXTRA \
    --hidden-import speechd \
    --workpath build/pyinstaller soa_setup.py
echo "Built dist/$NAME"
