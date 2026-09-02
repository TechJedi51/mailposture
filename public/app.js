'use strict';

const $ = selector => document.querySelector(selector);
const state = { data: null, selected: 0, settingsLoaded: false };
const names = { critical: 'Needs action', warning: 'Review', healthy: 'Healthy', info: 'Info' };
const esc = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function ago(value) {
  if (!value) return 'Starting checks…';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value)) / 1000));
  return seconds < 10 ? 'Updated just now' : seconds < 60 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`;
}

function score(domain) {
  const weights = { critical: 0, warning: .55, info: .8, healthy: 1 };
  return Math.round(domain.checks.reduce((total, check) => total + weights[check.status], 0) / domain.checks.length * 100);
}

function tlsEndpoint(check, domain) {
  if (check.label !== 'TLS certificate') return '';
  return `${check.evidence?.host || domain}:${check.evidence?.port || '—'}`;
}

function render() {
  const data = state.data;
  $('#version').textContent = `v${data.version || 'unknown'}`;
  $('#updated').textContent = ago(data.generated_at);
  if (data.error && !data.domains.length) {
    $('#hero').innerHTML = '<div><small>Configuration needed</small><h1>Check the saved settings.</h1></div>';
    $('#domains').innerHTML = '';
    $('#checks').innerHTML = '';
    $('#attention').innerHTML = `<div class="error">${esc(data.error)}</div>`;
    return;
  }
  if (!data.domains.length) {
    $('#hero').innerHTML = '<div><small>Configuration needed</small><h1>Add your first mail domain.</h1><p>Open Settings to choose domains, selectors, and certificate endpoints.</p><a class="primary-link" href="/settings" data-route="/settings">Open Settings →</a></div>';
    $('#domains').innerHTML = '';
    $('#checks').innerHTML = '';
    $('#attention').innerHTML = '<div class="clear">No domains are configured yet.</div>';
    return;
  }
  if (state.selected >= data.domains.length) state.selected = 0;
  const domain = data.domains[state.selected];
  const issues = domain.checks.filter(check => ['critical', 'warning'].includes(check.status)).sort((a, b) => (a.status === 'critical' ? -1 : 1) - (b.status === 'critical' ? -1 : 1));
  const posture = score(domain);
  $('#hero').innerHTML = `<div><small>${esc(domain.domain)} · Current posture</small><h1>${domain.counts.critical ? `${domain.counts.critical} issue${domain.counts.critical === 1 ? '' : 's'} need attention.` : domain.counts.warning ? 'Protected, with room to improve.' : 'Mail controls look solid.'}</h1><p>Live policy checks and observed authentication results, translated into the next useful action.</p></div><div class="score"><strong>${posture}</strong><span>Posture score out of 100</span><div class="bar"><i style="width:${posture}%"></i></div></div>`;
  $('#domains').innerHTML = data.domains.map((value, index) => `<button class="domain ${index === state.selected ? 'active' : ''}" data-domain="${index}"><i class="dot ${value.status}"></i>${esc(value.domain)}</button>`).join('');
  $('#attention').innerHTML = issues.length ? `<div class="attention-head"><h2>Attention queue</h2><span class="pill">${issues.length} open</span></div>${issues.map(check => `<article class="issue ${check.status}"><span class="icon">${check.status === 'critical' ? '!' : '•'}</span><span class="control">${esc(check.label)}</span><div><h3>${esc(check.summary)}</h3><p>${esc(check.action)}</p></div><button class="view" data-check="${esc(check.id)}">View →</button></article>`).join('')}` : '<div class="attention-head"><h2>Attention queue</h2><span class="pill">Clear</span></div><div class="clear">No immediate actions. Every configured control passed its threshold.</div>';
  $('#checks').innerHTML = domain.checks.map(check => {
    const endpoint = tlsEndpoint(check, domain.domain);
    return `<button class="card" data-check="${esc(check.id)}"><div class="card-top"><span><span class="label">${esc(check.label)}</span>${endpoint ? `<span class="card-context">${esc(endpoint)}</span>` : ''}</span><span class="state ${check.status}">${names[check.status]}</span></div><h3>${esc(check.summary)}</h3><p>${esc(check.detail)}</p></button>`;
  }).join('');
}

function detail(id) {
  const domain = state.data.domains[state.selected];
  const check = domain.checks.find(value => value.id === id);
  if (!check) return;
  const endpoint = tlsEndpoint(check, domain.domain);
  $('#detail').innerHTML = `<div class="detail"><span class="state ${check.status}">${names[check.status]}</span><h2>${esc(check.label)}</h2><p class="detail-domain">${esc(domain.domain)}${endpoint ? ` · ${esc(endpoint)}` : ''}</p><p class="summary">${esc(check.summary)}</p><div class="block"><h3>What this means</h3><p>${esc(check.detail)}</p></div><div class="block action"><h3>Next action</h3><p>${esc(check.action)}</p></div>${Object.keys(check.evidence || {}).length ? `<div class="block"><h3>Evidence</h3><pre>${esc(JSON.stringify(check.evidence, null, 2))}</pre></div>` : ''}</div>`;
  $('#dialog').showModal();
}

async function load() {
  try {
    state.data = await fetch('/api/status', { cache: 'no-store' }).then(response => response.json());
    render();
  } catch (error) {
    $('#attention').innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

function mappingLines(mapping, formatter) {
  return Object.entries(mapping || {}).map(([domain, values]) => `${domain}=${values.map(formatter).join('|')}`).join('\n');
}

function parseMappings(text, endpoint = false) {
  const output = {};
  for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Invalid mapping: ${line}`);
    const domain = line.slice(0, separator).trim().toLowerCase();
    const values = line.slice(separator + 1).split('|').map(value => value.trim()).filter(Boolean);
    output[domain] = endpoint ? values.map(value => {
      const match = value.match(/^(.*?)(?::(\d+))?$/);
      return { host: match[1], port: Number(match[2] || 443) };
    }) : values;
  }
  return output;
}

