import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const HOME = GLib.get_home_dir();
const BIN = `${HOME}/.local/bin`;
const RICE = `${HOME}/.local/share/rice`;
const CURRENT = `${RICE}/current-theme`;
const PALETTE = `${RICE}/colors.json`;

// Small enough to read as punctuation rather than a control. The dot is hollow
// while a light theme is applied and filled once a dark one is, which is the
// whole of its state: you are not meant to notice it until you look for it.
const DOT = 7;

// A switch runs retheme, repaints the wallpaper and reloads the shell
// stylesheet, which takes a couple of seconds. Clicks are ignored until it
// finishes rather than queued — the second press of an impatient double-click
// would otherwise switch straight back.
const BUSY_OPACITY = 90;

/** '#rrggbb' -> 'rgba(r, g, b, a)', so one palette color can carry an alpha. */
function rgba(hex, alpha) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    if (!m)
        return `rgba(255, 255, 255, ${alpha})`;
    const [r, g, b] = m.slice(1).map(h => parseInt(h, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default class DayNightExtension extends Extension {
    enable() {
        this._busy = false;

        this._button = new PanelMenu.Button(0.0, 'Day / Night', true);
        this._button.accessible_name = 'Switch between the light and dark theme';

        this._dot = new St.Widget({
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            width: DOT,
            height: DOT,
        });
        // A bin around the dot so the click target is the full height of the
        // bar. The dot itself is 7px; asking anyone to hit that is a different
        // kind of minimal from the one intended.
        const bin = new St.Bin({
            child: this._dot,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0 9px;',
        });
        this._button.add_child(bin);

        this._pressId = this._button.connect('button-press-event',
            () => this._toggle());
        this._keyId = this._button.connect('key-press-event', (_a, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter ||
                sym === Clutter.KEY_space)
                return this._toggle();
            return Clutter.EVENT_PROPAGATE;
        });
        this._hoverId = this._button.connect('notify::hover', () => this._paint());

        // Left-most in the right-hand box: at the quiet end of the bar, past
        // the clock, before the system indicators anyone actually aims for.
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

        // `theme` can also be run from a terminal, and the hourly poster timer
        // rewrites the palette, so the dot follows the files rather than only
        // its own clicks.
        this._monitors = [];
        for (const path of [CURRENT, PALETTE]) {
            try {
                const monitor = Gio.File.new_for_path(path)
                    .monitor_file(Gio.FileMonitorFlags.NONE, null);
                const id = monitor.connect('changed', () => this._paint());
                this._monitors.push({monitor, id});
            } catch (e) {
                logError(e, `rice-daynight: could not watch ${path}`);
            }
        }

        this._paint();
    }

    disable() {
        for (const {monitor, id} of this._monitors ?? []) {
            monitor.disconnect(id);
            monitor.cancel();
        }
        this._monitors = null;

        for (const id of [this._pressId, this._keyId, this._hoverId]) {
            if (id)
                this._button?.disconnect(id);
        }
        this._pressId = this._keyId = this._hoverId = null;

        this._button?.destroy();
        this._button = null;
        this._dot = null;
    }

    /** The palette on disk, or null while it is mid-write. */
    _palette() {
        try {
            const [ok, bytes] = GLib.file_get_contents(PALETTE);
            if (!ok)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            return null;
        }
    }

    _paint() {
        if (!this._dot)
            return;
        const palette = this._palette() ?? {};
        const dark = palette.mode === 'dark';

        // Both themes hang a dark bar across the top, so in both the dot has to
        // be the light one of the pair — the same role the panel's own
        // lettering is drawn in, which is how it stays part of the bar instead
        // of sitting on it.
        const ink = (dark ? palette.on_surface : palette.surface_lowest) ??
            '#ece1d4';

        const alpha = this._busy ? 0.30 : (this._button?.hover ? 0.95 : 0.42);
        // Filled once it is dark, hollow while it is light: the dot is a tiny
        // picture of which half of the pair you are in. The empty fill is
        // spelled rgba(0,0,0,0) rather than `transparent`, which St's CSS
        // parser does not accept as a color keyword.
        this._dot.set_style(
            `border: 1px solid ${rgba(ink, alpha)};` +
            `border-radius: ${DOT}px;` +
            `background-color: ${dark ? rgba(ink, alpha) : 'rgba(0, 0, 0, 0)'};`);
        this._button.opacity = this._busy ? BUSY_OPACITY : 255;
    }

    _toggle() {
        if (this._busy)
            return Clutter.EVENT_STOP;
        this._busy = true;
        this._paint();

        try {
            // PATH is set explicitly because `theme` shells out to `retheme`,
            // `poster` and `kitty` by bare name. The session manager happens to
            // export ~/.local/bin today; a button that silently stops working
            // if that ever changes is worse than one extra line here.
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_SILENCE |
                       Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.setenv('PATH', `${BIN}:${GLib.getenv('PATH') ?? ''}`, true);

            const proc = launcher.spawnv([`${BIN}/theme`, 'toggle']);
            proc.communicate_utf8_async(null, null, (p, res) => {
                let stderr = '';
                try {
                    [, , stderr] = p.communicate_utf8_finish(res);
                } catch (e) {
                    logError(e, 'rice-daynight: theme toggle');
                }
                if (!p.get_successful())
                    console.warn(`rice-daynight: theme toggle failed: ${stderr.trim()}`);
                this._busy = false;
                this._paint();
            });
        } catch (e) {
            logError(e, 'rice-daynight: could not run theme toggle');
            this._busy = false;
            this._paint();
        }
        return Clutter.EVENT_STOP;
    }
}
