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

  /* ---- cover header: float on the dark hero, theme up past it ----
     The hero is a dark stage in both themes, so a themed header bar sitting on
     top of it reads as a bug in light mode. The header stays transparent with
     light text while it is over the hero, then adopts the page colours once the
     hero has scrolled by. */
  var coverHeader = document.querySelector('body.cover .hd');
  var heroEl = document.querySelector('.hero');
  if (coverHeader && heroEl) {
    var syncHeader = function () {
      coverHeader.classList.toggle('scrolled', window.scrollY > heroEl.offsetHeight - 60);
    };
    syncHeader();
    window.addEventListener('scroll', syncHeader, { passive: true });
    window.addEventListener('resize', syncHeader);
  }

  /* ---- hero: lazy-load the Hyperspeed WebGL backdrop ----
     The CSS gradient underneath is the real background; this fades in over it
     once the page is idle. Skipped entirely for reduced-motion users, on tiny
     screens (cost outweighs the payoff), and wherever WebGL is unavailable —
     in every one of those cases the gradient simply stays. */
  var fx = document.getElementById('hero-fx');
  if (fx) {
    var skip =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      window.matchMedia('(max-width: 700px)').matches ||
      !(function () {
        try {
          var c = document.createElement('canvas');
          return !!(window.WebGLRenderingContext &&
            (c.getContext('webgl2') || c.getContext('webgl')));
        } catch (e) { return false; }
      })();

    if (!skip) {
      var start = function () {
        import('/assets/hyperspeed.min.js').then(function (mod) {
          mod.initHyperspeed(fx, {
            distortion: 'turbulentDistortion',
            fov: 90,
            fovSpeedUp: 150,
            speedUp: 2,
            carLightsFade: 0.4,
            totalSideLightSticks: 20,
            lightPairsPerRoadWay: 40,
            colors: {
              // Brand palette: lime accent for our lane, cool slate oncoming.
              roadColor: 0x05050a,
              islandColor: 0x07070d,
              background: 0x05050a,
              shoulderLines: 0x1c1c22,
              brokenLines: 0x26262e,
              leftCars: [0xa3e635, 0x84cc16, 0x65a30d],
              rightCars: [0x3f3f46, 0x52525b, 0x27272a],
              sticks: 0xa3e635
            }
          });
          fx.classList.add('ready');
        }).catch(function () {
          /* bundle blocked or failed — the gradient is already correct */
        });
      };
      // Wait for first paint to finish before pulling ~700KB of WebGL.
      if ('requestIdleCallback' in window) {
        requestIdleCallback(start, { timeout: 2500 });
      } else {
        window.addEventListener('load', function () { setTimeout(start, 400); });
      }
    }
  }

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