async function loadSettings() {
  const response = await fetch('/api/settings', { cache: 'no-store' });
  const settings = await response.json();
  if (!response.ok) throw new Error(settings.error || 'Unable to load settings');
  $('#monitored-domains').value = settings.monitored_domains.join('\n');
  $('#dkim-selectors').value = mappingLines(settings.dkim_selectors, value => value);
  $('#tls-endpoints').value = mappingLines(settings.tls_endpoints, value => `${value.host}:${value.port}`);
  $('#report-days').value = settings.report_days;
  $('#refresh-minutes').value = settings.refresh_minutes;
  $('#request-timeout').value = settings.request_timeout_ms;
  $('#opensearch-enabled').checked = settings.opensearch_enabled;
  state.settingsLoaded = true;
}

async function saveSettings(event) {
  event.preventDefault();
  const button = $('#settings-form button[type="submit"]');
  const message = $('#settings-message');
  button.disabled = true;
  button.textContent = 'Saving…';
  message.className = '';
  try {
    const body = {
      monitored_domains: $('#monitored-domains').value.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean),
      dkim_selectors: parseMappings($('#dkim-selectors').value),
      tls_endpoints: parseMappings($('#tls-endpoints').value, true),
      report_days: Number($('#report-days').value),
      refresh_minutes: Number($('#refresh-minutes').value),
      request_timeout_ms: Number($('#request-timeout').value),
      opensearch_enabled: $('#opensearch-enabled').checked
    };
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save settings');
    message.textContent = 'Settings saved. Checks have been refreshed.';
    message.className = 'success';
    await load();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'failure';
  } finally {
    button.disabled = false;
    button.textContent = 'Save settings';
  }
}

async function showRoute(pathname, push = false) {
  const settings = pathname === '/settings';
  if (push) history.pushState({}, '', settings ? '/settings' : '/');
  $('#status-view').hidden = settings;
  $('#settings-view').hidden = !settings;
  $('#refresh').hidden = settings;
  $('#updated').hidden = settings;
  document.querySelectorAll('[data-route]').forEach(link => link.classList.toggle('active', link.getAttribute('href') === (settings ? '/settings' : '/')));
  if (settings && !state.settingsLoaded) {
    try { await loadSettings(); } catch (error) { $('#settings-message').textContent = error.message; $('#settings-message').className = 'failure'; }
  }
}

$('#refresh').onclick = async () => {
  const button = $('#refresh');
  button.disabled = true;
  button.textContent = 'Checking…';
  try { state.data = await fetch('/api/refresh', { method: 'POST' }).then(response => response.json()); render(); }
  finally { button.disabled = false; button.textContent = 'Run checks'; }
};

$('#settings-form').addEventListener('submit', saveSettings);
document.onclick = event => {
  const route = event.target.closest('[data-route]');
  if (route) { event.preventDefault(); showRoute(route.getAttribute('href'), true); return; }
  const domain = event.target.closest('[data-domain]');
  if (domain) { state.selected = Number(domain.dataset.domain); render(); return; }
  const check = event.target.closest('[data-check]');
  if (check) detail(check.dataset.check);
};
window.onpopstate = () => showRoute(location.pathname);
$('.close').onclick = () => $('#dialog').close();
$('#dialog').onclick = event => { if (event.target === $('#dialog')) $('#dialog').close(); };

showRoute(location.pathname);
load();
setInterval(() => { if (state.data) $('#updated').textContent = ago(state.data.generated_at); }, 15000);
