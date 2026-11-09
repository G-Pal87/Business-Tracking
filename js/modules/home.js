// Home screen (placeholder).
import { el } from '../core/ui.js';

export default {
  id: 'home',
  label: 'Home',
  icon: '🏡',
  render(container) { container.appendChild(el('div', { class: 'view active' }, el('div', { class: 'empty' }, 'Home — coming soon'))); },
  refresh() {},
  destroy() {}
};
