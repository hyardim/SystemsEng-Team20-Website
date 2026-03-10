function initializeHeader() {
  const page = document.body.dataset.page;
  const header = document.querySelector('.site-header');
  const nav = document.querySelector('.site-nav');
  const toggle = document.querySelector('.nav-toggle');
  const githubBtn = document.querySelector('.site-header__github-btn');

  if (page && nav) {
    const activeLink = nav.querySelector(`[data-nav="${page}"]`);
    if (activeLink) {
      activeLink.classList.add('is-active');
    }
  }

  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('is-open'));
  }

  if (githubBtn) {
    githubBtn.addEventListener('click', () => {
      // Placeholder: add repo URL later.
    });
  }

  const fallbackLogoSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="340" height="64" viewBox="0 0 340 64" role="img" aria-label="Ambience-AI-1.5">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#005eb8"/>
          <stop offset="1" stop-color="#003087"/>
        </linearGradient>
      </defs>
      <circle cx="24" cy="32" r="12" fill="url(#g)"/>
      <path d="M24 23 L24 41 M15 32 L33 32" stroke="white" stroke-width="3" stroke-linecap="round"/>
      <text x="44" y="39" font-family="Inter, Arial, sans-serif" font-size="22" font-weight="700" fill="url(#g)">Ambience-AI-1.5</text>
    </svg>
  `;
  const fallbackLogoSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fallbackLogoSvg)}`;

  document.querySelectorAll('.brand__logo-image').forEach((logoImage) => {
    const applyFallback = () => {
      logoImage.src = fallbackLogoSrc;
      logoImage.alt = 'Ambience-AI-1.5 logo';
    };

    logoImage.addEventListener('error', applyFallback, { once: true });
    if (logoImage.complete && logoImage.naturalWidth === 0) {
      applyFallback();
    }
  });

  if (header) {
    const updateHeaderScrollState = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
    };

    updateHeaderScrollState();
    window.addEventListener('scroll', updateHeaderScrollState, { passive: true });
  }
}

function renderToc() {
  const host = document.getElementById('page-toc');
  if (!host) return;

  const headings = [...document.querySelectorAll('main h2')]
    .map((heading) => {
      if (!heading.id) {
        const parentSection = heading.closest('section[id]');
        if (parentSection?.id) {
          heading.id = parentSection.id;
        }
      }
      return heading;
    })
    .filter((heading) => heading.id);
  if (!headings.length) {
    host.innerHTML = '<p class="muted">No page outline available.</p>';
    return;
  }

  host.innerHTML = `
    <h3>On this page</h3>
    <ul>
      ${headings.map((heading) => `<li><a href="#${heading.id}">${heading.textContent}</a></li>`).join('')}
    </ul>
  `;
}

function renderFooter() {
  const footer = document.querySelector('.site-footer');
  if (!footer) return;

  footer.innerHTML = `
    <div class="site-footer__inner site-footer__inner--custom">
      <section class="site-footer__brand">
        <h3>Ambience<br/>AI<br/>1.5</h3>
      </section>

      <section class="site-footer__about">
        <h4 class="site-footer__heading">About Us</h4>
        <p class="site-footer__about-text">Clinical guidance + AI insights for specialist-supported consultation workflows.</p>
        <div class="site-footer__links site-footer__social">
          <a href="#" data-placeholder-link="github" aria-label="GitHub">
            <img src="assets/icons/github.svg" alt="" aria-hidden="true" />
            <span>GitHub</span>
          </a>
          <a href="#" data-placeholder-link="youtube" aria-label="YouTube">
            <img src="assets/icons/youtube.svg" alt="" aria-hidden="true" />
            <span>YouTube</span>
          </a>
          <a href="mailto:daniel.rotariu.24@ucl.ac.uk" aria-label="Contact us">
            <img src="assets/icons/contact.svg" alt="" aria-hidden="true" />
            <span>Contact Us</span>
          </a>
        </div>
      </section>

      <section class="site-footer__docs">
        <h4 class="site-footer__heading">Documentation</h4>
        <div class="site-footer__docs-grid">
          <a href="requirements.html">Requirements</a>
          <a href="testing.html">Testing</a>
          <a href="research.html">Research</a>
          <a href="testing.html">Evaluation</a>
          <a href="ui-design.html">UI Design</a>
          <a href="appendices.html">Appendices</a>
          <a href="system-design.html">System Design</a>
          <a href="appendices.html#external-links">Blog</a>
          <a href="implementation.html">Implementation</a>
        </div>
      </section>

      <section class="site-footer__partners">
        <h4 class="site-footer__heading">Project Partners</h4>
        <div class="site-footer__partners-list">
          <a class="partner-link" href="https://www.nhs.uk" target="_blank" rel="noreferrer" aria-label="NHS website">
            <img class="partner-logo-image" src="assets/partners/nhs-logo.png" alt="NHS" data-label="NHS" />
          </a>
          <a class="partner-link" href="https://www.intel.com" target="_blank" rel="noreferrer" aria-label="Intel website">
            <img class="partner-logo-image" src="assets/partners/intel-logo.png" alt="Intel" data-label="Intel" />
          </a>
          <a class="partner-link" href="https://www.ucl.ac.uk" target="_blank" rel="noreferrer" aria-label="UCL website">
            <img class="partner-logo-image" src="assets/partners/ucl-logo.png" alt="UCL" data-label="UCL" />
          </a>
        </div>
      </section>
    </div>
    <p class="site-footer__copyright">Copyright © 2026 Ambience AI 1.5. All rights reserved.</p>
  `;
}

function markExternalPlaceholders() {
  document.querySelectorAll('[data-placeholder-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      alert('Placeholder link: replace with your final URL before submission.');
    });
  });
}

function initializePartnerLogos() {
  document.querySelectorAll('.partner-logo-image').forEach((logoImage) => {
    const parent = logoImage.closest('.partner-link');
    const label = logoImage.dataset.label || 'Partner';

    const showFallback = () => {
      if (!parent) return;
      parent.classList.add('is-missing-logo');
      parent.setAttribute('data-fallback', label);
    };

    logoImage.addEventListener('error', showFallback, { once: true });
    if (logoImage.complete && logoImage.naturalWidth === 0) {
      showFallback();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initializeHeader();
  renderToc();
  renderFooter();
  markExternalPlaceholders();
  initializePartnerLogos();
});
