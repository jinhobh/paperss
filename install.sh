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

build_selector() {
    command -v cc >/dev/null 2>&1 || {
        echo "cc is required to build the C wallpaper selector" >&2
        exit 1
    }
    command -v pkg-config >/dev/null 2>&1 || {
        echo "pkg-config is required to build the C wallpaper selector" >&2
        exit 1
    }
    pkg-config --exists gtk4 gdk-pixbuf-2.0 || {
        echo "GTK4 development packages are required (gtk4 and gdk-pixbuf-2.0)" >&2
        exit 1
    }

    local output="$HOME/.local/libexec/paperss/wallpaper-selector"
    local temporary="$output.tmp.$$"
    mkdir -p "$(dirname "$output")"
    echo "building C selector -> $output"
    cc -std=c11 -O2 -Wall -Wextra -Wno-deprecated-declarations \
        "$REPO/src/wallpaper-selector.c" \
        $(pkg-config --cflags --libs gtk4 gdk-pixbuf-2.0) \
        -lm -o "$temporary"
    mv "$temporary" "$output"
}

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
build_selector
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

Build/runtime dependencies:
  C compiler, pkg-config, GTK 4 development files, GDK Pixbuf development
  files, Python 3, Matugen, swaybg, Hyprland, Kitty, Waybar, Wofi, and Mako.

Optional integrations:
  Firefox/Re:fox and pywalfox, plus Spotify/Spicetify.

Add this binding to ~/.config/hypr/hyprland.conf if it is not already present:

  bind = $mainMod SHIFT, Tab, exec, wallpaper-selector

Then reload Hyprland. Super+Shift+Tab opens the selector; release Super or
press Enter to apply the selected wallpaper and palette.
NEXT
