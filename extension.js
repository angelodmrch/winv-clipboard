// Win+V Clipboard: a Windows-style clipboard history for GNOME Shell.
//
// It runs inside GNOME Shell, so it works the same on Wayland and X11:
// the shell owns the clipboard, global shortcuts, and input, which a
// normal app is not allowed to touch under Wayland.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
const SECRET_MIMES = ['x-kde-passwordManagerHint'];
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PREVIEW_CHARS = 280;
const PREVIEW_LINES = 4;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 460;
const TERMINALS = ['terminal', 'kitty', 'alacritty', 'konsole', 'tilix', 'terminator',
    'wezterm', 'foot', 'ghostty', 'xterm', 'ptyxis', 'console', 'warp', 'urxvt'];

// Stores history in memory, mirrors it to disk, and saves images as files.
class History {
    constructor(settings) {
        this._settings = settings;
        this.items = [];
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'winv-clipboard']));
        this._index = this._dir.get_child('history.json');
    }

    load() {
        GLib.mkdir_with_parents(this._dir.get_path(), 0o700);
        try {
            const [, bytes] = this._index.load_contents(null);
            const saved = JSON.parse(new TextDecoder().decode(bytes));
            this.items = saved.filter(i => i.type === 'text' || this._imageFile(i).query_exists(null));
        } catch {
            this.items = [];
        }
        // Windows drops unpinned items on restart unless you keep them.
        if (!this._settings.get_boolean('persist-history'))
            this.items = this.items.filter(i => i.pinned);
        this._removeOrphanImages();
        this.save();
    }

    save() {
        // Unpinned items always live in memory for the session; only write
        // them to disk when the user asked to keep them.
        const keep = this._settings.get_boolean('persist-history')
            ? this.items : this.items.filter(i => i.pinned);
        const data = new TextEncoder().encode(JSON.stringify(keep));
        try {
            this._index.replace_contents(data, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`winv-clipboard: could not save history: ${e.message}`);
        }
    }

    addText(text) {
        const existing = this.items.find(i => i.type === 'text' && i.text === text);
        this._addOrBump(existing, () => ({type: 'text', text}));
    }

    addImage(mime, bytes) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const existing = this.items.find(i => i.type === 'image' && i.hash === hash);
        this._addOrBump(existing, () => {
            const item = {type: 'image', mime, hash, ext: mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'};
            this._imageFile(item).replace_contents(bytes.toArray(), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return item;
        });
    }

    bump(item) {
        this._addOrBump(item, null);
    }

    _addOrBump(existing, create) {
        if (existing) {
            if (this.items[0] === existing)
                return;
            this.items.splice(this.items.indexOf(existing), 1);
            this.items.unshift(existing);
        } else {
            const item = create();
            item.id = GLib.uuid_string_random();
            item.pinned = false;
            item.time = Date.now();
            this.items.unshift(item);
        }
        this._trim();
        this.save();
    }

    _trim() {
        const max = this._settings.get_int('history-size');
        let unpinned = 0;
        this.items = this.items.filter(item => {
            if (item.pinned)
                return true;
            if (++unpinned <= max)
                return true;
            this._deleteFiles(item);
            return false;
        });
    }

    remove(item) {
        this.items = this.items.filter(i => i !== item);
        this._deleteFiles(item);
        this.save();
    }

    togglePin(item) {
        item.pinned = !item.pinned;
        this._trim();
        this.save();
    }

    // Like Windows, "Clear all" keeps pinned items.
    clearUnpinned() {
        for (const item of this.items.filter(i => !i.pinned))
            this._deleteFiles(item);
        this.items = this.items.filter(i => i.pinned);
        this.save();
    }

    imageUri(item) {
        return this._imageFile(item).get_uri();
    }

    imageBytes(item) {
        const [, contents] = this._imageFile(item).load_contents(null);
        return new GLib.Bytes(contents);
    }

    _imageFile(item) {
        return this._dir.get_child(`${item.hash}.${item.ext}`);
    }

    _deleteFiles(item) {
        if (item.type !== 'image')
            return;
        if (this.items.some(i => i !== item && i.hash === item.hash))
            return;
        try {
            this._imageFile(item).delete(null);
        } catch {}
    }

    _removeOrphanImages() {
        const wanted = new Set(this.items.filter(i => i.type === 'image')
            .map(i => this._imageFile(i).get_basename()));
        try {
            const children = this._dir.enumerate_children('standard::name', 0, null);
            let info;
            while ((info = children.next_file(null))) {
                const name = info.get_name();
                if (name !== 'history.json' && !wanted.has(name))
                    this._dir.get_child(name).delete(null);
            }
        } catch {}
    }
}

