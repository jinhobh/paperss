# The rice

One palette drives the whole desktop. A generated root-window composition
combines original artwork with small, truthful system utilities; the live data
remains local.

There are three saved themes and you can switch between them freely:

| theme | what it looks like |
| --- | --- |
| `klein` | grayscale, dark, the root-window collage, micro-panel at the bottom |
| `deserted` | parchment and ink, System 7 windows and a menu bar at the top, over a painting you can cycle |
| `deserted-dark` | the same desktop unlit — espresso surfaces, cream lettering, the painting printed in negative |

`deserted` and `deserted-dark` are a **pair**: one seed, one scheme, one tint,
generated on the two sides of the lightness axis. `theme toggle` flips between
them, and so does the dot at the left end of the right-hand side of the menu
bar (see [The day/night dot](#the-daynight-dot)).

```
theme                # list themes, * marks the active one
theme deserted       # switch
theme klein          # switch back
theme toggle         # switch to the active theme's counterpart
wall                 # cycle the painting behind the deserted composition
```

## Commands

| command | what it does |
| --- | --- |
| `theme` | list saved themes |
| `theme <name>` | switch to a theme |
| `theme toggle` | switch to the active theme's counterpart (light ↔ dark) |
| `theme save <name>` | snapshot the live desktop as a new theme |
| `theme diff <name>` | show which live settings have drifted from a theme |
| `wall` | cycle to the next painting behind the composition, and repaint |
| `wall list` / `wall <name>` | show what the theme cycles through, or pick one |
| `retheme <image>` | build a palette from an image, apply it everywhere, set it as wallpaper |
| `retheme --seed '#040480'` | build the palette from a color instead |
| `retheme --relight` | re-apply the current palette (after editing a template) |
| `poster` | render today's root window to `~/Pictures/Wallpapers/jinho-poster-generated.png`, in the active theme's style |
| `poster --style deserted` | render the System 7 composition regardless of theme |
| `poster --style legacy` | render the previous large-ASCII/card composition |
| `poster --apply` | render it, set it, and retheme the desktop to match |
| `poster --drift 30` | rotate the seed hue — the desktop slowly changes over time |
| `todo` | show the task list the wallpaper paints |
| `todo <text>` | add a task (no subcommand needed) and repaint |
| `todo done 2` / `todo undo 2` | check a task off, or put it back |
| `todo rm 2` / `todo clear` | delete one, or delete everything checked off |
| `rice-status --print` | dump the day's summary the panel widget reads |
| `rice-polish` | show pending desktop-chrome changes (`--apply` / `--revert`) |

## Themes

A theme is not just a palette, so a theme profile is not just a seed color.
The System 7 look needs square corners, a light shell, an ink menu bar and a
different wallpaper composition — that is different template *text*, not
different color values plugged into the same text. So each profile in
`~/.local/share/rice/themes/<name>/` carries:

```
theme.json              palette (seed, scheme, mode, tint, paper), poster
                        style, corner radius, and the chrome settings
templates/              its own copy of ~/.config/matugen/templates/
matugen-config.toml     which templates render where
poster.toml             normalized component boxes for its composition
```

Applying one installs the templates, runs `retheme` with the recorded palette,
writes the chrome settings, and repaints the wallpaper — in that order, because
each step depends on the last. `theme save` reads the live desktop back into a
profile, so tweaking by hand and then re-saving is the normal way to edit one.

`theme diff <name>` prints anything that has drifted since. It should say
"matches" on a settled desktop; if it doesn't, something outside the rice moved
a setting.

### What a profile must NOT pin

Two settings look like chrome but are actually *derived from the palette*, and
capturing them into a profile makes the profile and the palette disagree —
whichever ran last wins, so the desktop changes on its own an hour later when
`rice-poster.timer` fires.

- **`accent-color`** is snapped from the source color by `retheme` on every
  apply. It is excluded from the captured key list entirely.
- **`global-rounded-corner-settings`** is one packed `a{sv}` holding both the
  corner radius (a theme owns that) and the border color (`retheme` derives
  that). gsettings cannot address one member, so `theme` reads the live dict,
  rewrites *only* `borderRadius`, and writes it back — leaving the freshly
  derived color intact. The radius lives in the manifest as
  `chrome.corner_radius`, and `retheme` reads it back from the active profile
  so a bare `retheme` doesn't undo it.

The general rule: if `retheme` computes it, the profile must not store it.

## The light/dark pair

`deserted` and `deserted-dark` share a seed (`#6b5a3f`), a scheme
(`tonal-spot`) and a tint (`0.75`). Only three things differ, and each one is a
place where "generate the same palette in dark mode" was not enough on its own.

**`paper` is dropped.** It is a light-mode-only compression — `retheme` skips
it when the mode is dark — so the dark profile records `0.0` rather than
carrying an inert `12.0` that would look like a setting that does something.

**The menu bar does not invert.** Every other rule in the shell stylesheet is
written in palette *roles*, so it flips on its own: paper surfaces become
espresso, ink lettering becomes cream, and the hard 2px frames that were ink
around paper are now cream around dark. The bar is the exception. Light
`deserted` paints it in `on_surface` — ink — and taking that rule into dark mode
literally swaps `on_surface` to cream and hangs a full-width `#ece1d4` strip
across the top of an otherwise dark desktop: the brightest object on the
screen, in the theme whose whole point is to stop being bright. So the dark
profile's `gnome-shell.css` paints the bar in `surface_container_high` and
closes it with a hard `outline` rule along the bottom. Still square, still flat,
still the strongest horizontal in the composition; no longer a lamp.

**The wallpaper field changes.** `deserted` sits on `griltile`, a supplied
painting. Supplied paintings are fixed-brightness images — they stay lit
whatever the palette does, which would leave the single largest surface on the
screen still bright. `deserted-dark` uses the generated `impasto` field
instead, which is built from palette roles and is the only field that actually
follows the theme down. `wall` still cycles either theme through all three.

Measured on the dark palette: panel text 11.2:1, body text 14.3:1, secondary
text 10.9:1, `primary` on a surface 10.8:1 — AAA across the board, which is the
easy direction. It is the light cut that has to watch its contrast, and that is
what the `--paper` note below is about.

### Why the ramp flips for a dark palette

The impasto field is painted by mapping the source drawing's luminance through
a ramp built from palette roles. The drawing is ink on white paper, so the bulk
of it lands at the top of that index — which means the top of the ramp is what
the field is mostly *made of*, and it has to be whatever the palette calls "the
surface you put things on". Sorting the stops by luminance always puts the
palette's lightest tone there, so the dark theme's wallpaper came out the same
cream as the light theme's and the whole switch looked like it had not taken.
`ramp_lut` now reverses for a dark palette: the paper of the drawing reads as
the dark field, its ink as the marks on top. The same painting, in negative.

The dark stop set is deliberately *not* the light set reversed. It stops short
of `on_surface` and thickens the field end with two more container tones,
because a dark palette's brightest role is near-white while a light one's
darkest is a soft brown — an even mirror puts white where the light theme has
only a gentle olive, and the drawing's ink mass (not sparse at all, once the
noise octaves have smeared it) comes back as white blooms over a third of the
screen.

### The role names `colors.json` actually publishes

`colors.json` publishes Material's container roles under short names —
`surface_lowest`, `surface_high` — while the M3 spelling is
`surface_container_lowest`. `poster` asked for the long names, so those lookups
returned their hardcoded defaults *every time*. It went unnoticed for as long as
both the defaults and the palette were cream: the light theme wanted roughly
those values anyway. Dark mode is where it showed, as three hardcoded light
stops in an otherwise dark ramp and System 7 windows still papered in `#f2efe2`.
`poster`'s `role()` helper now accepts either spelling.

One visible consequence for the light theme: its plates are now the palette's
real `surface_lowest` (`#dddbc4`) instead of the brighter hardcoded `#f2efe2`,
so they sit closer to the field than they used to. Against `griltile` — a real
painting with a wide range — they still read clearly on their ink borders. If
you ever want the old floating-paper effect back on a *flat* field, that is the
value to raise.

### Why `poster` follows the theme

`rice-poster.timer` runs a bare `poster --apply` hourly and `todo` repaints with
a bare `poster`. Neither knows which theme is active, so `poster` resolves its
style from `~/.local/share/rice/current-theme` when `--style` isn't given.
Without that the wallpaper reverted to the collage within the hour of switching.

For the same reason `poster --apply` passes `--mode` and `--paper` through to
`retheme` alongside the seed. It used to pass only the seed, scheme and tint,
which re-derived a *dark, uncompressed* palette from the light theme's seed —
silently undoing the theme while leaving the wallpaper correct.

And for the same reason again, `theme apply` writes `current-theme` *before* it
runs `poster`, not after. `poster` resolves everything it wasn't told
explicitly from that file, so painting first meant painting the **previous**
theme's wallpaper. That stayed invisible while the two themes' compositions
differed enough for `--style` to cover the gap, and appeared the moment two
profiles shared a style and differed only in which field they select — the
light/dark pair. By the time the poster step runs, the palette and the chrome
are already the new theme's, so that is simply when the switch has happened.

## The day/night dot

`rice-daynight@jinho` puts one 7px dot in the menu bar, at the left end of the
right-hand group — past the clock, before the system indicators anyone actually
aims for. Clicking it runs `theme toggle`. It is hollow while a light theme is
applied and filled once a dark one is, drawn in the same role the panel's own
lettering uses, at 42% alpha rising to 95% on hover. That is the whole
extension: no menu, no settings, no panel label.

It follows the files rather than only its own clicks — `current-theme` and
`colors.json` are both watched — so running `theme` in a terminal or letting the
hourly poster timer fire keeps the dot honest. A switch takes a couple of
seconds, during which the dot dims and further clicks are ignored rather than
queued; the second press of an impatient double-click would otherwise switch
straight back.

**Installing it needs a logout.** GNOME Shell scans the extensions directory
once at startup and has no runtime rescan — `ReloadExtension` over D-Bus
answers *"deprecated and does not work"* — and on Wayland the shell cannot be
restarted in place. The UUID is already in
`org.gnome.shell enabled-extensions`, so it comes up with the next session.
Editing the extension later has the same constraint, for the reason described
in the GJS module cache: disable/enable does not re-import a changed file.

## How a retheme flows

```
image or seed color
   |
   v
matugen  ──►  raw Material You scheme (JSON)
   |
   v
tint stage  ──►  surfaces rotated toward the source hue at constant lightness
   |            + semantic red/green/yellow synthesized at fixed hues
   v
matugen  ──►  renders every template
   |
   +── ~/.config/kitty/matugen-theme.conf     (kitty.conf includes this)
   +── ~/.local/share/rice/gtk-colors.css     (libadwaita named colors, shared)
   +── ~/.config/gtk-4.0/gtk.css              (@imports the shared colors)
   +── ~/.config/gtk-3.0/gtk.css              (   ditto, + window corner radius)
   +── ~/.themes/Rice/gnome-shell/gnome-shell.css   (top bar + dock borders)
   +── ~/.config/fastfetch/config.jsonc
   +── ~/.config/bat/themes/rice.tmTheme      (post_hook: bat cache --build)
   +── ~/.local/share/rice/shell-theme.sh     (eza/bat/fzf env, sourced by .bashrc)
   +── ~/.local/share/rice/colors.{sh,json}   (for scripts and the widget)
   +── ~/.config/nvim/lua/config/rice-palette.lua
   |
   v
retheme also sets:  GNOME accent · wallpaper · starship's palette block
                    Tiling Shell window border · shell theme reload
```

### Why the tint stage exists

Material You always renders dark-mode surfaces as near-black no matter what
seed you give it. A Klein-blue wallpaper produced a `#131318` desktop — the
identity was thrown away. The tint stage blends surface colors toward the
source hue on the **a/b chroma axes only**, never touching lightness, so the
field carries the color while every contrast pairing M3 computed still holds.
Verified at tint 0.75: all foreground/background pairs are WCAG AA or better.

`--tint 0` gives you stock Material You. Default is `0.6`.

### Why the paper stage exists

The exact mirror of the same problem, in the other mode. Material You pins
*light*-mode surfaces to near-white (L\* 96-99) no matter what the seed is, so
the parchment seed the `deserted` theme uses still rendered a white desktop.
`--paper N` pulls the surface family down the lightness axis only — chroma
untouched, so the hue the tint stage just established survives — by a
proportional amount, which moves the near-whites a lot and leaves the
already-mid containers nearly alone. `deserted` uses `--paper 12`.

Foregrounds are deliberately not moved, since lowering the field only reduces
contrast. Measured at 12 on seed `#6b5a3f`: every `on_surface` pairing is AAA
(9.8:1 worst), every `on_surface_variant` pairing is AA (5.4:1 worst), and
`primary` lands at 3.7-4.6:1 — AA for large text only, down from ~4.9:1
uncompressed. That is an accent role, not a body-text one. If a future theme
sets small body text in `primary`, lower the value rather than assume it holds.

### Why the semantic colors clamp their lightness

The synthesized `rice_red` / `rice_green` / `rice_yellow` borrow lightness and
chroma from `primary` so they read as part of the set. That breaks at the ends
of the L axis, where no chroma can survive: the `monochrome` scheme the klein
theme uses returns a `primary` of pure `#ffffff`, and red/green/yellow built at
L\* 100 clamped to near-white pastels (`#ffe8e4`, `#d2ffd7`) that were
indistinguishable in a terminal. `SEMANTIC_L` clamps the borrowed lightness
into a band that can actually carry color. Ordinary palettes already land
inside it and are unaffected — the deserted theme's values are identical either
way.

### Why the accent snaps from `source_color`

GNOME only accepts ten named accent values. M3 primaries are pale pastels
whose chroma is too low to match any of them, so they all collapsed onto
`slate`. Snapping from the source color instead keeps the hue.

## Borders

Three surfaces get an outline, by two different mechanisms.

**Windows** — Mutter on Wayland has no server-side window border, and GTK CSS
only reaches native GTK windows, so this needs a compositor-level extension.
`retheme`'s `set_window_border()` prefers **Rounded Window Corners Reborn**
(`rounded-window-corners@fxgn`) and falls back to Tiling Shell's border if it
isn't installed.

Reborn owns *both* the corner clip and the border, and the two must stay with
one extension: it draws the border along its own clip path, so they always
agree. Tiling Shell's border instead traces each window's *native* radius —
which for kitty is square at the bottom no matter what the clipper does. Having
both on gives a double line. `set_window_border()` therefore turns Tiling
Shell's border off whenever Reborn is present.

    org.gnome.shell.extensions.rounded-window-corners-reborn
      global-rounded-corner-settings   borderRadius 2 · borderColor <outline>
      border-width 1 · tweak-kitty-terminal true · skip-libadwaita-app false

`global-rounded-corner-settings` is a packed `a{sv}`; gsettings can't update one
member, so `set_rounded_corners()` rewrites the whole dict. `borderColor` is
`[r, g, b, a]` floats, not hex. Radius 2 gives the root-window theme almost
square workstation frames. `skip-libadwaita-app` is **false**
on purpose — left true, libadwaita apps would round themselves but be the only
windows without a border. Maximized and fullscreen stay square.

`tweak-kitty-terminal` exists because kitty needs special handling (see below);
without it kitty's corners stay square.

**Bottom micro-panel and dock** — from the generated `Rice` shell theme, loaded
by the `user-theme` extension. Just Perfection moves the panel to the bottom
and reduces it to 20px. Its transparent fill merges with the root background;
Blur My Shell is disabled for the panel. Ubuntu Dock remains autohidden and
loses its fill, border, and rounded pill.

### Window corners, and why GTK3 and GTK4 split

Corner radius is per-toolkit, and no single stylesheet reaches every app.

Adwaita's **GTK3** decoration is `border-radius: 8px 8px 0 0`: rounded top,
square bottom. GTK4/libadwaita already rounds all four at 12px.

**kitty is not a GTK app.** Version 0.47 on Wayland draws its own decorations
through its bundled GLFW backend — `/proc/<pid>/maps` shows
`kitty.glfw-wayland.so` and neither libgtk nor libdecor. No GTK stylesheet can
reach its corners, and kitty exposes no corner-radius option
(`window_border_width` is for its internal splits). Rounding kitty's window
requires the compositor-level clipper described above, which shapes every
window regardless of toolkit.

Newly installed extensions are not loaded until the shell restarts, and on
Wayland that means a **log out and back in** — `gnome-extensions info` will
report "doesn't exist" until then even though the files are in place and the
gsettings keys are already written.

Because the two toolkits need different rules but the same colors, the color
block is generated once to `~/.local/share/rice/gtk-colors.css` and each
toolkit's `gtk.css` `@import`s it. Only `gtk3.css` carries the radius override.
Tiled, maximized and fullscreen windows are excluded — they sit flush against
an edge, where a rounded corner shows a notch of whatever is behind.

GTK reads the CSS at window creation, so a GTK3 app must be restarted to pick
up a radius change; a `retheme` alone won't do it.

### The shell theme reload trick

GNOME Shell only re-reads its stylesheet when the theme *name* changes, and on
Wayland the shell can't be restarted. `reload_shell_theme()` therefore sets
`name` to `''` and back to `'Rice'` — that forces a reparse in place. The
journal shows both steps:

    loading default theme (Adwaita)
    loading user theme: /home/jinho/.themes/Rice/gnome-shell/gnome-shell.css

If the bar looks unchanged after a retheme, a CSS syntax error made the shell
fall back silently. Check:

    journalctl --user -b | grep -iE 'stylesheet|user theme'

## The root-window collage

`poster` uses Pillow to compose a 3840x2400 wallpaper. Normalized component
positions live in `~/.local/share/rice/poster.toml`. Original and deterministic
two-tone artwork lives under `~/.local/share/rice/art/{source,processed}`.

The default `collage` layout contains:

- a real system-information utility sourced from `/proc` and `/etc/os-release`;
- an unframed lower-left ink artwork and a framed detail crop;
- a small task utility sourced from `todos.json`, whose window grows downward to
  fit the open tasks — `h` in `poster.toml` is its floor, `max_h` the ceiling
  that keeps it clear of the focus plot below;
- a recent-activity utility combining repository edits and application focus;
- a compact 24-hour focus plot.

Repository names are ordinary activity rows; they never become mastheads or
control the artwork. `poster --style legacy` preserves the former large ASCII
art, TODO card, ribbon, footer, and monogram. Output replacement is atomic.

## The deserted composition

The `deserted` style repaints the same ink artwork as an oil painting and draws
the same truthful utilities over it as System 7 program windows: a `>fetch`
panel with the live palette as a swatch strip, a calendar, recent activity as a
scroll of timestamped entries on ruled paper, the task list, and the 24-hour
focus plot.

The painting is generated, not sourced. `impasto_tile()` lays down ~150k short
strokes whose direction follows the **perpendicular of the local luminance
gradient** — the direction the form runs in, which is what makes the marks comb
around shapes rather than hatch across them. Flat areas have no meaningful
gradient, so they fall back to a slowly drifting base angle; that is what gives
the field its cloud-like sweep. Each stroke gets a thinner, lighter second pass
offset a pixel or two toward the light: two flat lines that close together read
as a ridge of raised paint, far cheaper than building a height field and
lighting it.

Two things about the source matter. It is a sparse ink drawing — near-pure
black on near-pure white — so its range is compressed to roughly 58-238 first,
turning the subject into a soft mass the brushwork can sit inside instead of
hard blobs of pigment floating in a void. And its paper is 80% empty, so three
octaves of smooth value noise are blended in to give the sky something to be
made of.

The field is tiled offset by half a tile, so one *whole* tile lands dead centre
and the seams fall on the quarter lines. Painting it takes a couple of seconds,
which is too slow for an hourly job, so it is cached to
`art/processed/impasto-field.png` under a key made from the palette ramp and the
source file's mtime — only the windows are redrawn on a normal run. The key is
compared against its own JSON round-trip, so it stores **lists, not tuples**;
json has no tuple, and a tuple there never matches what comes back, which
repaints the field on every single switch.

### Cycling the painting

`wall` changes only the **background layer**. The live utilities stay drawn over
it, which is the point — swapping to a bare image would throw the rice away.
The choice is written to the active theme's own manifest under
`poster.field`, so each theme remembers what it was cycled to and `theme
<name>` restores it. `poster` reads it back, so the hourly timer keeps it too.

The list lives at `poster.fields`, and the images at `art/wallpapers/`:

```
{"name": "impasto",  "source": "impasto",          "mode": "tile"}
{"name": "griltile", "source": "griltile.png",     "mode": "tile",
                     "anchor": [0.13, 0.45]}
{"name": "coast",    "source": "coast-sunset.png", "mode": "fill"}
```

`source: impasto` is the generated field. `tile` repeats the image so one whole
copy lands with its centre on `anchor`; `fill` covers the canvas with a single
copy, for images that are one scene rather than a repeatable panel.

**`anchor` is not decoration.** The windows sit in fixed places, and the default
puts a painting's subject at 0.5, 0.5 — exactly where the fetch and activity
windows meet, so the subject ends up completely hidden behind them. Composing a
specific painting against the layout means moving the tile, not the windows.

A missing or unreadable image falls back to the generated field with a note on
stderr rather than failing the render, since this runs from a timer.

### Why the focus plot has a plate

It used to be drawn straight onto the paint — the one element with no frame.
That worked only because the generated impasto field is light everywhere by
construction. Once the background could be any supplied painting the assumption
broke: on the coast image it landed on dark water and vanished. It now sits on
a minimal paper plate, with no title bar or controls so it stays the quietest
thing on the desktop.

### Glyphs

Window controls are drawn from whatever glyphs the mono font actually has.
FiraCode has `∨` and `∧` but not `✕`, and a missing codepoint still renders — as
the hollow `.notdef` box, with a normal advance width — so presence cannot be
tested by measuring. `has_glyph()` renders the candidate and compares the
bitmap against a Plane 16 private-use codepoint no text font defines.

Regenerated hourly by `rice-poster.timer`; `todo` mutations repaint immediately.

## The task list

`todo` edits `~/.local/share/rice/todos.json` and repaints the wallpaper on
every change. Open tasks sort above completed ones; the numbers `todo` prints
are display positions, not stable ids, so they shift as things get checked off
— print the list before acting on it.

Repainting just rewrites the PNG. The shell keeps a file monitor on the
wallpaper, so replacing the file is enough to make it reload and crossfade —
the URI is only re-set when something else has taken the background over.

Do not "force" a reload by clearing `picture-uri` first. The shell resolves an
empty URI against the working directory (`Failed to load background
'file:///home/jinho': Is a directory`), and that failure throws inside
`_updateBackgroundActor` — the very function that swaps in the new actor — so
the repaint is abandoned and the stale image stays up.

Use `todo -q` to skip the repaint when scripting a batch of edits; the hourly
timer will catch up.

```
systemctl --user status rice-poster.timer
systemctl --user start rice-poster.service   # force one now
```

## The panel widget

`rice-timeline@jinho` shows a live workspace selector plus a 12-cell sparkline
and current focus streak in the bottom micro-panel. Clicking the workspace
indicator switches workspaces; clicking activity lists per-app time and offers
"Regenerate wallpaper".

GNOME Shell can't read SQLite, so `rice-status` writes `status.json` and the
extension watches that file. Colors come from the palette, so it retints itself.

## now/playing

The same extension draws a media element **on the root window** — a tag, the
track title in Playfair, the artist, a time reading and a progress hairline.
No album art, no controls, no frame. It is absent whenever nothing is playing,
fades in when a player starts, dims to half strength while paused, and fades
out when the last player stops or quits.

It is not painted into the poster. The PNG is regenerated hourly; playback
changes every few minutes and the bar has to move every second, so baking it in
would mean re-rendering and re-setting the wallpaper constantly. Instead the
element is a Clutter actor parked in the shell's **background group**, which
puts it above the wallpaper and below every window — so it behaves exactly like
a painted component of the collage, and disappears under whatever you open.

- `player.js` is the widget; `mpris.js` is the bus half, kept free of St and
  shell imports so it can be exercised headlessly under plain `gjs`.
- Any `org.mpris.MediaPlayer2.*` player is picked up, tracked through a single
  `MATCH_ARG0_NAMESPACE` subscription. When several are alive, the one that
  most recently started playing wins; stopped players count as absent.
- Position is not a cached MPRIS property, so it is fetched once a second —
  only while something is actually playing and the element is on screen.
- Its position, `BOX` in `player.js`, is on the same normalized grid as
  `poster.toml`: the empty column under `~/recent`, clear of the ink art.
  Colors are read from `colors.json` and re-read when a retheme rewrites it.
- A wallpaper repaint makes the shell add a fresh background actor to that
  group, which would stack over the element — so it re-raises itself on
  `child-added`.
- Set `HIDE_WHEN_PAUSED = true` in `player.js` to have a pause hide it outright
  rather than dim it.

**Shell restarts:** GJS caches extension modules for the life of the process,
so editing these files and re-enabling the extension does nothing — the old
module is still resident. Changes need a full shell restart, which on Wayland
means logging out and back in.

## Layout

```
~/.config/matugen/config.toml       template targets
~/.config/matugen/extract.toml      template-free config for the extraction pass
~/.config/matugen/templates/        one file per target
~/.local/bin/{theme,wall,retheme,poster,todo,rice-status,rice-polish}
~/.local/share/rice/art/wallpapers/  paintings the deserted theme cycles
~/.local/share/rice/themes/<name>/  saved themes (see Themes above)
~/.local/share/rice/current-theme   the active theme's name
~/.local/share/rice/poster.toml     normalized component boxes for the active style
~/.local/share/rice/art/            source and deterministic processed art
~/.local/share/rice/lib/ricedata.py shared timeline queries
~/.local/share/rice/state.json      last applied palette
~/.local/share/rice/polish-backup.json   previous chrome values, for --revert
~/.local/share/gnome-shell/extensions/rice-timeline@jinho/
    extension.js                    panel widgets + root-window player
    player.js                       the now/playing element
    mpris.js                        bus half, testable outside the shell
```

## Undoing things

- `theme klein` — the whole desktop back to the dark collage, palette, chrome
  and wallpaper together. `theme <name>` is reversible in both directions and
  is the intended way to undo a look.
- `rice-polish --revert` — restores the exact previous gtk-theme, icons, fonts,
  blur and animation values.
- `~/.config/kitty/kitty.conf.pre-rice` and `starship.toml.pre-rice` are the
  originals from before the first run.
- `~/.config/kitty/hermes-theme.conf` is kept as a static preset; point
  `kitty.conf`'s `include` back at it to pin the old fixed Klein theme.
  `~/.config/bat/themes/hermes-klein.tmTheme` is the matching bat preset — set
  `BAT_THEME=hermes-klein` after the `shell-theme.sh` source line in `.bashrc`.
- Borders off: set `enable-window-border false` (Tiling Shell) and the
  `user-theme` `name` key to `''` for the stock top bar.

## Terminal apps

`shell-theme.sh` carries the colors that eza, bat, and fzf read from the
environment rather than a config file. `.bashrc` sources it early in the
"Modern CLI layer" block; the per-tool blocks below it no longer hardcode any
hex values.

bat resolves a theme by **filename** (`themes/rice.tmTheme` → `BAT_THEME=rice`),
not the `<name>` key inside the plist.

fastfetch's config is JSON, so a literal ESC byte in a format string is a parse
error — colors go in the module's `outputColor` field as a bare SGR triple
(`38;2;R;G;B`).

Neovim: `colors/rice.lua` is a real colorscheme file (LazyVim's
`opts.colorscheme` needs one to exist) that feeds the generated
`lua/config/rice-palette.lua` into `mini.base16`, which expands 16 colors into
the full highlight set. lualine uses `theme = "auto"` so it follows.
