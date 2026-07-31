/* mpris.js — the bus half of the root-window media element.
 *
 * Deliberately free of St and shell imports so it can be exercised headlessly
 * with plain gjs against a stub player, without a shell restart.
 */
import Gio from 'gi://Gio';

const BUS_PREFIX = 'org.mpris.MediaPlayer2';
export const MPRIS_PATH = '/org/mpris/MediaPlayer2';
export const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';


/** Unpack one a{sv} member, which arrives as a Variant inside the dict. */
function member(dict, key) {
    const v = dict?.[key];
    return v?.deepUnpack ? v.deepUnpack() : v;
}


/** Watches every MPRIS player on the bus and reports the interesting one. */
export class MprisWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._players = new Map();   // bus name -> {proxy, ids, stamp}
        this._stamp = 0;
        this._conn = Gio.DBus.session;
    }

    start() {
        // MATCH_ARG0_NAMESPACE catches every org.mpris.MediaPlayer2.* name with
        // a single subscription, so players can come and go freely.
        this._nameId = this._conn.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', BUS_PREFIX,
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (newOwner === '')
                    this._drop(name);
                else
                    this._add(name);
            });

        this._conn.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null,
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                let names;
                try {
                    names = conn.call_finish(res).deepUnpack()[0];
                } catch (e) {
                    logError(e, 'rice-player: could not list bus names');
                    return;
                }
                for (const name of names) {
                    if (name.startsWith(`${BUS_PREFIX}.`))
                        this._add(name);
                }
            });
    }

    stop() {
        // Drop the callback first: tearing the players down emits changes, and
        // by this point the widget is on its way out.
        this._onChange = null;
        if (this._nameId) {
            this._conn.signal_unsubscribe(this._nameId);
            this._nameId = null;
        }
        for (const name of [...this._players.keys()])
            this._drop(name);
    }

    _add(name) {
        if (this._players.has(name))
            return;
        this._players.set(name, null);  // claim the slot while the proxy builds

        Gio.DBusProxy.new(
            this._conn, Gio.DBusProxyFlags.NONE, null,
            name, MPRIS_PATH, PLAYER_IFACE, null,
            (_o, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(res);
                } catch (e) {
                    this._players.delete(name);  // vanished mid-handshake
                    return;
                }
                if (!this._onChange || !this._players.has(name))
                    return;  // disabled, or dropped while we were building
                if (this._players.get(name))
                    return;  // quit and rejoined; a later proxy already won

                const entry = {proxy, stamp: ++this._stamp, ids: []};
                entry.ids.push(proxy.connect('g-properties-changed', () => {
                    if (this._status(proxy) === 'Playing')
                        entry.stamp = ++this._stamp;
                    this._emit();
                }));
                entry.ids.push(proxy.connect('g-signal', (_p, _sender, signal) => {
                    if (signal === 'Seeked')
                        this._emit();
                }));
                this._players.set(name, entry);
                this._emit();
            });
    }

    _drop(name) {
        const entry = this._players.get(name);
        this._players.delete(name);
        if (entry) {
            for (const id of entry.ids)
                entry.proxy.disconnect(id);
            this._emit();
        }
    }

    _status(proxy) {
        return proxy.get_cached_property('PlaybackStatus')?.deepUnpack() ?? 'Stopped';
    }

    _emit() {
        this._onChange?.(this.current());
    }

    /**
     * The player worth showing: whatever started playing most recently, and
     * failing that whatever is paused most recently. Stopped players are as
     * good as absent.
     */
    current() {
        let best = null;
        let bestRank = -1;
        for (const entry of this._players.values()) {
            if (!entry)
                continue;
            const status = this._status(entry.proxy);
            const rank = status === 'Playing' ? 2 : status === 'Paused' ? 1 : 0;
            if (rank === 0)
                continue;
            if (rank > bestRank || (rank === bestRank && entry.stamp > best.stamp)) {
                best = entry;
                bestRank = rank;
            }
        }
        if (!best)
            return null;

        const md = best.proxy.get_cached_property('Metadata')?.deepUnpack() ?? {};
        const artists = member(md, 'xesam:artist') ?? member(md, 'xesam:albumArtist');
        const title = member(md, 'xesam:title') || '';
        const url = member(md, 'xesam:url') || '';

        return {
            proxy: best.proxy,
            playing: bestRank === 2,
            // A stream with no title still deserves a line; fall back to the
            // file name so the element never renders blank.
            title: title || decodeURIComponent(url.split('/').pop() ?? '') || 'Unknown track',
            artist: Array.isArray(artists) ? artists.filter(a => a).join(', ') : (artists || ''),
            length: Number(member(md, 'mpris:length') ?? 0),
            trackId: `${member(md, 'mpris:trackid') ?? ''}|${title}|${url}`,
        };
    }
}
