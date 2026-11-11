/* Shared image inspection; opening a photo never changes the 3D selection. */
window.planrecPhotoViewer = function () {
  const dialog = document.createElement('dialog');
  dialog.className = 'photo-viewer';
  dialog.setAttribute('aria-label', 'Просмотр фотографии');
  dialog.innerHTML = `<button class="photo-close" aria-label="Закрыть (Esc)">×</button>
    <div class="photo-stage"><button class="photo-prev" aria-label="Предыдущее фото (←)">‹</button>
    <img alt=""><button class="photo-next" aria-label="Следующее фото (→)">›</button></div>
    <div class="photo-caption" aria-live="polite"></div>
    <a class="photo-report" hidden>Отчёт фото ↗</a>`;
  document.body.append(dialog);
  const image = dialog.querySelector('img'), caption = dialog.querySelector('.photo-caption');
  const report = dialog.querySelector('.photo-report');
  const previous = dialog.querySelector('.photo-prev'), next = dialog.querySelector('.photo-next');
  let items = [], index = 0, opener;
  function show() {
    const item = items[index];
    image.src = item.src; image.alt = item.caption || '';
    caption.textContent = [item.caption, `${index + 1} / ${items.length}`].filter(Boolean).join('\n');
    report.hidden = !item.href;
    if (item.href) report.href = item.href; else report.removeAttribute('href');
    previous.hidden = next.hidden = items.length < 2;
  }
  function step(direction) {
    index = (index + direction + items.length) % items.length;
    show();
  }
  previous.onclick = () => step(-1);
  next.onclick = () => step(1);
  dialog.querySelector('.photo-close').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.classList.contains('photo-stage')) dialog.close();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('photo-viewer-open');
    image.removeAttribute('src');
    if (opener?.isConnected) opener.focus({preventScroll: true});
  });
  return {
    open(photos, selectedIndex, trigger = document.activeElement) {
      if (!photos?.length || !photos[selectedIndex]) return;
      items = photos; index = selectedIndex; opener = trigger;
      show();
      if (!dialog.open) dialog.showModal();
      document.body.classList.add('photo-viewer-open');
      dialog.querySelector('.photo-close').focus({preventScroll: true});
    },
  };
};
