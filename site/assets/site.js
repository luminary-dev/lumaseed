/* Cover + docs behaviour: theme toggle, scroll reveal, copy buttons and
   the docs table-of-contents highlight. No dependencies. */
(function () {
  'use strict';

  /* ---- theme ---- */
  var tt = document.getElementById('tt');
  if (tt) {
    tt.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('lumaseed-theme', next); } catch (e) { /* private mode */ }
    });
  }

  /* ---- scroll reveal ---- */
  var reveals = document.querySelectorAll('.up');
  if (!('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---- copy-to-clipboard (hero command + every docs code block) ---- */
  function flash(btn) {
    var svg = btn.querySelector('svg');
    if (!svg) return;
    var original = svg.innerHTML;
    svg.innerHTML = '<path d="M20 6L9 17l-5-5"/>';
    btn.style.color = 'var(--a-text)';
    setTimeout(function () { svg.innerHTML = original; btn.style.color = ''; }, 1400);
  }

  function copyText(text, btn) {
    var done = function () { flash(btn); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else {
      fallback(text, done);
    }
  }

  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
    ta.remove();
    done();
  }

  var heroCopy = document.getElementById('cmd-copy');
  if (heroCopy) {
    heroCopy.addEventListener('click', function () {
      var el = document.getElementById('cmd-text');
      copyText(el ? el.textContent.trim() : '', heroCopy);
    });
  }

  document.querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var pre = document.getElementById(btn.getAttribute('data-copy-target'));
      copyText(pre ? pre.textContent.trim() : '', btn);
    });
  });

  /* ---- docs: highlight the section currently in view ---- */
  var tocLinks = document.querySelectorAll('.toc a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var link = byId[e.target.id];
        if (!link) return;
        if (e.isIntersecting) {
          tocLinks.forEach(function (a) { a.classList.remove('active'); });
          link.classList.add('active');
        }
      });
    }, { rootMargin: '-84px 0px -70% 0px', threshold: 0 });
    Object.keys(byId).forEach(function (id) {
      var sec = document.getElementById(id);
      if (sec) spy.observe(sec);
    });
  }
})();
