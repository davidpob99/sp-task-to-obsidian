#  Obsidian Note from Task

Super Productivity plugin (desktop, v20.0.0+) that creates an Obsidian note for a task and attaches a link to the note on the task.

**0.1.0, experimental. Only tested with GitLab issue tasks.**

```
{vault}/{project}/YYYYMMDDHHmm - {issue_title}.md
```

## Install

Zip `manifest.json`, `plugin.js` and `index.html` (top level, not in a folder) and upload the zip in **Settings → Plugins**. Then open the plugin and set:

- **Vault path**, e.g. `/path/to/vault`
- **Folder**, default `{project}`
- **GitLab base URL**, e.g. `https://gitlab.example.com` (required for GitLab tasks)

**Flatpak:** the app can't write to your home folder. Upload the zip from `~/Downloads`, give the app write access to the vault, then restart the app:

```bash
flatpak override --user --filesystem=/path/to/vault com.super_productivity.SuperProductivity
```

## Use

Use **Create Obsidian note** from the header button, the task's right-click menu or a keyboard shortcut. The header button and the shortcut use the task open in the detail panel, then the task you're tracking time on.

The note has properties only (`url`, `issue`, `tags` with the project and `group/repo`, ...) and an empty body. The plugin never overwrites an existing file.

## Permissions

The plugin needs `nodeExecution`, which lets it run code on your computer. It uses this only to create folders and write notes inside the vault folder you set, and it refuses paths outside that folder. It makes no network requests.

## Limitations

- Desktop app only.
- Plugins can't read the GitLab server from Super Productivity's settings, so you set it in the plugin.
- Other issue providers get no issue link built from the issue id. `url` is the first link found on the task instead.

## License

This project is released under the [MIT License](LICENSE).
