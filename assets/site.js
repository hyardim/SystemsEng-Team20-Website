function initializeHeader() {
  const repoUrl = 'https://github.com/hyardim/Ambience-AI-1.5';
  const page = document.body.dataset.page;
  const header = document.querySelector('.site-header');
  const nav = document.querySelector('.site-nav');
  const toggle = document.querySelector('.nav-toggle');
  const githubBtn = document.querySelector('.site-header__github-btn');

  // Inject icon + wordmark into brand
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.innerHTML = `
      <span class="brand-icon" aria-hidden="true">
        <svg viewBox="0 0 72 68" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#00d4f5"/>
              <stop offset="100%" stop-color="#0099cc"/>
            </linearGradient>
          </defs>
          <rect x="2" y="2" width="68" height="52" rx="11" fill="url(#bGrad)"/>
          <rect x="2" y="2" width="68" height="52" rx="11" fill="none" stroke="rgba(180,245,255,0.5)" stroke-width="1.2"/>
          <path d="M16 54 L10 66 L26 56" fill="url(#bGrad)"/>
          <polyline points="8,28 16,28 20,17 24,39 28,28 32,21 36,33 40,28 50,28 64,28"
            stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>
      </span>
      <span class="brand-wordmark">
        <span class="brand-wordmark__name">Ambience</span><span class="brand-wordmark__ai"> AI</span>
      </span>
    `;
  }

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
    if (githubBtn.tagName === 'A') {
      githubBtn.href = repoUrl;
      githubBtn.target = '_blank';
      githubBtn.rel = 'noopener noreferrer';
    } else {
      githubBtn.addEventListener('click', () => {
        window.open(repoUrl, '_blank', 'noopener,noreferrer');
      });
    }
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

function scrollElementToViewportCenter(targetElement) {
  if (!targetElement) return;

  const headerEl = document.querySelector('.site-header');
  const headerHeight = headerEl ? headerEl.getBoundingClientRect().height : 0;
  const targetTop = window.scrollY + targetElement.getBoundingClientRect().top;
  const availableViewportHeight = Math.max(window.innerHeight - headerHeight, 0);
  const adjustedTop =
    targetTop
    - headerHeight
    - Math.max((availableViewportHeight - targetElement.offsetHeight) / 2, 0);
  const prefersReducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.scrollTo({
    top: Math.max(0, adjustedTop),
    behavior: prefersReducedMotion ? 'auto' : 'smooth',
  });
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
      ${headings.map((heading) => `<li><a href="#${heading.id}" data-toc-link="${heading.id}">${heading.textContent}</a></li>`).join('')}
    </ul>
  `;

  const links = [...host.querySelectorAll('[data-toc-link]')];
  if (!links.length) return;

  const setActiveLink = (id) => {
    links.forEach((link) => {
      link.classList.toggle('is-active', link.dataset.tocLink === id);
    });
  };

  const getCurrentSectionId = () => {
    const headerEl = document.querySelector('.site-header');
    const headerHeight = headerEl ? headerEl.getBoundingClientRect().height : 0;
    const scrollOffset = headerHeight + ((window.innerHeight / 2) - headerHeight) * 0.5;
    let currentId = headings[0].id;

    for (const heading of headings) {
      if (heading.getBoundingClientRect().top - scrollOffset <= 0) {
        currentId = heading.id;
      } else {
        break;
      }
    }

    return currentId;
  };

  const updateActiveFromScroll = () => {
    setActiveLink(getCurrentSectionId());
  };

  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      const targetId = link.dataset.tocLink;
      const targetHeading = headings.find((heading) => heading.id === targetId);
      if (!targetHeading) return;

      event.preventDefault();

      const targetTop = window.scrollY + targetHeading.getBoundingClientRect().top;
      const headerEl = document.querySelector('.site-header');
      const headerHeight = headerEl ? headerEl.getBoundingClientRect().height : 0;
      const desiredViewportY = headerHeight + ((window.innerHeight / 2) - headerHeight) * 0.5;
      const adjustedTop = targetTop - desiredViewportY + (targetHeading.offsetHeight / 2);

      window.scrollTo({
        top: Math.max(0, adjustedTop),
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });

      if (targetId) {
        history.replaceState(null, '', `#${targetId}`);
        setActiveLink(targetId);
      }
    });
  });

  updateActiveFromScroll();
  window.addEventListener('scroll', updateActiveFromScroll, { passive: true });

  if (window.location.hash) {
    const hashed = window.location.hash.replace('#', '');
    if (hashed) setActiveLink(hashed);
  }
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
          <a href="requirements/">Requirements</a>
          <a href="testing/">Testing</a>
          <a href="research/">Research</a>
          <a href="testing/">Evaluation</a>
          <a href="ui-design/">UI Design</a>
          <a href="appendices/">Appendices</a>
          <a href="system-design/">System Design</a>
          <a href="blog/">Blog</a>
          <a href="implementation/">Implementation</a>
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

