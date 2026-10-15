// Small DOM helpers and the Top 10 / 3x3 renderer, shared by the lists editor and the profile page.

export const $ = (id) => document.getElementById(id);

export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};

export const KINDS = { top10: { label: 'Top 10', max: 10 }, grid3: { label: '3x3', max: 9 } };

export function poster(url, className) {
  const img = el('img', { className, alt: '', loading: 'lazy', draggable: false });
  if (typeof url === 'string' && url.startsWith('https://')) img.src = url;
  else img.removeAttribute('src');
  return img;
}

// What a list stores about a pick, so other people can see it without reading the owner's library.
export const itemFrom = (e) => ({
  source_id: e.source_id,
  title: e.title,
  poster_url: e.poster_url,
  rating: e.rating == null ? null : Number(e.rating),
  year: e.release_date ? Number(String(e.release_date).slice(0, 4)) : null,
});

export const meta = (it) => [it.year, it.rating != null && `★ ${Number(it.rating).toFixed(1)}`].filter(Boolean).join(' · ');

// Pass `edit` ({ reorder, remove }) to make the picks draggable and removable; omit it for a
// read-only list.
export function renderList(kind, items, edit) {
  // Each editable pick carries its position so dragging and the keyboard know where it is.
  const editable = (li, i) => {
    if (!edit) return li;
    li.dataset.index = String(i);
    li.tabIndex = 0;
    li.title = items[i].title;
    li.onkeydown = (ev) => {
      if (!ev.shiftKey || ev.target !== li) return;
      const down = kind === 'grid3' ? 3 : 1;
      const step = { ArrowUp: -down, ArrowDown: down, ArrowLeft: -1, ArrowRight: 1 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      edit.reorder(i, i + step, true);
    };
    return li;
  };
  const removeButton = (i) =>
    edit &&
    el(
      'div',
      { className: 'ctl' },
      el('button', { type: 'button', className: 'ghost', textContent: '✕', ariaLabel: `Remove ${items[i].title}`, onclick: () => edit.remove(i) }),
    );

  if (kind === 'top10') {
    return el(
      'ol',
      { className: 'top10', ariaLabel: 'Top 10' },
      ...items.map((it, i) =>
        editable(
          el(
            'li',
            { title: edit ? '' : it.title },
            el('span', { className: 'num', textContent: String(i + 1) }),
            poster(it.poster_url, 'poster'),
            el('div', { className: 'info' }, el('span', { textContent: it.title }), el('small', { textContent: meta(it) })),
            removeButton(i),
          ),
          i,
        ),
      ),
    );
  }

  const tiles = items.map((it, i) =>
    editable(el('li', { className: 'tile', title: it.title }, poster(it.poster_url, 'cover'), el('span', { className: 'cap', textContent: it.title }), removeButton(i)), i),
  );
  while (tiles.length < KINDS.grid3.max) tiles.push(el('li', { className: 'tile empty' }));
  return el('ol', { className: 'grid3', ariaLabel: '3x3' }, ...tiles);
}
