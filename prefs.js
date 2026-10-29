import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WinVClipboardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const general = new Adw.PreferencesGroup({title: _('Clipboard history')});
        page.add(general);

        const shortcut = new Adw.EntryRow({
            title: _('Shortcut (for example <Super>v)'),
            text: settings.get_strv('toggle-shortcut')[0] ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const accel = shortcut.text.trim();
            const [ok] = Gtk.accelerator_parse(accel);
            if (ok && accel) {
                settings.set_strv('toggle-shortcut', [accel]);
                shortcut.remove_css_class('error');
            } else {
                shortcut.add_css_class('error');
            }
        });
        general.add(shortcut);

        const size = new Adw.SpinRow({
            title: _('Items to keep'),
            subtitle: _('Pinned items are kept on top of this'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 200, step_increment: 1}),
        });
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        general.add(size);

        const switches = [
            ['paste-on-select', _('Paste when an item is chosen'),
                _('Off: choosing an item only copies it, and you paste yourself')],
            ['track-images', _('Keep copied images'), ''],
        ];
        for (const [key, title, subtitle] of switches) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            general.add(row);
        }
    }
}
