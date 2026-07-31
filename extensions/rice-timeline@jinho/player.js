/* now/playing — a frameless media utility drawn onto the root window.
 *
 * It lives in the shell's background group, so it sits on the wallpaper and
 * under every window, exactly like the painted components of the collage. The
 * poster is a static PNG regenerated hourly; playback state changes far too
 * often for that, so this element is drawn live instead of baked in. Its
 * position comes from the same normalized grid as poster.toml — the empty
 * column under `~/recent`, clear of the ink art's tail.
 *
 * Nothing is shown unless something is actually playing. No album art, no
 * controls, no frame: a tag, a title, a byline, and a progress hairline.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Pango from 'gi://Pango';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {MprisWatcher, MPRIS_PATH, PLAYER_IFACE} from './mpris.js';

const HOME = GLib.get_home_dir();
const COLORS = `${HOME}/.local/share/rice/colors.json`;

// Fractions of the primary monitor, on poster.toml's grid.
const BOX = {x: 0.39, y: 0.655, w: 0.26};

// A paused track is still music, so it stays on the wall — dimmed, because the
// dimming reads as "paused" without adding a second glyph. Flip this to true to
// have a pause hide the element outright.
const HIDE_WHEN_PAUSED = false;

const FADE_MS = 400;
const SWAP_MS = 220;
const FULL = 255;
const DIM = 130;

const FALLBACK = {
    on_surface: '#e2e2e2',
    outline: '#919191',
    outline_variant: '#474747',
};

function usToLabel(us) {
    const total = Math.max(0, Math.floor(us / 1e6));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const pad = v => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}


/* ------------------------------------------------------------------- widget */

export class RootPlayer {
    constructor() {
        this._colors = {...FALLBACK};
        this._trackId = null;
        this._visible = false;
    }

    enable() {
        this._group = Main.layoutManager._backgroundGroup;
        if (!this._group) {
            log('rice-player: no background group on this shell; skipping');
            return;
        }

        this._build();
        this._group.add_child(this._actor);
        this._place();

        // Every wallpaper repaint (the poster timer, `todo`, a retheme) makes
        // the shell add a fresh background actor to this group, which would
        // otherwise be stacked over us. Re-raise on the next idle instead of
        // inside the signal, so a burst of adds costs one reorder.
        this._childAddedId = this._group.connect('child-added', () => this._queueRaise());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());

        this._readColors();
        try {
            this._colorFile = Gio.File.new_for_path(COLORS);
            this._colorMonitor = this._colorFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._colorId = this._colorMonitor.connect('changed', () => {
                this._readColors();
                this._paint();
            });
        } catch (e) {
            logError(e, 'rice-player: could not watch the palette');
        }