function initializeHeroStackCycle() {
  const heroStack = document.querySelector('.hero-home__visual');
  if (!heroStack) return;

  const stackCards = [...heroStack.querySelectorAll('.project-shot')];
  if (stackCards.length < 3) return;
  const actionButton = heroStack.querySelector('.hero-stack-action');

  const roleClasses = ['project-shot--back', 'project-shot--mid', 'project-shot--front'];
  let rolesByCard = stackCards.map((card) => roleClasses.find((role) => card.classList.contains(role)));
  if (rolesByCard.some((role) => !role)) return;

  const applyRoles = () => {
    stackCards.forEach((card, index) => {
      roleClasses.forEach((role) => card.classList.remove(role));
      card.classList.add(rolesByCard[index]);
    });
  };

  const rotateRoles = () => {
    rolesByCard = [rolesByCard[1], rolesByCard[2], rolesByCard[0]];
    applyRoles();
  };

  heroStack.addEventListener('click', rotateRoles);

  if (actionButton) {
    actionButton.addEventListener('click', (event) => {
      event.stopPropagation();
      rotateRoles();
    });
  }
}

function initializeProjectTabs() {
  document.querySelectorAll('[data-project-tabs]').forEach((tabsRoot) => {
    const tabs = [...tabsRoot.querySelectorAll('[data-tab-target]')];
    const panels = [...tabsRoot.querySelectorAll('[data-tab-panel]')];
    if (!tabs.length || !panels.length) return;

    const activateTab = (target) => {
      tabs.forEach((tab) => {
        const isActive = tab.dataset.tabTarget === target;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tab.tabIndex = isActive ? 0 : -1;
      });

      panels.forEach((panel) => {
        const isActive = panel.dataset.tabPanel === target;
        panel.classList.toggle('is-active', isActive);
        panel.hidden = !isActive;
      });
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activateTab(tab.dataset.tabTarget));

      tab.addEventListener('keydown', (event) => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();

        let nextIndex = index;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;

        const nextTab = tabs[nextIndex];
        activateTab(nextTab.dataset.tabTarget);
        nextTab.focus();
      });
    });

    const initiallyActive = tabs.find((tab) => tab.classList.contains('is-active')) || tabs[0];
    activateTab(initiallyActive.dataset.tabTarget);
  });
}

