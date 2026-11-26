#!/bin/sh
# Meeting Todo QC - one-click install (macOS / Linux)
# Usage: sh install_dumate.sh
set -e

SRC="$(cd "$(dirname "$0")" && pwd)/meeting-todo-qc"
if [ ! -f "$SRC/plugin.json" ]; then
  echo "[ERR] meeting-todo-qc folder not found next to this script."
  exit 1
fi

for BASE in \
  "$HOME/Library/Application Support/qianfan-desktop-app/qianfan_desk_xdg" \
  "$HOME/.local/share/qianfan-desktop-app/qianfan_desk_xdg" \
  "$HOME/AppData/Roaming/qianfan-desktop-app/qianfan_desk_xdg"
do
  [ -d "$BASE" ] || continue
  for D in "$BASE"/*/data/plugins/user; do
    [ -d "$D" ] || continue
    cp -R "$SRC" "$D/meeting-todo-qc"
    echo "[OK] installed to $D/meeting-todo-qc"
    DONE=1
  done
done

if [ -z "${DONE:-}" ]; then
  echo "[ERR] DuMate plugin dir not found. Open the client once, then rerun."
  echo "      Manual path: <DuMate data dir>/<instance-id>/data/plugins/user/"
  exit 1
fi

echo ""
echo "Restart the DuMate client, then check Plugins in the left sidebar."
echo "Verify:  python3 <plugin dir>/skills/meeting-todo-qc/scripts/qc.py --check"