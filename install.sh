#!/usr/bin/env bash
# Link this checkout into the places the desktop reads from.
#
# Everything here is a symlink rather than a copy, so editing a script in the
# repo edits the live desktop and `git status` tells the truth about what the
# desktop is currently running.
#
# What is deliberately *not* linked: ~/.config/matugen/config.toml,
# ~/.config/matugen/templates/ and ~/.local/share/rice/poster.toml. Those look
# like configuration but are installed by `theme apply` from the active
# profile's own copies under share/themes/<name>/. Linking them would mean
# every theme switch rewrote tracked files, and the repo would show a diff for
# nothing. The profiles are the source of truth; those three are its output.
#
# Also not linked: the generated palette (colors.json, state.json,
# current-theme, gtk-colors.css, shell-theme.sh …) and your own data (todos,
# activity). Those are yours and they stay on the machine.
#
#   ./install.sh            # link everything, refusing to clobber
#   ./install.sh --force    # replace whatever is in the way, after backing it up
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

BIN="$HOME/.local/bin"
RICE="$HOME/.local/share/rice"
MATUGEN="$HOME/.config/matugen"
EXT="$HOME/.local/share/gnome-shell/extensions"

made=0 kept=0 skipped=0

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
        # Dated rather than a plain .bak, so a second --force does not eat the
        # copy the first one saved.
        local backup="$dst.pre-rice.$(date +%Y%m%d%H%M%S)"
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

echo "linking $REPO into the desktop"

for script in "$REPO"/bin/*; do
    link "$script" "$BIN/$(basename "$script")"
done

link "$REPO/matugen/extract.toml" "$MATUGEN/extract.toml"

for item in README.md lib themes art; do
    link "$REPO/share/$item" "$RICE/$item"
done

for uuid in "$REPO"/extensions/*/; do
    link "${uuid%/}" "$EXT/$(basename "$uuid")"
done

echo "$made linked, $kept already correct, $skipped skipped"

if (( skipped )); then
    echo
    echo "Some paths were left alone. Look at them, then re-run with --force." >&2
    exit 1
fi

cat <<'NEXT'

Next, on a fresh machine:

  1. Install what the rice shells out to: matugen, kitty, ImageMagick,
     python3-pil, and the GNOME extensions the themes drive (Just Perfection,
     Blur my Shell, User Themes, Rounded Window Corners Reborn, Tiling Shell,
     Dash to Dock).
  2. Enable the two extensions from this repo:
       gsettings set org.gnome.shell enabled-extensions \
         "$(gsettings get org.gnome.shell enabled-extensions | \
            sed "s/]$/, 'rice-daynight@jinho', 'rice-timeline@jinho']/")"
     then log out and back in. GNOME Shell only scans for extensions at
     startup, and on Wayland it cannot be restarted in place.
  3. Pick a look:  theme deserted     (or klein, or deserted-dark)

`theme <name>` is what actually builds the desktop: it installs that profile's
matugen templates, renders the palette, writes the chrome settings and repaints
the wallpaper. Nothing is themed until you run it once.
NEXT