function initBlogNav() {
  const links = [...document.querySelectorAll('.blog-nav__list a')];
  if (!links.length) return;

  const getFilename = (href) => {
    if (!href) return '';
    try {
      return new URL(href, window.location.href).pathname.split('/').pop() || '';
    } catch {
      return href;
    }
  };

  const setActiveByFilename = (filename) => {
    links.forEach((link) => {
      const isActive = getFilename(link.getAttribute('href')) === filename;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  };

  const headerHeight = () => {
    const h = document.querySelector('.site-header');
    return h ? h.getBoundingClientRect().height : 0;
  };

  const getHashFromHref = (href) => {
    if (!href) return '';
    try {
      return new URL(href, window.location.href).hash || '';
    } catch {
      const hashIndex = href.indexOf('#');
      return hashIndex >= 0 ? href.slice(hashIndex) : '';
    }
  };

  const hashTargets = links
    .map((link) => {
      const hash = getHashFromHref(link.getAttribute('href'));
      if (!hash || hash.length <= 1) return null;
      const target = document.querySelector(hash);
      if (!target) return null;
      return { link, hash, target };
    })
    .filter(Boolean);

  if (hashTargets.length) {
    const setActiveByHash = (hash) => {
      links.forEach((link) => {
        const isActive = getHashFromHref(link.getAttribute('href')) === hash;
        link.classList.toggle('is-active', isActive);
        if (isActive) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    };

    const scrollToHashTarget = (target) => {
      const y = target.getBoundingClientRect().top + window.scrollY - headerHeight() - 24;
      window.scrollTo({ top: Math.max(y, 0), behavior: 'smooth' });
    };

    const updateFromScroll = () => {
      const offset = headerHeight() + Math.max((window.innerHeight - headerHeight()) * 0.3, 120);
      let activeHash = hashTargets[0].hash;
      for (const { hash, target } of hashTargets) {
        if (target.getBoundingClientRect().top - offset <= 0) activeHash = hash;
        else break;
      }
      setActiveByHash(activeHash);
    };

    hashTargets.forEach(({ link, hash, target }) => {
      link.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        scrollToHashTarget(target);
        history.replaceState(null, '', hash);
        setActiveByHash(hash);
      });
    });

    if (window.location.hash) {
      const initialTarget = document.querySelector(window.location.hash);
      if (initialTarget) {
        requestAnimationFrame(() => scrollToHashTarget(initialTarget));
      }
    }

    updateFromScroll();
    window.addEventListener('scroll', updateFromScroll, { passive: true });
    window.addEventListener('resize', updateFromScroll);
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash;
      if (hash) setActiveByHash(hash);
    });
    return;
  }

  const currentWeek = document.body.dataset.blogWeek;
  if (currentWeek) {
    setActiveByFilename(`blog-${currentWeek}.html`);
    return;
  }

  const weekCards = [...document.querySelectorAll('.blog-week-card')]
    .map((card) => {
      const link = card.querySelector('.blog-week-card__week-link, .blog-week-card__link');
      const filename = getFilename(link?.getAttribute('href'));
      return filename ? { card, filename } : null;
    })
    .filter(Boolean);

  if (!weekCards.length) {
    setActiveByFilename(getFilename(window.location.pathname));
    return;
  }

  const getActiveFilename = () => {
    const offset = headerHeight() + Math.max((window.innerHeight - headerHeight()) * 0.32, 120);
    let active = 'blog.html';
    for (const { card, filename } of weekCards) {
      if (card.getBoundingClientRect().top - offset <= 0) active = filename;
      else break;
    }
    return active;
  };

  const update = () => {
    setActiveByFilename(getActiveFilename());
  };

  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
}

function initializeReferenceLinks() {
  const referenceLinks = [...document.querySelectorAll('a[href^="#ref-"]')];
  if (!referenceLinks.length) return;

  referenceLinks.forEach((link) => {
    const targetSelector = link.getAttribute('href');
    if (!targetSelector) return;

    link.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = document.querySelector(targetSelector);
      if (!target) return;

      event.preventDefault();
      scrollElementToViewportCenter(target);
      history.replaceState(null, '', targetSelector);
    });
  });

  if (window.location.hash.startsWith('#ref-')) {
    const target = document.querySelector(window.location.hash);
    if (target) {
      requestAnimationFrame(() => scrollElementToViewportCenter(target));
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initializeHeader();
  renderToc();
  renderFooter();
  markExternalPlaceholders();
  initializePartnerLogos();
  initializeHeroStackCycle();
  initializeProjectTabs();
  initBlogNav();
  initializeReferenceLinks();
});
