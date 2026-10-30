import './styles.scss';

const menuButton = document.querySelector('.menu-trigger[aria-controls="site-menu"]');
const menu = document.getElementById('site-menu');

if (menuButton && menu) {
  const setMenuOpen = (open) => {
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
  };

  menuButton.addEventListener('click', () => {
    setMenuOpen(menu.hidden);
  });

  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !menuButton.contains(event.target)) {
      setMenuOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      setMenuOpen(false);
      menuButton.focus();
    }
  });

  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      setMenuOpen(false);
    }
  });
}

// The text fallback remains visible until an icon actually loads, including when
// the image finished loading before the module was evaluated.
document.querySelectorAll('.icon img').forEach((image) => {
  const icon = image.closest('.icon');
  const updateIcon = () => {
    icon.classList.toggle('is-loaded', image.complete && image.naturalWidth > 0);
  };

  image.addEventListener('load', updateIcon);
  image.addEventListener('error', updateIcon);
  updateIcon();
});

// The two decorative service icons have no text fallback in the markup.
document.querySelectorAll('.deco-code img, .deco-network img').forEach((image) => {
  const showFallback = () => {
    image.removeEventListener('error', showFallback);
    const container = image.parentElement;
    if (!container) return;
    const fallback = document.createElement('span');
    fallback.textContent = container.classList.contains('deco-code') ? '‹/›' : '⌘';
    if (container.classList.contains('deco-network')) fallback.style.color = '#fff';
    image.replaceWith(fallback);
  };

  image.addEventListener('error', showFallback, { once: true });
  if (image.complete && image.naturalWidth === 0) showFallback();
});
