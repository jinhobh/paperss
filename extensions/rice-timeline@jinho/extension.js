import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {RootPlayer} from './player.js';
import {PlateWatcher} from './plates.js';

const HOME = GLib.get_home_dir();
const STATUS = `${HOME}/.local/share/rice/status.json`;
const BIN = `${HOME}/.local/bin`;

// Nine levels, matching the 0-8 buckets rice-status emits. Level 0 is a
// baseline tick rather than a blank so the ribbon reads as a continuous axis,
// the same way the poster's ribbon keeps a hairline for idle hours.
const BLOCKS = ['▁', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
// Each refresh spawns a short-lived Python process, so keep the background
// cadence modest; opening the menu always forces a fresh read anyway.
const REFRESH_SECONDS = 120;

/** Fold 24 hourly values into 12 two-hour buckets so the panel stays narrow. */
function compactSpark(spark) {
    if (!Array.isArray(spark) || spark.length !== 24)
        return '';
    let out = '';
    for (let i = 0; i < 24; i += 2)
        out += BLOCKS[Math.max(spark[i], spark[i + 1])] ?? ' ';
    return out;
}

export default class TimelineRibbonExtension extends Extension {
    enable() {
        // The root-window media element. Independent of the panel widgets: it
        // draws on the wallpaper, not in the bar.
        this._player = new RootPlayer();
        this._player.enable();

        this._plates = new PlateWatcher();
        this._plates.enable();

        this._workspaceButton = new PanelMenu.Button(0.0, 'Workspaces', false);
        this._workspaceLabel = new St.Label({
            style_class: 'rice-workspaces',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._workspaceButton.add_child(this._workspaceLabel);
        this._buildWorkspaceMenu();
        Main.panel.addToStatusArea(
            `${this.uuid}-workspaces`, this._workspaceButton, 0, 'left');

        this._workspaceId = global.workspace_manager.connect(
            'active-workspace-changed', () => this._renderWorkspaces());
        this._workspaceCountId = global.workspace_manager.connect(
            'notify::n-workspaces', () => {
                this._buildWorkspaceMenu();
                this._renderWorkspaces();
            });
        this._renderWorkspaces();

        this._button = new PanelMenu.Button(0.0, 'Timeline Ribbon', false);

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box rice-ribbon-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._spark = new St.Label({
            style_class: 'rice-ribbon-spark',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._total = new St.Label({
            style_class: 'rice-ribbon-total',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._spark);
        box.add_child(this._total);
        this._button.add_child(box);

        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._button, 1, 'right');

        // Refresh when the menu opens, so an idle panel is never stale on click.
        this._openId = this._button.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
        });

        // React the instant rice-status rewrites the file.
        this._file = Gio.File.new_for_path(STATUS);
        try {
            this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => this._read());
        } catch (e) {
            logError(e, 'rice-timeline: could not watch status file');
        }

        this._refresh();
        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        this._player?.disable();
        this._player = null;

        this._plates?.disable();
        this._plates = null;

        if (this._workspaceId) {
            global.workspace_manager.disconnect(this._workspaceId);
            this._workspaceId = null;
        }
        if (this._workspaceCountId) {
            global.workspace_manager.disconnect(this._workspaceCountId);
            this._workspaceCountId = null;
        }
        this._workspaceButton?.destroy();
        this._workspaceButton = null;
        this._workspaceLabel = null;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._monitor) {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorId = null;
        }
        if (this._openId) {
            this._button.menu.disconnect(this._openId);
            this._openId = null;
        }
        this._button?.destroy();
        this._button = null;
        this._spark = null;
        this._total = null;
        this._headline = null;
        this._detail = null;
        this._listSection = null;
    }

    _buildWorkspaceMenu() {
        const menu = this._workspaceButton?.menu;
        if (!menu)
            return;
        menu.removeAll();
        const count = global.workspace_manager.n_workspaces;
        for (let i = 0; i < count; i++) {
            const item = new PopupMenu.PopupMenuItem(`Workspace ${i + 1}`);
            item.connect('activate', () => {
                global.workspace_manager.get_workspace_by_index(i)
                    ?.activate(global.get_current_time());
            });
            menu.addMenuItem(item);
        }
    }

    _renderWorkspaces() {
        if (!this._workspaceLabel)
            return;
        const active = global.workspace_manager.get_active_workspace_index();
        const count = Math.min(6, global.workspace_manager.n_workspaces);
        const labels = [];
        for (let i = 0; i < count; i++)
            labels.push(i === active ? `[${i + 1}]` : `${i + 1}`);
        this._workspaceLabel.set_text(labels.join('  '));
    }

    _buildMenu() {
        const menu = this._button.menu;

        this._headline = new St.Label({style_class: 'rice-menu-headline'});
        this._detail = new St.Label({style_class: 'rice-menu-detail'});

        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false,
        });
        const hbox = new St.BoxLayout({vertical: true});
        hbox.add_child(this._headline);
        hbox.add_child(this._detail);
        header.add_child(hbox);
        menu.addMenuItem(header);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._listSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._listSection);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const regen = new PopupMenu.PopupMenuItem('Regenerate wallpaper');
        regen.connect('activate', () => this._spawn([`${BIN}/poster`, '--apply']));
        menu.addMenuItem(regen);

        const open = new PopupMenu.PopupMenuItem("Open today's timeline");
        // Splash first, then the timeline, then hold on our own `read`. Using
        // kitty's --hold instead would start a posix hold-shell that repaints
        // over the timeline once it exits.
        open.connect('activate', () => this._spawn(['kitty', '-e', 'bash', '-c',
            `HERMES_SPLASH=force source ${HOME}/.config/kitty/hermes-splash.sh; ` +
            `${HOME}/timeline-tracker/timeline show; ` +
            `printf '\\n  [enter to close] '; read -r`]));
        menu.addMenuItem(open);
    }

    _spawn(argv) {
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            proc.wait_async(null, null);
        } catch (e) {
            logError(e, `rice-timeline: failed to spawn ${argv[0]}`);
        }
    }

    /** Ask rice-status to rewrite the file; the monitor picks up the result. */
    _refresh() {
        try {
            const proc = Gio.Subprocess.new([`${BIN}/rice-status`],
                Gio.SubprocessFlags.NONE);
            proc.wait_async(null, () => this._read());
        } catch (e) {
            this._read();  // fall back to whatever is already on disk
        }
    }

    _read() {
        let data;
        try {
            const [ok, bytes] = GLib.file_get_contents(STATUS);
            if (!ok)
                return;
            data = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            return;  // mid-write or absent; the next tick will catch it
        }
        this._render(data);
    }

    _render(d) {
        if (!this._spark)
            return;

        const palette = d.palette ?? {};
        const accent = palette.primary ?? '#bfc2ff';
        const muted = palette.outline ?? '#978baf';

        this._spark.set_text(compactSpark(d.spark));
        this._spark.set_style(
            `color: ${accent}; font-family: monospace; font-size: 13px; ` +
            `letter-spacing: -1px; padding-right: 6px;`);

        // Streak is the more interesting number while you're working; the
        // day's total is the honest one once you've stopped.
        const label = d.streak_secs > 0 ? d.streak_label : d.total_label;
        this._total.set_text(label ?? '—');
        this._total.set_style(`color: ${muted}; font-size: 12px;`);

        this._headline.set_text('TODAY');
        this._headline.set_style(
            `color: ${accent}; font-size: 18px; font-weight: 700; ` +
            `letter-spacing: 2px;`);

        const bits = [`${d.total_label ?? '0M'} focused`];
        if (d.streak_secs > 0)
            bits.push(`${d.streak_label} streak`);
        if (d.repo_edits)
            bits.push(`${d.repo_edits} edits`);
        this._detail.set_text(`${d.date ?? ''} · ${bits.join(' · ')}`);
        this._detail.set_style(`color: ${muted}; font-size: 11px;`);

        this._listSection.removeAll();
        for (const app of d.apps ?? []) {
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false, can_focus: false,
            });
            const name = new St.Label({text: app.name, x_expand: true});
            const val = new St.Label({text: app.label});
            val.set_style(`color: ${muted};`);
            item.add_child(name);
            item.add_child(val);
            this._listSection.addMenuItem(item);
        }
        if (!(d.apps ?? []).length) {
            this._listSection.addMenuItem(
                new PopupMenu.PopupMenuItem('No activity recorded yet', {
                    reactive: false,
                }));
        }
    }
}
