# Win+V Clipboard for Ubuntu

A clipboard history that works like Windows **Win+V**, built as a GNOME Shell
extension so it works on Ubuntu's default Wayland session as well as X11.

## Features

- **Super+V** opens a popup next to the mouse pointer with your recent copies.
- Remembers **text and images**.
- **Click** an item, or pick it with the arrow keys and press **Enter**, and it
  is pasted into the app you were using (terminals get Ctrl+Shift+V).
- **Pin** items (pin button or `P`) so they survive "Clear all" and logging out.
- **Delete** one item (bin button or `Delete`) or **Clear all** (pinned items stay).
- `Esc` or a click outside closes the popup.
- Keeps 25 items by default, like Windows. Copies that password managers mark
  as secret are skipped.

Supports GNOME Shell 45 to 50 (Ubuntu 23.10 and newer).

## Install

### From the .deb (recommended)

Download the `.deb` from the Releases page, then:

```bash
sudo apt install ./gnome-shell-extension-winv-clipboard_<version>_all.deb
```

Log out and back in, then enable it as your normal user:

```bash
gnome-extensions enable winv-clipboard@angelo
```

### From source (current user only)

```bash
bash install.sh
```

Then log out and back in and run the same `gnome-extensions enable` command.

> A copy in `~/.local/share/gnome-shell/extensions/` wins over the system one
> from the .deb. Remove it if you switch to the .deb.

On Wayland, GNOME loads extension code only at login, so every install or
update needs a log out and back in.

## Settings

`gnome-extensions prefs winv-clipboard@angelo` (or the Extensions app):
shortcut, number of items, paste on select, keep images, keep history after
logging out.

GNOME normally uses Super+V for the notification list. While this extension is
on it takes Super+V over (Super+M still opens notifications) and gives it back
when disabled.

History lives in `~/.local/share/winv-clipboard/`. By default only pinned items
are written to disk, like Windows.

## Development

Test without logging out by running a nested GNOME session in a window:

```bash
sudo apt install mutter-dev-bin
dbus-run-session gnome-shell --devkit --wayland
```

Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i winv`

Build the packages (output goes to `dist/`):

```bash
bash packaging/build-deb.sh   # needs dpkg-deb
bash packaging/pack-zip.sh    # zip for `gnome-extensions install`
```

Bump `"version"` in `metadata.json` before building a new release; the .deb
version comes from it.

## Why an extension and not a normal app

On Wayland, normal apps cannot register global shortcuts, read the clipboard
while in the background, or type Ctrl+V into another window. GNOME Shell can do
all three, so this runs inside it.
