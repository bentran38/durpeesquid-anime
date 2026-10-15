// Drag-to-reorder for the picks in a list: mouse, and press-and-hold on touch. Reordering is reported
// through the `reorder(from, to)` callback (keyboard moves are handled where the list is rendered).

const HOLD_MS = 220; // touch and pen: press and hold before a drag starts, so the page can still scroll
const MOVE_PX = 5; // mouse: how far to move before a press becomes a drag
const SLOP_PX = 10; // touch: moving this far before the hold ends means the user is scrolling

// Makes the picks in `list` draggable. While dragging, a copy follows the pointer and the pick
// it would land on is outlined; the order only changes on drop.
export function makeSortable(list, reorder) {
  let press = null;
  const picks = () => [...list.querySelectorAll('[data-index]')];

  const targetAt = (x, y) => {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const n of picks()) {
      const r = n.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(n.dataset.index);
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = n;
      }
    }
    return nearest ? Number(nearest.dataset.index) : null;
  };

  const update = () => {
    if (!press?.ghost) return;
    press.ghost.style.left = `${press.x - press.offX}px`;
    press.ghost.style.top = `${press.y - press.offY}px`;
    press.to = targetAt(press.x, press.y);
    for (const n of picks()) n.classList.toggle('drop-target', Number(n.dataset.index) === press.to && press.to !== press.from);
    press.scroll = press.y < 70 ? -1 : press.y > window.innerHeight - 70 ? 1 : 0; // scroll near the screen edge
  };

  const loop = () => {
    if (!press?.ghost) return;
    if (press.scroll) {
      window.scrollBy(0, press.scroll * 14);
      update();
    }
    press.raf = requestAnimationFrame(loop);
  };

  const begin = () => {
    const r = press.li.getBoundingClientRect();
    press.offX = press.startX - r.left;
    press.offY = press.startY - r.top;
    // the copy sits in a bare clone of the list so it keeps the list's styles
    const ghost = list.cloneNode(false);
    ghost.removeAttribute('id');
    ghost.classList.add('drag-ghost');
    const copy = press.li.cloneNode(true);
    copy.removeAttribute('data-index');
    copy.removeAttribute('tabindex');
    ghost.append(copy);
    ghost.style.width = `${r.width}px`;
    document.body.append(ghost);
    press.ghost = ghost;
    press.li.classList.add('drag-source');
    document.body.classList.add('is-dragging');
    update();
    loop();
  };

  const finish = (commit) => {
    const { from, to } = press;
    clearTimeout(press.timer);
    cancelAnimationFrame(press.raf);
    press.ghost?.remove();
    press.li.classList.remove('drag-source');
    for (const n of picks()) n.classList.remove('drop-target');
    document.body.classList.remove('is-dragging');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    document.removeEventListener('keydown', onKey);
    const dragged = Boolean(press.ghost);
    press = null;
    if (commit && dragged && to != null && to !== from) reorder(from, to);
  };

  const onMove = (ev) => {
    if (!press || ev.pointerId !== press.pointerId) return;
    press.x = ev.clientX;
    press.y = ev.clientY;
    if (press.ghost) return update();
    const moved = Math.hypot(press.x - press.startX, press.y - press.startY);
    if (press.touchLike && moved > SLOP_PX) finish(false); // the finger is scrolling, not dragging
    else if (!press.touchLike && moved > MOVE_PX) begin();
  };
  const onUp = (ev) => press && ev.pointerId === press.pointerId && finish(true);
  const onCancel = (ev) => press && ev.pointerId === press.pointerId && finish(false);
  const onKey = (ev) => ev.key === 'Escape' && press && finish(false);

  list.addEventListener('pointerdown', (ev) => {
    const li = ev.target.closest('[data-index]');
    if (press || !li || ev.target.closest('button') || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    const touchLike = ev.pointerType !== 'mouse';
    press = { li, from: Number(li.dataset.index), to: null, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, x: ev.clientX, y: ev.clientY, touchLike, ghost: null, raf: 0, scroll: 0 };
    if (touchLike) press.timer = setTimeout(() => press && !press.ghost && begin(), HOLD_MS);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
  });

  // once a drag is live, keep the page from scrolling or selecting text under the finger
  list.addEventListener('touchmove', (ev) => press?.ghost && ev.preventDefault(), { passive: false });
  list.addEventListener('selectstart', (ev) => press && ev.preventDefault());
  list.addEventListener('contextmenu', (ev) => press && ev.preventDefault());
}
