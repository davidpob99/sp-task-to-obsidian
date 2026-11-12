'use strict';

/* ---------- Constants ---------- */

var SETTINGS_KEY = 'settings';
var LINKS_KEY = 'links';
var BUTTON_LABEL = 'Create Obsidian note';
var DEFAULT_SETTINGS = {
  vaultPath: '',
  folderTemplate: '{project}',
  noProjectFolder: 'No project',
  gitlabBaseUrl: '',
  appendLinkToTask: true,
};

var trackedTaskId = null;
var isBusy = false;

/* ---------- Storage helpers ---------- */

async function loadJson(key, fallback) {
  try {
    var raw = await PluginAPI.loadSyncedData(key);
    if (!raw) return Object.assign({}, fallback);
    return Object.assign({}, fallback, JSON.parse(raw));
  } catch (e) {
    PluginAPI.log.warn('[task-to-obsidian] could not read ' + key, e);
    return Object.assign({}, fallback);
  }
}

async function saveJson(key, value) {
  await PluginAPI.persistDataSynced(JSON.stringify(value), key);
}

/* ---------- String helpers ---------- */

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestamp(d) {
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

// Removes characters that are illegal in file names or that break Obsidian links.
function sanitizeSegment(name, fallback) {
  var s = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|#^\[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (s.length > 100) s = s.slice(0, 100).trim();
  return s || fallback;
}

// Obsidian tags allow letters, numbers, _ - and / (nested tags), no spaces.
function toTag(value) {
  var t = String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-\/]/gu, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^[\/-]+|[\/-]+$/g, '');
  // A tag must contain at least one non-numeric character.
  return /^[\d\/]*$/.test(t) ? '' : t;
}

function yamlStr(value) {
  // JSON strings are valid YAML double-quoted scalars.
  return JSON.stringify(String(value == null ? '' : value));
}

/* ---------- Task data ---------- */

