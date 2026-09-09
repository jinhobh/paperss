# Paperss

Paperss is a keyboard-first wallpaper switcher for Hyprland. It previews a
curated wallpaper collection, applies the selected image through `swaybg`, and
derives a matching desktop palette from the same image.

Press **Super+Shift+Tab** to open the selector. Keep tapping the shortcut, use
Tab/Shift+Tab or the arrow keys to move, then release Super or press Enter to
apply. Escape cancels.

## What it does

- GTK 4 fullscreen preview strip with cached, asynchronous thumbnails.
- `swaybg` wallpaper application through Hyprland.
- Material You palette extraction through Matugen.
- Per-wallpaper saved color profiles, so returning to an image restores its
  previous palette instead of re-extracting it.
- Automatic color updates for:
  - Hyprland
  - GTK 3 and GTK 4
  - Kitty
  - Waybar
  - Wofi
  - Mako
  - Firefox/Re:fox and pywalfox when installed
  - Spotify/Spicetify when installed

There is no GNOME Shell integration or theme-profile system in this project.

## Commands

```sh
wallpaper-selector                 # open the preview selector
retheme ~/Pictures/wallpaper.png   # apply an image and derive its palette
retheme --relight                  # re-apply the last palette
retheme --seed '#284d5d'           # derive a palette without extracting an image
hypr-reload                        # regenerate live client files from colors.json
```

The selector is normally launched by this Hyprland binding:

```ini
bind = $mainMod SHIFT, Tab, exec, wallpaper-selector
```

Set `RICE_WALLPAPER_DIR` to use a different wallpaper directory. Otherwise the
selector reads `~/Pictures/Wallpapers`.

## Palette flow

```text
selected image
     │
     ├──► saved profile lookup
     │
     ▼
retheme ──► Matugen extracts a Material You palette
     │
     ├──► tint and accessibility adjustments
     ├──► GTK 3/4 and Kitty templates
     └──► colors.json
                    │
                    ▼
             hypr-reload
                    │
                    ├──► Hyprland
                    ├──► Waybar, Wofi, Mako
                    ├──► Firefox/Re:fox and pywalfox
                    ├──► Spotify/Spicetify
                    └──► swaybg
```

`retheme` writes the selected wallpaper and palette state before invoking
`hypr-reload`, so the wallpaper and generated colors change as one operation.

## Saved profiles and cache

Runtime state intentionally stays outside the repository:

```text
~/.local/share/rice/state.json
~/.local/share/rice/colors.json
~/.local/share/rice/wallpaper-themes.json
~/.cache/rice/wallpaper-thumbnails/
```

The `rice` state directory name is retained for compatibility with existing
Hyprland and user configuration paths. Each wallpaper profile stores its
palette seed, Matugen scheme, light/dark mode, tint, and paper settings.
Thumbnail cache entries are invalidated when the source file changes.

## Installation

```sh
git clone https://github.com/jinhobh/paperss.git ~/paperss
cd ~/paperss
./install.sh
```

The installer symlinks the three commands and the Matugen configuration into
the locations used by the desktop. Use `./install.sh --force` to move existing
non-symlink files aside with a dated backup.

Required runtime pieces:

- Python 3
- `python3-gi`, `python3-cairo`
- GTK 4 introspection data
- Matugen
- `swaybg`
- Hyprland
- Kitty, Waybar, Wofi, and Mako

Firefox/Re:fox, pywalfox, and Spicetify are optional integrations. If they are
not installed, their update steps are skipped.

## Repository layout

```text
bin/wallpaper-selector       GTK 4 preview and selection UI
bin/retheme                  palette extraction and profile application
bin/hypr-reload              generated client files and swaybg bridge
matugen/config.toml          tracked Matugen target configuration
matugen/extract.toml         template-free extraction configuration
matugen/templates/           GTK, Kitty, and colors.json templates
install.sh                   symlink installer
```
