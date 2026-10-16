// Responsive navigation stays keyboard accessible and works independently of htmx.
const menu = document.getElementById('menu');
const sidebar = document.getElementById('sidebar');
const backdrop = document.querySelector('.sidebar-backdrop');
if (menu && sidebar && backdrop) {
  const desktop = window.matchMedia('(min-width: 641px)');
  const setOpen = (open) => {
    sidebar.classList.toggle('show', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    backdrop.hidden = !open;
    sidebar.inert = !desktop.matches && !open;
  };
  setOpen(false);
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    setOpen(open);
    if (open) sidebar.querySelector('a').focus();
  });
  backdrop.addEventListener('click', () => { setOpen(false); menu.focus(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      menu.focus();
    }
    if (event.key === 'Tab' && menu.getAttribute('aria-expanded') === 'true') {
      const links = [...sidebar.querySelectorAll('a, button')];
      const first = links[0];
      const last = links[links.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === menu)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); menu.focus();
      }
    }
  });
  desktop.addEventListener('change', () => setOpen(false));
}
