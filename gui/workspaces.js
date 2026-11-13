import { h } from './dom.js';

/** Keep each workspace mounted so controls and results survive navigation. */
export function createWorkspaces(label, entries, { sidebar = false, initial, onSelect } = {}) {
  const bar = h(sidebar ? 'nav.workspace-nav' : 'div.module-tabs', { 'aria-label': label, role: sidebar ? undefined : 'group' });
  const content = h(sidebar ? 'main.workspace-content' : 'div.module-content');
  const buttons = new Map();
  let active;

  function select(id, notify = true) {
    if (!buttons.has(id) || id === active) return;
    active = id;
    for (const [key, , panel] of entries) {
      panel.hidden = key !== id;
      buttons.get(key).setAttribute('aria-pressed', String(key === id));
    }
    if (notify) onSelect?.(id);
  }

  for (const [id, name, panel] of entries) {
    const button = h('button', { type: 'button', on: { click: () => select(id) } }, name);
    buttons.set(id, button);
    bar.append(button);
    content.append(panel);
  }
  select(buttons.has(initial) ? initial : entries[0][0], false);
  return { el: h(sidebar ? 'div.workbench' : 'div.module-views', bar, content), select };
}