        this._watcher = new MprisWatcher(state => this._update(state));
        this._watcher.start();
    }

    disable() {
        this._watcher?.stop();
        this._watcher = null;

        if (this._colorMonitor) {
            if (this._colorId)
                this._colorMonitor.disconnect(this._colorId);
            this._colorMonitor.cancel();
            this._colorMonitor = null;
            this._colorId = null;
        }
        if (this._childAddedId) {
            this._group.disconnect(this._childAddedId);
            this._childAddedId = null;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = null;
        }
        if (this._raiseId) {
            GLib.source_remove(this._raiseId);
            this._raiseId = null;
        }
        this._stopTicking();
        this._actor?.destroy();
        this._actor = null;
        this._group = null;
    }

    /* ---------------------------------------------------------- construction */

    _build() {
        this._actor = new St.BoxLayout({
            vertical: true,
            opacity: 0,
            visible: false,
            reactive: false,
        });

        this._tag = new St.Label({text: 'now/playing'});
        this._title = new St.Label();
        this._artist = new St.Label({x_expand: true});
        this._time = new St.Label({x_align: Clutter.ActorAlign.END});

        for (const label of [this._title, this._artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.single_line_mode = true;
        }

        const byline = new St.BoxLayout({vertical: false});
        byline.add_child(this._artist);
        byline.add_child(this._time);

        // Two flat rules, one over the other: the unplayed remainder and the
        // elapsed fill. Same hairline weight as the collage's box outlines.
        this._track = new St.BoxLayout({vertical: false, height: 1});
        this._fill = new St.Widget({height: 1, width: 0});
        this._track.add_child(this._fill);

        this._actor.add_child(this._tag);
        this._actor.add_child(this._title);
        this._actor.add_child(byline);
        this._actor.add_child(this._track);
    }

    _place() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || !this._actor)
            return;
        this._width = Math.round(BOX.w * mon.width);
        this._actor.set_position(
            Math.round(mon.x + BOX.x * mon.width),
            Math.round(mon.y + BOX.y * mon.height));
        this._actor.set_width(this._width);
        this._track.set_width(this._width);
        this._paint();
    }

    _queueRaise() {
        if (this._raiseId)
            return;
        this._raiseId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._raiseId = null;
            if (this._actor && this._group)
                this._group.set_child_above_sibling(this._actor, null);
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ----------------------------------------------------------------- paint */

    _readColors() {
        try {
            const [ok, bytes] = GLib.file_get_contents(COLORS);
            if (!ok)
                return;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            this._colors = {...FALLBACK, ...data};
        } catch (e) {
            // Mid-write or absent; the fallback greys keep the element legible.
        }
    }

    _paint() {
        if (!this._actor)
            return;
        const c = this._colors;
        const mono = 'font-family: "FiraCode Nerd Font Mono", monospace;';

        this._tag.set_style(
            `${mono} font-size: 11px; letter-spacing: 1px; ` +
            `color: ${c.outline}; padding-bottom: 6px;`);
        this._title.set_style(
            `font-family: "Playfair Display", serif; font-size: 20px; ` +
            `color: ${c.on_surface};`);
        this._artist.set_style(
            `${mono} font-size: 11px; color: ${c.outline}; padding-top: 2px;`);
        this._time.set_style(
            `${mono} font-size: 11px; color: ${c.outline};`);
        this._track.set_style(
            `background-color: ${c.outline_variant}; margin-top: 10px;`);
        this._fill.set_style(`background-color: ${c.on_surface};`);
    }

    /* ----------------------------------------------------------------- state */

    _update(state) {
        if (!this._actor)
            return;

        const wanted = state && (state.playing || !HIDE_WHEN_PAUSED);
        if (!wanted) {
            this._current = null;
            this._stopTicking();
            this._hide();
            return;
        }

        const swapped = state.trackId !== this._trackId;
        this._trackId = state.trackId;
        this._current = state;

        this._title.set_text(state.title);
        this._artist.set_text(state.artist);
        this._track.visible = state.length > 0;

        // A paused player keeps its line on the wall at half strength; the
        // dimming is the only "paused" indicator, so no second glyph is needed.
        this._show(swapped, state.playing ? FULL : DIM);

        this._refreshPosition();
        if (state.playing)
            this._startTicking();
        else
            this._stopTicking();
    }

    /**
     * Ease to `target` opacity. Every transition goes through here, so a
     * pause landing mid-fade-in can't be overwritten by a stale animation.
     */
    _show(swapped, target) {
        if (!this._visible) {
            this._visible = true;
            this._actor.show();
            this._queueRaise();
            this._actor.opacity = 0;
            this._ease(target, FADE_MS);
        } else if (swapped) {
            // Dip and come back on a track change, so the swap reads as one
            // element updating rather than two elements flickering.
            this._actor.ease({
                opacity: Math.round(target * 0.35),
                duration: SWAP_MS / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this._ease(target, SWAP_MS),
            });
        } else {
            this._ease(target, SWAP_MS);
        }
    }

    _ease(opacity, duration) {
        this._actor?.ease({
            opacity,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hide() {
        if (!this._visible)
            return;
        this._visible = false;
        this._trackId = null;
        this._actor.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._actor?.hide(),
        });
    }

    _startTicking() {
        if (this._tick)
            return;
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._refreshPosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTicking() {
        if (this._tick) {
            GLib.source_remove(this._tick);
            this._tick = null;
        }
    }

    /** Position is explicitly not a cached property, so it needs a real Get. */
    _refreshPosition() {
        const state = this._current;
        if (!state || !this._visible)
            return;
        state.proxy.get_connection().call(
            state.proxy.get_name(), MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 1000, null,
            (conn, res) => {
                let position;
                try {
                    position = Number(conn.call_finish(res).deepUnpack()[0].deepUnpack());
                } catch (e) {
                    return;  // player doesn't expose Position; leave the last value
                }
                if (this._current === state)
                    this._renderProgress(position, state.length);
            });
    }

    _renderProgress(position, length) {
        if (length > 0) {
            const frac = Math.min(1, Math.max(0, position / length));
            this._fill.set_width(Math.round(frac * this._width));
            this._time.set_text(`${usToLabel(position)} / ${usToLabel(length)}`);
        } else {
            // Live stream: an elapsed clock with no bar to fill.
            this._time.set_text(usToLabel(position));
        }
    }
}
