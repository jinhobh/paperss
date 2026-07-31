/* plates — an ordered click figure on the wallpaper that opens the contact sheet.
 *
 * Four points on the collage, clicked in order with Ctrl+Alt+Shift held.
 *
 * Getting the clicks at all is the whole problem. The desktop is covered by
 * Desktop Icons NG, and on Wayland the shell is only handed pointer events that
 * fall inside its *input region* — a plain 'captured-event' handler on the stage
 * never claims one, so the press goes straight to that window and the shell
 * never sees it. The fix is to put a real actor on screen through
 * Main.layoutManager.addChrome(), which is what actually extends the input
 * region.
 *
 * That actor would swallow every click if it were always up, so it is only
 * raised while the chord is physically held AND the pointer is over bare
 * desktop. Both are read straight from global.get_pointer() and the window list
 * rather than from events, because those queries answer correctly no matter who
 * currently owns the pointer grab. Cost is one cheap poll per POLL_MS.
 *
 * A correct click leaves a ring that expands and fades — enough to tell you the
 * point registered, without naming the next one or how many are left. Nothing
 * is drawn before the first correct click, so the figure stays invisible to
 * anyone who does not already know the chord and the opening point.
 *
 * Touching ~/.local/share/rice/lib/.plates-debug makes it log what it sees;
 * the file is read per event, so it needs no reload.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOME = GLib.get_home_dir();
const VIEWER = `${HOME}/.local/bin/rice-contact`;
const COLORS = `${HOME}/.local/share/rice/colors.json`;
const DEBUG = `${HOME}/.local/share/rice/lib/.plates-debug`;
const CONFIG = `${HOME}/.local/share/rice/lib/.plates.json`;
const RECORD = `${HOME}/.local/share/rice/lib/.plates-record`;

const POINTS = 4;

// Fallback figure, used only when the config file is missing or malformed.
// These are poster.toml's box centres, which is not the same thing as where
// each component's ink actually lands — `focus` writes into the left of its
// box, the art is bottom-left anchored — so the recorded figure in CONFIG is
// what should normally be in force. Record a new one by touching RECORD.
const FALLBACK_FIGURE = [
    {x: 0.20,  y: 0.15},
    {x: 0.82,  y: 0.84},
    {x: 0.755, y: 0.19},
    {x: 0.13,  y: 0.70},
];

// Hit radius as a fraction of monitor width, applied as a circle in pixels so
// the target is not stretched on wide displays. ~106px at 1920 — forgiving
// enough to hit from memory, far too small for four in a row by accident.
const RADIUS = 0.055;

// Budget between clicks. Long enough to cross the screen deliberately, short
// enough that an abandoned attempt cannot be finished later by chance.
const STEP_MS = 3000;

// Pointer/modifier poll. 10Hz is imperceptible next to what the shell already
// does per frame, and nothing here runs unless the chord is actually held.
const POLL_MS = 100;

const NEEDED =
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SHIFT_MASK;

const FALLBACK_INK = '#e2e2e2';


export class PlateWatcher {
    constructor() {
        this._step = 0;
        this._overlay = null;
        this._timer = null;
        this._poll = null;
        this._ink = FALLBACK_INK;
    }

    enable() {
        this._readInk();
        this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._poll) {
            GLib.source_remove(this._poll);
            this._poll = null;
        }
        this._disarm();
    }

    /* ------------------------------------------------------------------ poll */

    _tick() {
        let held, onDesktop;
        try {
            const [x, y, mods] = global.get_pointer();
            held = (mods & NEEDED) === NEEDED;
            onDesktop = held && this._overDesktop(x, y);
        } catch (e) {
            return;
        }

        if (held && onDesktop) {
            if (!this._overlay)
                this._arm();
        } else if (this._overlay) {
            // Releasing the chord, or wandering onto a real window, abandons the
            // attempt. Both also drop the input region again immediately, so the
            // overlay is never in the way of ordinary use.
            this._disarm();
        }
    }

    /**
     * True when nothing but the desktop is under the pointer. DESKTOP-type
     * windows are skipped precisely because Desktop Icons NG is one and covers
     * the whole screen; counting it would mean never arming at all.
     */
    _overDesktop(x, y) {
        const ws = global.workspace_manager.get_active_workspace();
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w || w.minimized)
                continue;
            if (w.get_window_type() === Meta.WindowType.DESKTOP)
                continue;
            if (!w.located_on_workspace(ws))
                continue;
            const r = w.get_frame_rect();
            if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
                return false;
        }
        return true;
    }

    /* ----------------------------------------------------------------- armed */

    _arm() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;

        this._overlay = new St.Widget({
            reactive: true,
            x: mon.x, y: mon.y,
            width: mon.width, height: mon.height,
        });
        this._overlay.connect('button-press-event',
            (_a, event) => this._onPress(event));

        // Both are read per arm rather than per session, so editing the figure
        // or dropping the record file takes effect on the next attempt — no
        // shell reload, which on Wayland would mean logging out.
        this._figure = this._readFigure();
        this._recording = GLib.file_test(RECORD, GLib.FileTest.EXISTS)
            ? [] : null;

        // addChrome is the part that matters: it puts a real reactive actor in
        // uiGroup above the window group, and Mutter derives the input region
        // from the actor tree — which is what decides whether Wayland hands us
        // the press or gives it to the window underneath.
        //
        // No params: GNOME 50's defaults are already {trackFullscreen: false,
        // affectsStruts: false}, and layout.js runs them through Params.parse,
        // which throws on any key it does not recognise.
        Main.layoutManager.addChrome(this._overlay);
        this._log(this._recording ? 'armed (recording)' : 'armed');
    }

    /** The figure in use: the recorded one if it is valid, else the fallback. */
    _readFigure() {
        try {
            const [ok, bytes] = GLib.file_get_contents(CONFIG);
            if (!ok)
                return FALLBACK_FIGURE;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            const pts = data?.points;
            const valid = Array.isArray(pts) && pts.length === POINTS &&
                pts.every(p => typeof p?.x === 'number' && typeof p?.y === 'number' &&
                    p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
            if (!valid) {
                this._log('config malformed; using the fallback figure');
                return FALLBACK_FIGURE;
            }
            return pts;
        } catch (e) {
            return FALLBACK_FIGURE;
        }
    }

    /**
     * Record mode: the next POINTS clicks become the new figure. Recording
     * never opens the sheet, and clears its own trigger file when done, so it
     * cannot be left switched on by accident.
     */
    _record(x, y, mon) {
        this._recording.push({
            x: Number(((x - mon.x) / mon.width).toFixed(4)),
            y: Number(((y - mon.y) / mon.height).toFixed(4)),
        });
        const done = this._recording.length >= POINTS;
        this._mark(x, y, done);
        this._log(`recorded ${this._recording.length}/${POINTS}`);
        if (!done)
            return;

        const points = this._recording;
        this._recording = null;
        try {
            GLib.file_set_contents(CONFIG,
                JSON.stringify({points}, null, 2) + '\n');
            GLib.unlink(RECORD);
            this._figure = points;
            this._log('figure recorded');
        } catch (e) {
            this._log(`could not write the figure: ${e}`);
        }
    }

    _disarm() {
        this._cancelTimer();
        this._step = 0;
        this._recording = null;
        if (this._overlay) {
            Main.layoutManager.removeChrome(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
        }
    }

    /* ----------------------------------------------------------------- input */

    _onPress(event) {
        try {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;

            const mon = Main.layoutManager.primaryMonitor;
            const [x, y] = event.get_coords();

            if (this._recording) {
                this._record(x, y, mon);
                return Clutter.EVENT_STOP;
            }

            const figure = this._figure ?? FALLBACK_FIGURE;
            if (!this._hits(figure[this._step], x, y, mon)) {
                this._log(`miss at step ${this._step} (${Math.round(x)},${Math.round(y)})` +
                    ` want (${Math.round(figure[this._step].x * mon.width)},` +
                    `${Math.round(figure[this._step].y * mon.height)})`);
                this._cancelTimer();
                this._step = 0;
                return Clutter.EVENT_STOP;
            }

            this._step += 1;
            this._log(`hit ${this._step}/${figure.length}`);

            const done = this._step >= figure.length;
            this._mark(x, y, done);

            if (done) {
                this._cancelTimer();
                this._step = 0;
                this._open();
            } else {
                this._restartTimer();
            }
        } catch (e) {
            this._log(`error: ${e}`);
            this._cancelTimer();
            this._step = 0;
        }
        // Everything is consumed while armed. The overlay is only up with the
        // chord held over bare desktop, so there is nothing underneath that
        // wanted the click anyway.
        return Clutter.EVENT_STOP;
    }

    _hits(point, x, y, mon) {
        const radius = RADIUS * mon.width;
        const dx = x - (mon.x + point.x * mon.width);
        const dy = y - (mon.y + point.y * mon.height);
        return (dx * dx) + (dy * dy) <= radius * radius;
    }

    /* -------------------------------------------------------------- feedback */

    /** A hairline ring that expands from the click and fades out. */
    _mark(x, y, done) {
        if (!this._overlay)
            return;

        const mon = Main.layoutManager.primaryMonitor;
        const size = done ? 26 : 17;
        const ring = new St.Widget({
            reactive: false,
            width: size * 2,
            height: size * 2,
            x: Math.round(x - mon.x - size),
            y: Math.round(y - mon.y - size),
            opacity: done ? 255 : 200,
            style: `border: 1px solid ${this._ink}; border-radius: ${size}px;`,
        });
        ring.set_pivot_point(0.5, 0.5);
        this._overlay.add_child(ring);

        // The last point gets a wider, longer flourish — by then the figure is
        // already complete, so there is nothing left to give away.
        ring.ease({
            scale_x: done ? 3.4 : 2.1,
            scale_y: done ? 3.4 : 2.1,
            opacity: 0,
            duration: done ? 620 : 420,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => ring.destroy(),
        });
    }

    _readInk() {
        try {
            const [ok, bytes] = GLib.file_get_contents(COLORS);
            if (!ok)
                return;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            this._ink = data.on_surface ?? FALLBACK_INK;
        } catch (e) {
            // Mid-write or absent; the fallback grey stays visible on the collage.
        }
    }

    /* ----------------------------------------------------------------- state */

    _restartTimer() {
        this._cancelTimer();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STEP_MS, () => {
            this._timer = null;
            this._step = 0;
            this._log('step timed out');
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    }

    _open() {
        try {
            const proc = Gio.Subprocess.new([VIEWER], Gio.SubprocessFlags.NONE);
            proc.wait_async(null, null);
        } catch (e) {
            this._log(`spawn failed: ${e}`);
        }
    }

    /** Silent unless the debug file exists, so the journal stays clean. */
    _log(message) {
        try {
            if (GLib.file_test(DEBUG, GLib.FileTest.EXISTS))
                log(`plates: ${message}`);
        } catch (e) {
            // Nothing useful to do if even the check fails.
        }
    }
}