export default class WinVClipboardExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._history = new History(this._settings);
        this._history.load();
        this._clipboard = St.Clipboard.get_default();

        const seat = Clutter.get_default_backend().get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (_sel, type, source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD && source)
                this._captureClipboard();
        });

        this._settingsChangedId = this._settings.connect('changed::persist-history',
            () => this._history.save());

        this._freeSuperV();
        Main.wm.addKeybinding('toggle-shortcut', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._toggle());
        this._shortcutChangedId = this._settings.connect('changed::toggle-shortcut', () => {
            this._restoreSuperV();
            this._freeSuperV();
        });

        this._sessionId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked)
                this._close();
        });
    }

    disable() {
        this._close();
        Main.wm.removeKeybinding('toggle-shortcut');
        this._restoreSuperV();
        Main.sessionMode.disconnect(this._sessionId);
        this._settings.disconnect(this._shortcutChangedId);
        this._settings.disconnect(this._settingsChangedId);
        this._selection.disconnect(this._ownerChangedId);
        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
        this._history.save();
        this._history = null;
        this._keyboard = null;
        this._selection = null;
        this._clipboard = null;
        this._settings = null;
    }

    // GNOME uses Super+V for the notification list (Super+M does the same),
    // so take it over while the extension runs and give it back afterwards.
    _freeSuperV() {
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const ours = this._settings.get_strv('toggle-shortcut').map(s => s.toLowerCase());
        const current = shell.get_strv('toggle-message-tray');
        this._removedTrayKeys = current.filter(k => ours.includes(k.toLowerCase()));
        if (this._removedTrayKeys.length)
            shell.set_strv('toggle-message-tray', current.filter(k => !this._removedTrayKeys.includes(k)));
    }

    _restoreSuperV() {
        if (!this._removedTrayKeys?.length)
            return;
        const shell = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        const current = shell.get_strv('toggle-message-tray');
        shell.set_strv('toggle-message-tray',
            [...new Set([...this._removedTrayKeys, ...current])]);
        this._removedTrayKeys = [];
    }

    _captureClipboard() {
        const mimes = this._clipboard.get_mimetypes(CLIPBOARD) ?? [];
        if (mimes.some(m => SECRET_MIMES.includes(m)))
            return;

        // Prefer text: spreadsheets and office apps offer an image of the
        // selection too, but people expect the text back.
        if (mimes.some(m => TEXT_MIMES.includes(m))) {
            this._clipboard.get_text(CLIPBOARD, (_cb, text) => {
                if (!this._history || !text || !text.trim() || text.length > MAX_TEXT_BYTES)
                    return;
                this._history.addText(text);
                this._refresh();
            });
            return;
        }

        const imageMime = mimes.find(m => m === 'image/png') ?? mimes.find(m => m.startsWith('image/'));
        if (imageMime && this._settings.get_boolean('track-images')) {
            this._clipboard.get_content(CLIPBOARD, imageMime, (_cb, bytes) => {
                if (!this._history || !bytes || bytes.get_size() === 0 || bytes.get_size() > MAX_IMAGE_BYTES)
                    return;
                try {
                    this._history.addImage(imageMime, bytes);
                } catch (e) {
                    console.error(`winv-clipboard: could not store image: ${e.message}`);
                    return;
                }
                this._refresh();
            });
        }
    }

    _toggle() {
        if (this._backdrop) {
            this._close();
            return;
        }
        try {
            this._open();
        } catch (e) {
            // Never leave an invisible popup holding the keyboard and mouse.
            console.error(`winv-clipboard: could not open the popup: ${e.message}\n${e.stack}`);
            this._close();
        }
    }

    _open() {
        // A full-screen invisible layer: clicking anywhere outside closes the popup.
        this._backdrop = new St.Widget({reactive: true, x: 0, y: 0,
            width: global.stage.width, height: global.stage.height});
        this._backdrop.connect('button-press-event', (_a, event) => {
            if (this._isInsidePanel(event))
                return Clutter.EVENT_PROPAGATE;
            this._close();
            return Clutter.EVENT_STOP;
        });

        this._panel = vbox({
            style_class: 'winv-panel', reactive: true, can_focus: true,
            width: PANEL_WIDTH, height: PANEL_HEIGHT, opacity: 0,
        });
        this._panel.connect('key-press-event', (_a, event) => this._onKey(event));

        const header = new St.BoxLayout({style_class: 'winv-header'});
        header.add_child(new St.Label({text: _('Clipboard'), style_class: 'winv-title',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const clear = new St.Button({label: _('Clear all'), style_class: 'winv-clear', can_focus: true});
        clear.connect('clicked', () => {
            this._history.clearUnpinned();
            this._refresh();
            global.stage.set_key_focus(this._panel);
        });
        header.add_child(clear);
        this._panel.add_child(header);

        this._list = vbox({style_class: 'winv-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'winv-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._scroll.child = this._list;
        this._panel.add_child(this._scroll);

        this._backdrop.add_child(this._panel);
        Main.layoutManager.uiGroup.add_child(this._backdrop);
        this._placeNearPointer();

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        this._selected = 0;
        this._refresh();
        global.stage.set_key_focus(this._panel);
        this._panel.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _isInsidePanel(event) {
        if (!this._panel)
            return false;
        const [x, y] = event.get_coords();
        const [px, py] = this._panel.get_transformed_position();
        const [w, h] = this._panel.get_transformed_size();
        return x >= px && x < px + w && y >= py && y < py + h;
    }

    _placeNearPointer() {
        const [px, py] = global.get_pointer();
        const monitor = Main.layoutManager.monitors.find(m =>
            px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height) ??
            Main.layoutManager.primaryMonitor;
        const margin = 12;
        let x = px + 8;
        let y = py + 8;
        if (x + PANEL_WIDTH > monitor.x + monitor.width - margin)
            x = px - PANEL_WIDTH - 8;
        if (y + PANEL_HEIGHT > monitor.y + monitor.height - margin)
            y = monitor.y + monitor.height - PANEL_HEIGHT - margin;
        x = Math.max(monitor.x + margin, x);
        y = Math.max(monitor.y + margin, y);
        this._panel.set_position(Math.round(x), Math.round(y));
    }

    _close() {
        if (!this._backdrop)
            return;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._backdrop.destroy();
        this._backdrop = null;
        this._panel = null;
        this._list = null;
        this._scroll = null;
        this._rows = [];
    }

    _refresh() {
        if (!this._list)
            return;
        this._list.destroy_all_children();
        this._rows = [];
        const items = this._history.items;

        if (items.length === 0) {
            const empty = vbox({style_class: 'winv-empty', x_expand: true, y_expand: true});
            empty.add_child(new St.Label({text: _('Nothing here'), style_class: 'winv-empty-title'}));
            const hint = new St.Label({style_class: 'winv-empty-text',
                text: _("You'll see your clipboard history here once you've copied something.")});
            hint.clutter_text.line_wrap = true;
            empty.add_child(hint);
            this._list.add_child(empty);
            return;
        }

        this._selected = Math.min(this._selected ?? 0, items.length - 1);
        items.forEach((item, index) => {
            const row = this._buildRow(item, index);
            this._rows.push(row);
            this._list.add_child(row);
        });
        this._highlight();
    }

    _buildRow(item, index) {
        const row = new St.BoxLayout({style_class: 'winv-item', reactive: true,
            track_hover: true, x_expand: true});
        if (item.pinned)
            row.add_style_class_name('pinned');

        let content;
        if (item.type === 'image') {
            content = new St.Widget({style_class: 'winv-image', x_expand: true,
                style: `background-image: url("${this._history.imageUri(item)}");`});
        } else {
            content = new St.Label({style_class: 'winv-text', x_expand: true,
                y_align: Clutter.ActorAlign.CENTER, text: preview(item.text)});
            content.clutter_text.line_wrap = true;
            content.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            content.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        // Every clickable part is its own St.Button. Newer GNOME versions
        // handle clicks with gestures, and nesting buttons inside a
        // clickable row made the row swallow pin/delete clicks.
        const body = new St.Button({style_class: 'winv-item-body', child: content,
            x_expand: true, can_focus: false, x_align: Clutter.ActorAlign.FILL,
            accessible_name: item.type === 'image' ? _('Image') : preview(item.text)});
        body.connect('clicked', () => this._activate(item));
        row.add_child(body);

        const actions = new St.BoxLayout({style_class: 'winv-actions', y_align: Clutter.ActorAlign.START});
        const pin = new St.Button({style_class: 'winv-action', can_focus: false,
            child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 14}),
            accessible_name: item.pinned ? _('Unpin') : _('Pin')});
        if (item.pinned)
            pin.add_style_pseudo_class('checked');
        pin.connect('clicked', () => this._togglePin(item));
        const del = new St.Button({style_class: 'winv-action', can_focus: false,
            child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 14}),
            accessible_name: _('Delete')});
        del.connect('clicked', () => this._remove(item));
        actions.add_child(pin);
        actions.add_child(del);
        row.add_child(actions);

        row.connect('notify::hover', () => {
            if (row.hover) {
                this._selected = index;
                this._highlight(false);
            }
        });
        return row;
    }

    _highlight(scrollIntoView = true) {
        this._rows.forEach((row, i) => {
            if (i === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        const row = this._rows[this._selected];
        if (row && this._scroll && scrollIntoView)
            ensureActorVisibleInScrollView(this._scroll, row);
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        const items = this._history.items;
        const item = items[this._selected];

        switch (key) {
        case Clutter.KEY_Escape:
            this._close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Home:
            this._move(-items.length);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_End:
            this._move(items.length);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space:
            if (item)
                this._activate(item);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
        case Clutter.KEY_BackSpace:
            if (item)
                this._remove(item);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (item)
                this._togglePin(item);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _move(delta) {
        if (!this._rows.length)
            return;
        this._selected = Math.max(0, Math.min(this._rows.length - 1, this._selected + delta));
        this._highlight();
    }

    _togglePin(item) {
        this._history.togglePin(item);
        this._refresh();
        global.stage.set_key_focus(this._panel);
    }

    _remove(item) {
        this._history.remove(item);
        this._refresh();
        global.stage.set_key_focus(this._panel);
    }

    _activate(item) {
        this._close();
        try {
            if (item.type === 'image')
                this._clipboard.set_content(CLIPBOARD, item.mime, this._history.imageBytes(item));
            else
                this._clipboard.set_text(CLIPBOARD, item.text);
        } catch (e) {
            console.error(`winv-clipboard: could not set clipboard: ${e.message}`);
            return;
        }
        // Setting the clipboard fires owner-changed too, which finds this
        // same item and keeps it at the top instead of adding a copy.
        this._history.bump(item);

        if (!this._settings.get_boolean('paste-on-select'))
            return;
        // Give the focused window a moment to get keyboard input back, then press Ctrl+V.
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._pasteTimeoutId = 0;
            this._sendPaste();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPaste() {
        if (!this._keyboard)
            return;
        const wmClass = (global.display.focus_window?.get_wm_class() ?? '').toLowerCase();
        const isTerminal = TERMINALS.some(t => wmClass.includes(t));
        const keys = isTerminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_V]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const now = GLib.get_monotonic_time();
        keys.forEach(k => this._keyboard.notify_keyval(now, k, Clutter.KeyState.PRESSED));
        [...keys].reverse().forEach(k => this._keyboard.notify_keyval(now, k, Clutter.KeyState.RELEASED));
    }
}

// St.BoxLayout swapped `vertical` for `orientation` in GNOME 48.
function vbox(params) {
    const box = new St.BoxLayout(params);
    if (box.orientation !== undefined)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function preview(text) {
    const lines = text.replace(/\t/g, '    ').split('\n')
        .map(l => l.trimEnd()).filter((l, i, all) => l || (i > 0 && i < all.length - 1));
    let out = lines.slice(0, PREVIEW_LINES).join('\n');
    if (out.length > PREVIEW_CHARS)
        out = `${out.slice(0, PREVIEW_CHARS)}…`;
    else if (lines.length > PREVIEW_LINES)
        out += '…';
    return out || text.trim();
}