// GitLab tasks store issueId as "group/project#iid".
function parseIssue(task) {
  if (!task || !task.issueId) return null;
  var type = String(task.issueType || '');
  var m = String(task.issueId).match(/^(.+)#(\d+)$/);
  return {
    type: type,
    id: String(task.issueId),
    path: m ? m[1] : '',
    number: m ? m[2] : '',
  };
}

function issueUrl(issue, settings) {
  if (!issue || issue.type !== 'GITLAB' || !issue.path || !issue.number) return '';
  var base = String(settings.gitlabBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base + '/' + issue.path + '/-/issues/' + issue.number;
}

function extractUrls(task) {
  var found = [];
  var seen = {};
  function add(url, title) {
    if (!url || seen[url] || !/^https?:\/\//i.test(url)) return;
    seen[url] = true;
    found.push({ url: url, title: title || '' });
  }

  (task.attachments || []).forEach(function (a) {
    if (a && typeof a.path === 'string') add(a.path, a.title);
  });

  var re = /https?:\/\/[^\s<>()\[\]"'`]+/gi;
  [task.title, task.notes].forEach(function (text) {
    if (!text) return;
    (String(text).match(re) || []).forEach(function (u) {
      add(u.replace(/[.,;:!?]+$/, ''));
    });
  });
  return found;
}

async function resolveTask(taskId) {
  if (taskId) return taskId;
  var selected = await PluginAPI.getSelectedTask();
  if (selected) return selected.id;
  if (trackedTaskId) return trackedTaskId;
  var focused = await PluginAPI.getFocusedTask();
  if (focused) return focused.id;
  return null;
}

/* ---------- Note content ---------- */

function buildNote(task, ctx) {
  var lines = [];
  lines.push('---');
  lines.push('title: ' + yamlStr(task.title));
  lines.push('sp_task_id: ' + yamlStr(task.id));
  lines.push('sp_project: ' + yamlStr(ctx.projectName));
  if (ctx.tagNames.length) {
    lines.push('sp_tags: [' + ctx.tagNames.map(yamlStr).join(', ') + ']');
  }
  if (ctx.parentTitle) lines.push('sp_parent: ' + yamlStr(ctx.parentTitle));
  if (task.dueDay) lines.push('due: ' + yamlStr(task.dueDay));
  if (ctx.urls.length) lines.push('url: ' + yamlStr(ctx.urls[0].url));
  if (ctx.issue) {
    lines.push('issue: ' + yamlStr(ctx.issue.type + ' ' + ctx.issue.id));
  }
  lines.push('created: ' + yamlStr(ctx.created.toISOString()));
  lines.push('tags:');
  ctx.noteTags.forEach(function (t) {
    lines.push('  - ' + yamlStr(t));
  });
  lines.push('---');
  lines.push('');
  // Properties only: the note body is left empty.
  return lines.join('\n');
}

/* ---------- Node scripts (data passed via args only) ---------- */

var WRITE_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const os = require('os');",
  'let [vault, segments, fileName, content] = args;',
  "if (vault === '~' || vault.startsWith('~/')) vault = path.join(os.homedir(), vault.slice(1));",
  "if (!path.isAbsolute(vault)) throw new Error('Vault path must be absolute: ' + vault);",
  "if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) throw new Error('Vault folder does not exist: ' + vault);",
  'const dir = path.join(vault, ...segments);',
  'const full = path.join(dir, fileName);',
  'const rel = path.relative(path.resolve(vault), path.resolve(full));',
  "if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Refusing to write outside the vault');",
  'fs.mkdirSync(dir, { recursive: true });',
  "fs.writeFileSync(full, content, { encoding: 'utf8', flag: 'wx' });",
  'return full;',
].join('\n');

var EXISTS_SCRIPT = "return require('fs').existsSync(args[0]);";

function nodeError(result) {
  var err = result && result.error;
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return (err.code ? err.code + ': ' : '') + (err.message || '');
}

async function fileExists(fullPath) {
  try {
    var r = await PluginAPI.executeNodeScript({ script: EXISTS_SCRIPT, args: [fullPath] });
    return !!(r && r.success && r.result === true);
  } catch (e) {
    return false;
  }
}

/* ---------- Task attachment ---------- */

async function addAttachment(task, attachment) {
  try {
    var current = Array.isArray(task.attachments) ? task.attachments.slice() : [];
    current.push(attachment);
    await PluginAPI.updateTask(task.id, { attachments: current });
    // The API marks attachments as "shouldn't modify": verify the change was applied.
    var state = await PluginAPI.getAppState();
    var updated = state.tasks[task.id];
    return !!(
      updated &&
      (updated.attachments || []).some(function (a) {
        return a && a.id === attachment.id;
      })
    );
  } catch (e) {
    PluginAPI.log.warn('[task-to-obsidian] could not add attachment', e);
    return false;
  }
}

/* ---------- Main action ---------- */

async function createNote(explicitTaskId, force) {
  if (isBusy) return;
  isBusy = true;
  try {
    if (typeof PluginAPI.executeNodeScript !== 'function') {
      PluginAPI.showSnack({
        msg: 'Obsidian notes can only be created in the desktop app.',
        type: 'ERROR',
      });
      return;
    }

    var settings = await loadJson(SETTINGS_KEY, DEFAULT_SETTINGS);
    if (!settings.vaultPath || !settings.vaultPath.trim()) {
      PluginAPI.showSnack({
        msg: 'Set your Obsidian vault path first.',
        type: 'WARNING',
        action: {
          label: 'Settings',
          onClick: function () {
            PluginAPI.showIndexHtmlAsView();
          },
        },
      });
      return;
    }

    var taskId = await resolveTask(explicitTaskId);
    if (!taskId) {
      PluginAPI.showSnack({
        msg: 'No active task. Select or start tracking a task first.',
        type: 'WARNING',
      });
      return;
    }

    var state = await PluginAPI.getAppState();
    var task = state.tasks[taskId];
    if (!task) {
      PluginAPI.showSnack({ msg: 'Task not found.', type: 'ERROR' });
      return;
    }

    // Duplicate check
    var links = await loadJson(LINKS_KEY, {});
    if (!force && links[taskId] && (await fileExists(links[taskId]))) {
      PluginAPI.showSnack({
        msg: 'This task already has an Obsidian note.',
        type: 'INFO',
        action: {
          label: 'Create new',
          onClick: function () {
            createNote(taskId, true);
          },
        },
      });
      return;
    }

    var parent = task.parentId ? state.tasks[task.parentId] : null;
    var projectId = task.projectId || (parent && parent.projectId) || null;
    var project = projectId ? state.projects[projectId] : null;
    var projectName = project ? project.title : settings.noProjectFolder || 'No project';

    var tagNames = (task.tagIds || [])
      .map(function (id) {
        return state.tags[id] ? state.tags[id].title : null;
      })
      .filter(Boolean);

    var issue = parseIssue(task) || parseIssue(parent);
    if (issue && issue.type === 'GITLAB' && !String(settings.gitlabBaseUrl || '').trim()) {
      PluginAPI.showSnack({
        msg: 'Set the GitLab base URL in the plugin settings first.',
        type: 'WARNING',
        action: {
          label: 'Settings',
          onClick: function () {
            PluginAPI.showIndexHtmlAsView();
          },
        },
      });
      return;
    }
    var urls = extractUrls(task);
    if (!urls.length && parent) urls = extractUrls(parent);
    var gitlabUrl = issueUrl(issue, settings);
    if (gitlabUrl) {
      urls = urls.filter(function (u) {
        return u.url !== gitlabUrl;
      });
      urls.unshift({ url: gitlabUrl, title: issue.path + '#' + issue.number });
    }

    var noteTags = ['super-productivity'];
    if (project) noteTags.push(toTag(project.title));
    if (issue && issue.path) noteTags.push(toTag(issue.path));
    noteTags = noteTags.filter(function (t, i) {
      return t && noteTags.indexOf(t) === i;
    });

    // "#2 Add training pipeline" -> "Add training pipeline (2)"
    var baseTitle = String(task.title || '');
    var issueNumber = issue && issue.number;
    var titleNum = baseTitle.match(/^\s*#(\d+)\s+/);
    if (titleNum) {
      issueNumber = issueNumber || titleNum[1];
      baseTitle = baseTitle.slice(titleNum[0].length);
    }
    var displayName = sanitizeSegment(baseTitle, 'untitled');
    if (issueNumber && task.issueId) displayName += ' (' + issueNumber + ')';

    var now = new Date();
    var projectSegment = sanitizeSegment(projectName, 'No project');
    var segments = String(settings.folderTemplate || '{project}')
      .split('/')
      .map(function (seg) {
        return seg.split('{project}').join(projectSegment);
      })
      .map(function (seg) {
        return sanitizeSegment(seg, '');
      })
      .filter(Boolean);

    var fileName = timestamp(now) + ' - ' + displayName + '.md';

    var content = buildNote(task, {
      projectName: projectName,
      parentTitle: parent ? parent.title : '',
      tagNames: tagNames,
      noteTags: noteTags,
      issue: issue,
      urls: urls,
      created: now,
    });

    var result = await PluginAPI.executeNodeScript({
      script: WRITE_SCRIPT,
      args: [settings.vaultPath.trim(), segments, fileName, content],
      timeout: 10000,
    });

    if (!result || !result.success || typeof result.result !== 'string') {
      PluginAPI.log.err('[task-to-obsidian] write failed', result);
      PluginAPI.showSnack({
        msg: 'Could not create note: ' + nodeError(result),
        type: 'ERROR',
      });
      return;
    }

    var fullPath = result.result;

    // Save link in SP
    links[taskId] = fullPath;
    await saveJson(LINKS_KEY, links);

    // Save the link as a task attachment; the task's notes stay untouched.
    var attached = true;
    if (settings.appendLinkToTask !== false) {
      attached = await addAttachment(task, {
        id: 'obsidian-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        type: 'LINK',
        path: 'obsidian://open?path=' + encodeURIComponent(fullPath),
        title: 'Obsidian: ' + fileName.replace(/\.md$/, ''),
        icon: 'description',
      });
    }

    PluginAPI.showSnack(
      attached
        ? { msg: 'Obsidian note created: ' + fileName, type: 'SUCCESS' }
        : {
            msg: 'Note created, but the link could not be attached to the task: ' + fileName,
            type: 'WARNING',
          },
    );
  } catch (e) {
    PluginAPI.log.err('[task-to-obsidian] error', e);
    PluginAPI.showSnack({
      msg: 'Could not create note: ' + (e && e.message ? e.message : String(e)),
      type: 'ERROR',
    });
  } finally {
    isBusy = false;
  }
}

/* ---------- Registration ---------- */

PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, function (payload) {
  trackedTaskId = payload && payload.current ? payload.current.id : null;
});

PluginAPI.registerHeaderButton({
  label: BUTTON_LABEL,
  icon: 'note_add',
  onClick: function () {
    createNote(null, false);
  },
});

PluginAPI.registerTaskContextMenuEntry({
  id: 'create-obsidian-note',
  label: BUTTON_LABEL,
  icon: 'note_add',
  onClick: function (context) {
    return createNote(context.taskId, false);
  },
});

PluginAPI.registerShortcut({
  id: 'create-obsidian-note',
  label: BUTTON_LABEL,
  onExec: function () {
    createNote(null, false);
  },
});

PluginAPI.registerConfigHandler(function () {
  PluginAPI.showIndexHtmlAsView();
});

if (typeof PluginAPI.onReady === 'function') {
  PluginAPI.onReady(async function () {
    var settings = await loadJson(SETTINGS_KEY, DEFAULT_SETTINGS);
    if (!settings.vaultPath) {
      PluginAPI.log.info('[task-to-obsidian] vault path not configured yet');
    }
  });
}
