/* Gleaner v3 — Theme switcher (place in <head> before stylesheets) */
(function () {
  var KEY = 'gleaner-theme';

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    document.querySelectorAll('.tsw').forEach(function (b) {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
  }

  /* Apply immediately (before paint) to prevent flash */
  var saved;
  try { saved = localStorage.getItem(KEY) || 'light'; } catch (e) { saved = 'light'; }
  applyTheme(saved);

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(saved); /* sync button states after DOM ready */
    document.querySelectorAll('.tsw').forEach(function (b) {
      b.addEventListener('click', function () { applyTheme(b.dataset.theme); });
    });
  });
})();
