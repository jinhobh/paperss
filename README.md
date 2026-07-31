# rice

One palette drives a whole GNOME desktop. A seed color — or an image — becomes
the terminal, the GTK apps, the shell chrome, the window borders and a
generated root-window composition, all from a single command.

Three saved looks, switchable at any time:

| theme | what it looks like |
| --- | --- |
| `klein` | grayscale, dark, a root-window collage, micro-panel at the bottom |
| `deserted` | parchment and ink, System 7 windows and a menu bar at the top, over a painting you can cycle |
| `deserted-dark` | the same desktop unlit — espresso surfaces, cream lettering, the painting printed in negative |

`deserted` and `deserted-dark` are a pair: one seed, one scheme, one tint,
generated on the two sides of the lightness axis. `theme toggle` flips them, and
so does a 7px dot in the menu bar.

```
theme                  # list themes, * marks the active one
theme deserted         # switch
theme toggle           # switch to the active theme's counterpart
retheme <image>        # build a palette from an image and apply it everywhere
poster                 # repaint the root window
wall                   # cycle the painting behind the deserted composition
todo <text>            # add a task; the wallpaper paints the list
```

**[share/README.md](share/README.md) is the real documentation** — how a
retheme flows, why the tint and paper stages exist, what a theme profile may
and may not pin, and the traps that are easy to reintroduce.

## Install

```sh
git clone <this repo> ~/rice && ~/rice/install.sh
```

`install.sh` symlinks this checkout into the paths the desktop reads from, and
prints what else you need. It refuses to clobber anything that isn't already a
link into the repo; `--force` moves the obstruction aside with a dated backup
first.

## Layout

```
bin/                 the commands: theme, retheme, poster, wall, todo, …
matugen/             extract.toml — the template-free config retheme's first pass uses
share/README.md      the long documentation
share/lib/           shared python the commands import
share/themes/<name>/ a theme profile: palette, poster style, chrome settings,
                     and its own copy of the matugen templates
share/art/           source artwork and the paintings the deserted theme cycles
extensions/          two small GNOME Shell extensions
```

### What is here and what is not

A theme is not just a palette, so a profile is not just a seed color. Each one
under `share/themes/` carries its own `templates/` — the System 7 look needs
square corners, a light shell and an ink menu bar, and that is different
template *text*, not different values plugged into the same text.

Which is why three live paths are **not** tracked, even though they look like
configuration: `~/.config/matugen/config.toml`, `~/.config/matugen/templates/`
and `~/.local/share/rice/poster.toml`. `theme apply` installs all three from
the active profile every time you switch. They are output, not input — tracking
them would mean every theme switch produced a diff that said nothing.

Also not tracked, and staying on the machine where they belong: the generated
palette (`colors.json`, `state.json`, `current-theme`, the rendered GTK and
shell CSS) and your own data — the todo list and the activity summaries the
wallpaper paints. The composition is in the repo; what it happens to say about
today is not.
