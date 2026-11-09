// Activity log / change history (placeholder).
import { el } from '../core/ui.js';

export default {
  id: 'activity',
  label: 'Activity Log',
  icon: '🕘',
  render(container) { container.appendChild(el('div', { class: 'view active' }, el('div', { class: 'empty' }, 'Activity Log — coming soon'))); },
  refresh() {},
  destroy() {}
};
