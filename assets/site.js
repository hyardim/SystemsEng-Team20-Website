const navigation = [
  { id: 'home', label: 'Home', href: 'index.html' },
  { id: 'requirements', label: 'Requirements', href: 'requirements.html' },
  { id: 'research', label: 'Research', href: 'research.html' },
  { id: 'algorithms', label: 'Algorithms', href: 'algorithms.html' },
  { id: 'ui-design', label: 'UI Design', href: 'ui-design.html' },
  { id: 'system-design', label: 'System Design', href: 'system-design.html' },
  { id: 'implementation', label: 'Implementation', href: 'implementation.html' },
  { id: 'testing', label: 'Evaluation & Testing', href: 'testing.html' },
  { id: 'conclusion', label: 'Conclusion', href: 'conclusion.html' },
  { id: 'appendices', label: 'Appendices', href: 'appendices.html' },
];

function renderHeader() {
  const page = document.body.dataset.page;
  const host = document.getElementById('site-header');
  if (!host) return;

  host.innerHTML = `
    <header class="site-header">
      <div class="site-header__inner">
        <a class="brand" href="index.html" aria-label="Ambience-AI-1.5 report home">
          <span class="brand__mark">A15</span>
          <span>
            <p class="brand__eyebrow">UCL Computer Science · Team 20</p>
            <p class="brand__title">Ambience-AI-1.5 Technical Project Report</p>
          </span>
        </a>
        <button class="nav-toggle" type="button" aria-label="Toggle navigation">Menu</button>
        <nav class="site-nav" aria-label="Primary">
          ${navigation
            .map(
              (item) => `<a href="${item.href}" class="${item.id === page ? 'is-active' : ''}">${item.label}</a>`,
            )
            .join('')}
        </nav>
      </div>
    </header>
  `;

  const toggle = host.querySelector('.nav-toggle');
  const nav = host.querySelector('.site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('is-open'));
  }
}

function renderFooter() {
  const host = document.getElementById('site-footer');
  if (!host) return;

  host.innerHTML = `
    <footer class="site-footer">
      <div class="site-footer__inner">
        <section>
          <h3>Ambience-AI-1.5</h3>
          <p>
            A technical systems report for a university software engineering project.
            The system under study is a role-aware clinical consultation platform that combines
            React, FastAPI, PostgreSQL with pgvector, and a grounded medical RAG service.
          </p>
          <p class="muted">This website intentionally describes implementation details, deployment paths, safeguards, testing, and known limitations rather than product marketing claims.</p>
        </section>
        <section>
          <h4>Key evidence base</h4>
          <div class="site-footer__links">
            <a href="implementation.html">Frontend, backend, and RAG implementation</a>
            <a href="system-design.html">Architecture, flows, and data model</a>
            <a href="testing.html">Automated test strategy and caveats</a>
          </div>
        </section>
        <section>
          <h4>Appendix items</h4>
          <div class="site-footer__links">
            <a href="appendices.html#user-manual">User manual</a>
            <a href="appendices.html#deployment-manual">Deployment manual</a>
            <a href="appendices.html#privacy">GDPR and privacy</a>
            <a href="appendices.html#external-links">External blog and monthly video</a>
          </div>
        </section>
      </div>
    </footer>
  `;
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

function markExternalPlaceholders() {
  document.querySelectorAll('[data-placeholder-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      alert('Replace this placeholder with your published blog or monthly video URL before submission.');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderHeader();
  renderFooter();
  renderToc();
  markExternalPlaceholders();
});
