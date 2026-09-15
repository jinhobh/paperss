#!/usr/bin/env bash
# Link the Paperss wallpaper switcher into the desktop.
#
# The repository contains the selector, palette pipeline, and the templates
# needed to recolor the supported desktop clients. Generated files and the
# user's wallpaper profiles remain under ~/.local/share/rice.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

BIN="$HOME/.local/bin"
MATUGEN="$HOME/.config/matugen"
RICE="$HOME/.local/share/rice"

made=0
kept=0
skipped=0

link() {  # link <source-in-repo> <destination>
    local src="$1" dst="$2"

    if [[ -L "$dst" ]]; then
        if [[ "$(readlink -f "$dst")" == "$(readlink -f "$src")" ]]; then
            kept=$((kept + 1))
            return
        fi
    elif [[ ! -e "$dst" ]]; then
        :
    elif (( FORCE )); then
        local backup="$dst.pre-paperss.$(date +%Y%m%d%H%M%S)"
        mv "$dst" "$backup"
        echo "  moved aside  $dst -> $backup"
    else
        echo "  IN THE WAY   $dst (not a link into this repo; --force to replace)" >&2
        skipped=$((skipped + 1))
        return
    fi

    mkdir -p "$(dirname "$dst")"
    ln -sfn "$src" "$dst"
    echo "  linked       $dst"
    made=$((made + 1))
}

echo "linking Paperss from $REPO"
mkdir -p "$RICE"

for script in wallpaper-selector retheme hypr-reload; do
    link "$REPO/bin/$script" "$BIN/$script"
done

link "$REPO/matugen/extract.toml" "$MATUGEN/extract.toml"
link "$REPO/matugen/config.toml" "$MATUGEN/config.toml"
for template in "$REPO"/matugen/templates/*; do
    link "$template" "$MATUGEN/templates/$(basename "$template")"
done

echo "$made linked, $kept already correct, $skipped skipped"

if (( skipped )); then
    echo
    echo "Some paths were left alone. Inspect them, then re-run with --force." >&2
    exit 1
fi

cat <<'NEXT'

Dependencies:
  Python 3, python3-gi, python3-cairo, GTK 4 introspection data, Matugen,
  swaybg, Hyprland, Kitty, Waybar, Wofi, and Mako.

Optional integrations:
  Firefox/Re:fox and pywalfox, plus Spotify/Spicetify.

Add this binding to ~/.config/hypr/hyprland.conf if it is not already present:

  bind = $mainMod SHIFT, Tab, exec, wallpaper-selector

Then reload Hyprland. Super+Shift+Tab opens the selector; release Super or
press Enter to apply the selected wallpaper and palette.
NEXT
