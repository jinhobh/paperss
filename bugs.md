# Known bugs

## Waybar freezes after repeated theme reloads

**Status:** Open. Waybar was restarted manually. Root cause not confirmed.
**Found:** 2026-10-13. Waybar 0.15.0 under Hyprland, two outputs (eDP-1, DP-1).

### Symptoms

- Clock stops updating; clicks on the bar do nothing.
- The Waybar process keeps running and its layer surfaces stay mapped (`hyprctl layers` still lists them).
- Last log line at 00:20:27. A reload signal at 00:38:05 produced no log output.
- Main thread waits on a futex. Several threads are blocked in pipe writes (wchan `anon_pipe_write`).
- No backtrace: `ptrace_scope=1` blocks attaching gdb.

### Evidence

- Full reloads (`Reloading...`, from SIGUSR2): 10 between 00:00 and 00:25 on Oct 13; 3 on Oct 12.
- `hyprctl` reloads (`Hyprland config reloaded`): 22 between 00:00 and 00:25 on Oct 13; 10 on Oct 12.
- Leftover children: two `swaync-client --subscribe-waybar` chains under the Waybar process before restart (PIDs 279773, 279800).
- Waybar 0.15.0 `src/main.cpp`: SIGUSR2 calls `Client::inst()->reset()` and rebuilds every bar and module.

### Trigger chain

1. `~/.config/hypr/hyprland.conf` lines 109–110 bind each Super key release to `~/Projects/paperss/bin/wallpaper-selector --commit`.
2. `src/wallpaper-selector.c`: the resident selector process (started at login, hidden) receives `--commit` and calls `commit()`. `commit()` does not check whether the selector is visible or whether the selection changed. It always runs `retheme` on the current item. `arm_commit_timer()` also auto-commits 4.5 s after the last cycle keypress.
3. `bin/retheme` calls `bin/hypr-reload`, which runs `hyprctl reload`, then `pkill -SIGUSR2 waybar`, then restarts `swaybg`.
4. Waybar performs a full reload.

**Confirmed:** the 00:38:05 run came from the selector (`/run/user/1000/rice-wallpaper-selector.log`), and Waybar did not respond to it.
**Not confirmed:** that Super taps caused the reload burst between 00:03 and 00:20.

### Open questions

- What caused the reload burst between 00:03 and 00:20?
- What exactly deadlocks?
- Does the freeze happen without a reload storm?

### Related upstream reports (not verified as matching)

- Waybar #2224: SIGUSR2 reload crashes, reported with the tray module (this config has one).
- Waybar #4885, #5145: freezes in recent versions.

### Unrelated

- Constant `Discharging` lines on stdout: known Waybar bug, issue #4887 (fix in PR #4844, not in the release used here). Not the cause of the freeze.
- `"height": 30` in `~/.config/waybar/config.jsonc` is below Waybar's minimum of 31, so it warns on every reload.
- `hyprland-session-start` calls `$HOME/rice/bin/hypr-reload`, which does not exist. The call is a silent no-op, so it is not a trigger.

### Reproduce (not yet done)

1. `journalctl --user -u waybar -f`
2. Tap Super once with no selector open.
3. If the hypothesis holds, a `Reloading...` line appears for each tap.

This may freeze the bar. Recover with `systemctl --user restart waybar`.

### Proposed fixes

- In `commit()` (or the `--commit` branch of `command_line()`), return early when the selector window is hidden. This removes the Super-tap trigger.
- Skip `retheme` when the selected wallpaper matches the one in `~/.local/share/rice/state.json`.
- In `bin/hypr-reload`, remove `pkill -SIGUSR2 waybar`. Waybar already reloads `style.css` on change (`reload_style_on_change: true`). Check whether `hyprctl reload` is still needed.

Fixing the triggers does not fix the freeze. Why repeated full reloads lead to a hang is still unexplained.
