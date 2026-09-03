'use strict';

const $ = selector => document.querySelector(selector);
const state = { data: null, selected: 0, settings: null, settingsLoaded: false, editor: null, route: '/' };
const names = { critical: 'Needs action', warning: 'Review', healthy: 'Healthy', info: 'Info' };
const themeQuery = matchMedia('(prefers-color-scheme: dark)');
const esc = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
const clone = value => JSON.parse(JSON.stringify(value));
const number = value => new Intl.NumberFormat().format(Math.round(Number(value || 0)));

function ago(value) {
  if (!value) return 'Starting checks…';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value)) / 1000));
  return seconds < 10 ? 'Updated just now' : seconds < 60 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`;
}

function score(domain) {
  const weights = { critical: 0, warning: .55, info: .8, healthy: 1 };
  return domain.checks.length ? Math.round(domain.checks.reduce((total, check) => total + weights[check.status], 0) / domain.checks.length * 100) : 0;
}

function issuesFor(domain) {
  return domain.checks.filter(check => ['critical', 'warning'].includes(check.status)).sort((a, b) => (a.status === b.status ? 0 : a.status === 'critical' ? -1 : 1));
}

function tlsEndpoint(check, domain) {
  if (check.label !== 'TLS certificate') return '';
  return `${check.evidence?.host || domain}:${check.evidence?.port || '—'}`;
}

function trendChart(points, successKey, failureKey, label) {
  if (!points?.length) return '<p class="report-empty">No daily trend is available for this period.</p>';
  const maximum = Math.max(1, ...points.map(point => Number(point[successKey] || 0) + Number(point[failureKey] || 0)));
  const columns = points.map(point => {
    const success = Number(point[successKey] || 0); const failed = Number(point[failureKey] || 0);
    const successHeight = Math.max(success ? 2 : 0, success / maximum * 100); const failedHeight = Math.max(failed ? 2 : 0, failed / maximum * 100);
    const date = new Date(`${String(point.date).slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<span class="chart-column" title="${esc(date)}: ${number(success)} successful, ${number(failed)} failed"><i class="chart-bar" style="height:${successHeight}%"></i><i class="chart-bar failed" style="height:${failedHeight}%"></i></span>`;
  }).join('');
  return `<div class="chart" role="img" aria-label="${esc(label)}">${columns}</div><div class="chart-legend"><span><i></i>Successful</span><span class="failed"><i></i>Failed</span></div>`;
}

function rankedList(items, nameKey, valueKey, emptyText) {
  if (!items?.length) return `<p class="report-empty">${esc(emptyText)}</p>`;
  const maximum = Math.max(1, ...items.map(item => Number(item[valueKey] || 0)));
  return `<ol class="ranked-list">${items.map(item => `<li><span>${esc(item[nameKey])}</span><strong>${number(item[valueKey])}</strong><span class="rank-bar"><i style="width:${Number(item[valueKey] || 0) / maximum * 100}%"></i></span></li>`).join('')}</ol>`;
}

function aggregateCard(report, wide = false) {
  if (!report?.total) return `<article class="report-card ${wide ? 'wide' : ''}"><div class="report-card-header"><div><h3>DMARC aggregate reports</h3><p>Authentication results reported by receiving email services.</p></div></div><p class="report-empty">No aggregate report data was found for this period.</p></article>`;
  const passed = Math.max(0, Number(report.total) - Number(report.failed || 0));
  return `<article class="report-card ${wide ? 'wide' : ''}"><div class="report-card-header"><div><h3>DMARC aggregate reports</h3><p>${number(report.total)} messages observed over ${number(report.period_days)} days</p></div><span class="report-value">${report.pass_rate ?? '—'}%</span></div><div class="metric-row"><div class="metric"><strong>${number(report.failed)}</strong><span>DMARC failures</span></div><div class="metric"><strong>${report.dkim_pass_rate ?? '—'}%</strong><span>DKIM aligned</span></div><div class="metric"><strong>${report.spf_pass_rate ?? '—'}%</strong><span>SPF aligned</span></div></div>${trendChart((report.timeline || []).map(item => ({...item, passed: Math.max(0, item.total - item.failed)})), 'passed', 'failed', `DMARC daily results: ${number(passed)} successful and ${number(report.failed)} failed`)}</article>`;
}

function smtpTlsCard(report) {
  if (!report?.available || (!report.successful && !report.failed)) return '<article class="report-card"><div class="report-card-header"><div><h3>SMTP TLS reports</h3><p>Transport security results reported by sending services.</p></div></div><p class="report-empty">No SMTP TLS report data was found for this period.</p></article>';
  return `<article class="report-card"><div class="report-card-header"><div><h3>SMTP TLS reports</h3><p>${number(report.reports)} reported policies</p></div><span class="report-value">${report.success_rate ?? '—'}%</span></div><div class="metric-row"><div class="metric"><strong>${number(report.successful)}</strong><span>Successful sessions</span></div><div class="metric"><strong>${number(report.failed)}</strong><span>Failed sessions</span></div><div class="metric"><strong>${number(report.failure_types?.length)}</strong><span>Failure types</span></div></div>${trendChart(report.timeline, 'successful', 'failed', `SMTP TLS daily results: ${number(report.successful)} successful and ${number(report.failed)} failed`)}</article>`;
}

function failureCard(report) {
  return `<article class="report-card"><div class="report-card-header"><div><h3>DMARC failure reports</h3><p>Individual authentication failure notices</p></div><span class="report-value">${report?.available ? number(report.count) : '—'}</span></div><p class="privacy-note">${esc(report?.privacy_note || report?.error || 'Failure report data is not available.')}</p></article>`;
}

function reportingOrganizationsCard(report) {
  return `<article class="report-card"><div class="report-card-header"><div><h3>TLS reporting organizations</h3><p>Services that supplied SMTP TLS results</p></div></div>${rankedList(report?.organizations, 'name', 'sessions', 'No TLS reporting organizations were found.')}</article>`;
}

function detailCards(reports) {
  return `${aggregateCard(reports?.aggregate, true)}${smtpTlsCard(reports?.smtp_tls)}${failureCard(reports?.failure)}<article class="report-card"><div class="report-card-header"><div><h3>Top failing DMARC sources</h3><p>Source addresses producing the most failed messages</p></div></div>${rankedList(reports?.aggregate?.top_failing_sources, 'ip', 'messages', 'No failing sources were reported.')}</article><article class="report-card"><div class="report-card-header"><div><h3>SMTP TLS failure types</h3><p>Transport problems reported by sending services</p></div></div>${rankedList(reports?.smtp_tls?.failure_types, 'type', 'count', 'No SMTP TLS failure types were reported.')}</article>${reportingOrganizationsCard(reports?.smtp_tls)}`;
}

function organizationReports(domains) {
  const aggregate = { total: 0, failed: 0, period_days: 0, timeline: [], top_failing_sources: [] }; const smtp = { available: false, reports: 0, successful: 0, failed: 0, timeline: [], failure_types: [], organizations: [] }; let failures = 0; let failureAvailable = false;
  const days = new Map(); const tlsDays = new Map(); const sources = new Map(); const types = new Map(); const organizations = new Map(); let dkimWeighted = 0; let spfWeighted = 0;
  for (const domain of domains) {
    const a = domain.reports?.aggregate || {}; aggregate.total += Number(a.total || 0); aggregate.failed += Number(a.failed || 0); aggregate.period_days = Math.max(aggregate.period_days, Number(a.period_days || 0)); dkimWeighted += Number(a.dkim_pass_rate || 0) * Number(a.total || 0); spfWeighted += Number(a.spf_pass_rate || 0) * Number(a.total || 0);
    for (const point of a.timeline || []) { const key = String(point.date).slice(0,10); const day = days.get(key) || {date:key,total:0,failed:0}; day.total += Number(point.total || 0); day.failed += Number(point.failed || 0); days.set(key,day); }
    for (const item of a.top_failing_sources || []) sources.set(item.ip, (sources.get(item.ip) || 0) + Number(item.messages || 0));
    const t = domain.reports?.smtp_tls || {}; if (t.available) smtp.available = true; smtp.reports += Number(t.reports || 0); smtp.successful += Number(t.successful || 0); smtp.failed += Number(t.failed || 0);
    for (const point of t.timeline || []) { const key = String(point.date).slice(0,10); const day = tlsDays.get(key) || {date:key,successful:0,failed:0}; day.successful += Number(point.successful || 0); day.failed += Number(point.failed || 0); tlsDays.set(key,day); }
    for (const item of t.failure_types || []) types.set(item.type, (types.get(item.type) || 0) + Number(item.count || 0));
    for (const item of t.organizations || []) organizations.set(item.name, (organizations.get(item.name) || 0) + Number(item.sessions || 0));
    const f = domain.reports?.failure || {}; if (f.available) failureAvailable = true; failures += Number(f.count || 0);
  }
  aggregate.pass_rate = aggregate.total ? Math.round((aggregate.total - aggregate.failed) / aggregate.total * 1000) / 10 : null; aggregate.dkim_pass_rate = aggregate.total ? Math.round(dkimWeighted / aggregate.total * 10) / 10 : null; aggregate.spf_pass_rate = aggregate.total ? Math.round(spfWeighted / aggregate.total * 10) / 10 : null; aggregate.timeline = [...days.values()].sort((a,b)=>a.date.localeCompare(b.date)); aggregate.top_failing_sources = [...sources].map(([ip,messages])=>({ip,messages})).sort((a,b)=>b.messages-a.messages).slice(0,8);
  const tlsTotal = smtp.successful + smtp.failed; smtp.success_rate = tlsTotal ? Math.round(smtp.successful / tlsTotal * 1000) / 10 : null; smtp.timeline = [...tlsDays.values()].sort((a,b)=>a.date.localeCompare(b.date)); smtp.failure_types = [...types].map(([type,count])=>({type,count})).sort((a,b)=>b.count-a.count).slice(0,8); smtp.organizations = [...organizations].map(([name,sessions])=>({name,sessions})).sort((a,b)=>b.sessions-a.sessions).slice(0,8);
  return { aggregate, smtp_tls: smtp, failure: { available: failureAvailable, count: failures, privacy_note: 'Counts only. Message samples remain private.' } };
}

function setTheme(mode, persist = true) {
  const normalized = ['light', 'dark', 'system'].includes(mode) ? mode : 'system';
  const resolved = normalized === 'system' ? (themeQuery.matches ? 'dark' : 'light') : normalized;
  document.documentElement.dataset.themeMode = normalized;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').content = resolved === 'dark' ? '#0a0f0e' : '#f3f7f5';
  if (persist) localStorage.setItem('mailposture-theme', normalized);
  document.querySelectorAll('input[name="theme"]').forEach(input => { input.checked = input.value === normalized; });
}

function renderDashboard() {
  const data = state.data;
  if (!data) return;
  if (data.error && !data.domains.length) {
    $('#master-score').innerHTML = '<span>Unavailable</span>';
    $('#domain-scores').innerHTML = `<div class="error">${esc(data.error)}</div>`;
    $('#master-attention').innerHTML = '';
    $('#organization-reports').innerHTML = '';
    return;
  }
  if (!data.domains.length) {
    $('#master-score').innerHTML = '<strong>—</strong><span>No domains configured</span>';
    $('#domain-scores').innerHTML = '<div class="empty-state"><h3>Add your first domain</h3><p>Configure a domain, its DKIM selectors, and its TLS certificate endpoints.</p><a href="/settings" data-route="/settings">Open Settings →</a></div>';
    $('#master-attention').innerHTML = '<div class="clear">There are no domains to evaluate.</div>';
    $('#organization-reports').innerHTML = '<div class="empty-state"><h3>No report data yet</h3><p>Add a domain and connect a report source.</p></div>';
    $('#master-issue-count').textContent = '0 open';
    return;
  }
  const domainScores = data.domains.map(score);
  const master = Math.round(domainScores.reduce((total, value) => total + value, 0) / domainScores.length);
  const issueCount = data.domains.reduce((total, domain) => total + issuesFor(domain).length, 0);
  $('#master-score').innerHTML = `<strong>${master}</strong><span>Master score out of 100</span><div class="bar"><i style="width:${master}%"></i></div>`;
  $('#domain-scores').innerHTML = data.domains.map((domain, index) => {
    const value = domainScores[index];
    return `<button class="domain-score-card" data-open-domain="${index}"><div class="domain-score-top"><span><i class="dot ${domain.status}"></i>${esc(domain.domain)}</span><span class="state ${domain.status}">${names[domain.status]}</span></div><strong>${value}</strong><div class="bar"><i style="width:${value}%"></i></div><p>${domain.counts.critical} critical · ${domain.counts.warning} review</p></button>`;
  }).join('');
  $('#master-issue-count').textContent = issueCount ? `${issueCount} open` : 'Clear';
  $('#master-attention').innerHTML = issueCount ? data.domains.map((domain, domainIndex) => {
    const issues = issuesFor(domain);
    if (!issues.length) return '';
    return `<section class="attention-group"><div class="attention-group-heading"><h3>${esc(domain.domain)}</h3><button data-open-domain="${domainIndex}">View domain →</button></div>${issues.map(check => `<article class="issue ${check.status}"><span class="icon">${check.status === 'critical' ? '!' : '•'}</span><span class="control">${esc(check.label)}</span><div><h3>${esc(check.summary)}</h3><p>${esc(check.action)}</p></div><button class="view" data-dashboard-check="${esc(check.id)}" data-domain-index="${domainIndex}">View →</button></article>`).join('')}</section>`;
  }).join('') : '<div class="clear">No immediate actions. Every configured control passed its threshold.</div>';
  const reports = organizationReports(data.domains);
  $('#organization-reports').innerHTML = `${aggregateCard(reports.aggregate)}${smtpTlsCard(reports.smtp_tls)}${failureCard(reports.failure)}${reportingOrganizationsCard(reports.smtp_tls)}`;
}

function renderDomain() {
  const data = state.data;
  if (!data) return;
  $('#updated').textContent = ago(data.generated_at);
  if (data.error && !data.domains.length) {
    $('#hero').innerHTML = '<div><small>Configuration needed</small><h1>Check the saved settings.</h1></div>';
    $('#domains').innerHTML = '';
    $('#checks').innerHTML = '';
    $('#attention').innerHTML = `<div class="error">${esc(data.error)}</div>`;
    $('#domain-reports').innerHTML = '';
    return;
  }
  if (!data.domains.length) {
    $('#hero').innerHTML = '<div><small>Configuration needed</small><h1>Add your first mail domain.</h1><p>Open Settings to choose domains, selectors, and certificate endpoints.</p><a class="primary-link" href="/settings" data-route="/settings">Open Settings →</a></div>';
    $('#domains').innerHTML = '';
    $('#checks').innerHTML = '';
    $('#attention').innerHTML = '<div class="clear">No domains are configured yet.</div>';
    $('#domain-reports').innerHTML = '';
    return;
  }
  if (state.selected >= data.domains.length) state.selected = 0;
  const domain = data.domains[state.selected];
  const issues = issuesFor(domain);
  const posture = score(domain);
  $('#hero').innerHTML = `<div><small>${esc(domain.domain)} · Current posture</small><h1>${domain.counts.critical ? `${domain.counts.critical} issue${domain.counts.critical === 1 ? '' : 's'} need attention.` : domain.counts.warning ? 'Protected, with room to improve.' : 'Mail controls look solid.'}</h1><p>Live policy checks and observed authentication results, translated into the next useful action.</p></div><div class="score"><strong>${posture}</strong><span>Posture score out of 100</span><div class="bar"><i style="width:${posture}%"></i></div></div>`;
  $('#domains').innerHTML = data.domains.map((value, index) => `<button class="domain ${index === state.selected ? 'active' : ''}" data-domain="${index}"><i class="dot ${value.status}"></i>${esc(value.domain)}</button>`).join('');
  $('#attention').innerHTML = issues.length ? `<div class="attention-head"><h2>Attention queue</h2><span class="pill">${issues.length} open</span></div>${issues.map(check => `<article class="issue ${check.status}"><span class="icon">${check.status === 'critical' ? '!' : '•'}</span><span class="control">${esc(check.label)}</span><div><h3>${esc(check.summary)}</h3><p>${esc(check.action)}</p></div><button class="view" data-check="${esc(check.id)}">View →</button></article>`).join('')}` : '<div class="attention-head"><h2>Attention queue</h2><span class="pill">Clear</span></div><div class="clear">No immediate actions. Every configured control passed its threshold.</div>';
  $('#checks').innerHTML = domain.checks.map(check => {
    const endpoint = tlsEndpoint(check, domain.domain);
    return `<button class="card" data-check="${esc(check.id)}"><div class="card-top"><span><span class="label">${esc(check.label)}</span>${endpoint ? `<span class="card-context">${esc(endpoint)}</span>` : ''}</span><span class="state ${check.status}">${names[check.status]}</span></div><h3>${esc(check.summary)}</h3><p>${esc(check.detail)}</p></button>`;
  }).join('');
  $('#domain-reports').innerHTML = detailCards(domain.reports);
}

function renderStatus() {
  if (!state.data) return;
  $('#version').textContent = `v${state.data.version || 'unknown'}`;
  $('#updated').textContent = ago(state.data.generated_at);
  renderDashboard();
  renderDomain();
}

function detail(id) {
  const domain = state.data?.domains[state.selected];
  const check = domain?.checks.find(value => value.id === id);
  if (!check) return;
  const endpoint = tlsEndpoint(check, domain.domain);
  $('#detail').innerHTML = `<div class="detail"><span class="state ${check.status}">${names[check.status]}</span><h2>${esc(check.label)}</h2><p class="detail-domain">${esc(domain.domain)}${endpoint ? ` · ${esc(endpoint)}` : ''}</p><p class="summary">${esc(check.summary)}</p><div class="block"><h3>What this means</h3><p>${esc(check.detail)}</p></div><div class="block action"><h3>Next action</h3><p>${esc(check.action)}</p></div>${Object.keys(check.evidence || {}).length ? `<div class="block"><h3>Evidence</h3><pre>${esc(JSON.stringify(check.evidence, null, 2))}</pre></div>` : ''}</div>`;
  $('#detail-dialog').showModal();
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    state.data = await response.json();
    renderStatus();
  } catch (error) {
    $('#domain-scores').innerHTML = `<div class="error">${esc(error.message)}</div>`;
    $('#attention').innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

function renderSettingsDomains() {
  const settings = state.settings;
  if (!settings) return;
  $('#settings-domain-list').innerHTML = settings.monitored_domains.length ? settings.monitored_domains.map((domain, index) => {
    const selectors = settings.dkim_selectors[domain] || [];
    const endpoints = settings.tls_endpoints[domain] || [];
    return `<div class="editable-row"><div><strong>${esc(domain)}</strong><span>${selectors.length} DKIM selector${selectors.length === 1 ? '' : 's'} · ${endpoints.length} TLS certificate${endpoints.length === 1 ? '' : 's'}</span></div><div class="row-actions"><button class="symbol-button" type="button" data-edit-domain="${index}" aria-label="Edit ${esc(domain)}" title="Edit domain">✎</button><button class="symbol-button danger-symbol" type="button" data-remove-domain="${index}" aria-label="Remove ${esc(domain)}" title="Remove domain">−</button></div></div>`;
  }).join('') : '<div class="empty-list"><p>No domains are configured.</p><button type="button" data-add-domain>Add a domain</button></div>';
}

async function loadSettings() {
  const response = await fetch('/api/settings', { cache: 'no-store' });
  const settings = await response.json();
  if (!response.ok) throw new Error(settings.error || 'Unable to load settings');
  state.settings = clone(settings);
  $('#report-days').value = settings.report_days;
  $('#refresh-minutes').value = settings.refresh_minutes;
  $('#request-timeout').value = settings.request_timeout_ms;
  $('#report-source').value = settings.report_source;
  $('#opensearch-url').value = settings.opensearch_url;
  $('#opensearch-username').value = settings.opensearch_username;
  $('#opensearch-verify-tls').checked = settings.opensearch_verify_tls;
  $('#aggregate-index').value = settings.opensearch_aggregate_index;
  $('#failure-index').value = settings.opensearch_failure_index;
  $('#smtp-tls-index').value = settings.opensearch_smtp_tls_index;
  $('#mailbox-enabled').checked = settings.mailbox.enabled;
  $('#imap-host').value = settings.mailbox.host;
  $('#imap-port').value = settings.mailbox.port;
  $('#imap-username').value = settings.mailbox.username;
  $('#imap-password').value = '';
  $('#imap-ssl').checked = settings.mailbox.ssl;
  $('#reports-folder').value = settings.mailbox.reports_folder;
  $('#archive-folder').value = settings.mailbox.archive_folder;
  $('#imap-password-status').textContent = settings.mailbox.password_set ? 'A password is saved. Leave this blank to keep it.' : 'No password is saved.';
  $('#snapshots-enabled').checked = settings.snapshots.enabled;
  $('#snapshot-cron').value = settings.snapshots.cron;
  $('#snapshot-delete-cron').value = settings.snapshots.delete_cron;
  $('#snapshot-timezone').value = settings.snapshots.timezone;
  $('#snapshot-retention').value = settings.snapshots.retention_days;
  $('#snapshot-min').value = settings.snapshots.min_count;
  $('#snapshot-max').value = settings.snapshots.max_count;
  setTheme(localStorage.getItem('mailposture-theme') || 'system', false);
  renderSettingsDomains();
  updateSettingsVisibility();
  state.settingsLoaded = true;
}

function updateSettingsVisibility() {
  const source = $('#report-source').value;
  $('#opensearch-fields').hidden = source === 'disabled';
  $('#collector-panel').hidden = source !== 'standalone';
  $('#snapshot-panel').hidden = source !== 'standalone';
  $('#mailbox-fields').hidden = !$('#mailbox-enabled').checked;
  $('#snapshot-fields').hidden = !$('#snapshots-enabled').checked;
  const archive = $('#archive-folder').value.trim() || 'Archive';
  $('#archive-preview').textContent = `${archive}/Aggregate · ${archive}/Failure · ${archive}/Invalid · ${archive}/SMTP-TLS · ${archive}/Unsaved`;
}

function renderEditorLists() {
  const editor = state.editor;
  $('#selector-list').innerHTML = editor.selectors.length ? editor.selectors.map((selector, index) => `<div class="editable-row small-row"><code>${esc(selector)}</code><div class="row-actions"><button class="symbol-button" type="button" data-edit-selector="${index}" aria-label="Edit selector ${esc(selector)}" title="Edit selector">✎</button><button class="symbol-button danger-symbol" type="button" data-remove-selector="${index}" aria-label="Remove selector ${esc(selector)}" title="Remove selector">−</button></div></div>`).join('') : '<p class="empty-inline">No selectors added.</p>';
  $('#endpoint-list').innerHTML = editor.endpoints.length ? editor.endpoints.map((endpoint, index) => `<div class="editable-row small-row"><code>${esc(endpoint.host)}:${endpoint.port}</code><div class="row-actions"><button class="symbol-button" type="button" data-edit-endpoint="${index}" aria-label="Edit endpoint ${esc(endpoint.host)} port ${endpoint.port}" title="Edit endpoint">✎</button><button class="symbol-button danger-symbol" type="button" data-remove-endpoint="${index}" aria-label="Remove endpoint ${esc(endpoint.host)} port ${endpoint.port}" title="Remove endpoint">−</button></div></div>`).join('') : '<p class="empty-inline">No TLS certificates added.</p>';
}

function openDomainEditor(index = null) {
  const domain = index === null ? '' : state.settings.monitored_domains[index];
  state.editor = {
    index,
    originalDomain: domain,
    selectors: clone(state.settings.dkim_selectors[domain] || []),
    endpoints: clone(state.settings.tls_endpoints[domain] || []),
    editingSelector: null,
    editingEndpoint: null
  };
  $('#domain-editor-title').textContent = index === null ? 'Add domain' : 'Edit domain';
  $('#domain-name').value = domain;
  $('#selector-input').value = '';
  $('#selector-add').textContent = '＋';
  $('#endpoint-host').value = '';
  $('#endpoint-port').value = '443';
  $('#endpoint-add').textContent = '＋';
  $('#domain-message').textContent = '';
  renderEditorLists();
  $('#domain-dialog').showModal();
}

function addSelector() {
  const selector = $('#selector-input').value.trim();
  if (!/^[a-z0-9_-]{1,63}$/i.test(selector)) return showDomainError('Enter a valid selector using letters, numbers, hyphens, or underscores.');
  const duplicate = state.editor.selectors.findIndex((value, index) => value.toLowerCase() === selector.toLowerCase() && index !== state.editor.editingSelector);
  if (duplicate >= 0) return showDomainError('That selector is already listed.');
  if (state.editor.editingSelector === null) state.editor.selectors.push(selector);
  else state.editor.selectors[state.editor.editingSelector] = selector;
  state.editor.editingSelector = null;
  $('#selector-input').value = '';
  $('#selector-add').textContent = '＋';
  showDomainError('');
  renderEditorLists();
}

function addEndpoint() {
  const host = $('#endpoint-host').value.trim().toLowerCase().replace(/\.$/, '');
  const port = Number($('#endpoint-port').value);
  if (!/^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) return showDomainError('Enter a valid TLS host name.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return showDomainError('Enter a TLS port between 1 and 65535.');
  const duplicate = state.editor.endpoints.findIndex((value, index) => value.host === host && value.port === port && index !== state.editor.editingEndpoint);
  if (duplicate >= 0) return showDomainError('That TLS endpoint is already listed.');
  const endpoint = { host, port };
  if (state.editor.editingEndpoint === null) state.editor.endpoints.push(endpoint);
  else state.editor.endpoints[state.editor.editingEndpoint] = endpoint;
  state.editor.editingEndpoint = null;
  $('#endpoint-host').value = '';
  $('#endpoint-port').value = '443';
  $('#endpoint-add').textContent = '＋';
  showDomainError('');
  renderEditorLists();
}

function showDomainError(message) { $('#domain-message').textContent = message; }

function saveDomain(event) {
  event.preventDefault();
  const domain = $('#domain-name').value.trim().toLowerCase().replace(/\.$/, '');
  const valid = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain);
  if (!valid) return showDomainError('Enter a valid domain name.');
  const duplicate = state.settings.monitored_domains.findIndex((value, index) => value === domain && index !== state.editor.index);
  if (duplicate >= 0) return showDomainError('That domain is already monitored.');
  const oldDomain = state.editor.originalDomain;
  if (state.editor.index === null) state.settings.monitored_domains.push(domain);
  else state.settings.monitored_domains[state.editor.index] = domain;
  if (oldDomain && oldDomain !== domain) {
    delete state.settings.dkim_selectors[oldDomain];
    delete state.settings.tls_endpoints[oldDomain];
  }
  state.settings.dkim_selectors[domain] = clone(state.editor.selectors);
  state.settings.tls_endpoints[domain] = clone(state.editor.endpoints);
  $('#domain-dialog').close();
  renderSettingsDomains();
  $('#settings-message').textContent = 'Domain changes are ready. Save settings to apply them.';
  $('#settings-message').className = 'pending';
}

async function saveSettings(event) {
  event.preventDefault();
  const button = $('#settings-form button[type="submit"]');
  const message = $('#settings-message');
  if (!state.settings?.monitored_domains.length) { message.textContent = 'Add at least one monitored domain.'; message.className = 'failure'; return; }
  button.disabled = true;
  button.textContent = 'Saving…';
  message.className = '';
  try {
    const body = {
      ...state.settings,
      report_days: Number($('#report-days').value),
      refresh_minutes: Number($('#refresh-minutes').value),
      request_timeout_ms: Number($('#request-timeout').value),
      report_source: $('#report-source').value,
      opensearch_url: $('#opensearch-url').value.trim(),
      opensearch_username: $('#opensearch-username').value.trim(),
      opensearch_verify_tls: $('#opensearch-verify-tls').checked,
      opensearch_aggregate_index: $('#aggregate-index').value.trim(),
      opensearch_failure_index: $('#failure-index').value.trim(),
      opensearch_smtp_tls_index: $('#smtp-tls-index').value.trim(),
      mailbox: {
        ...state.settings.mailbox,
        enabled: $('#mailbox-enabled').checked,
        host: $('#imap-host').value.trim(),
        port: Number($('#imap-port').value),
        username: $('#imap-username').value.trim(),
        password: $('#imap-password').value,
        ssl: $('#imap-ssl').checked,
        reports_folder: $('#reports-folder').value.trim(),
        archive_folder: $('#archive-folder').value.trim(),
        watch: true
      },
      snapshots: {
        enabled: $('#snapshots-enabled').checked,
        cron: $('#snapshot-cron').value.trim(),
        delete_cron: $('#snapshot-delete-cron').value.trim(),
        timezone: $('#snapshot-timezone').value.trim(),
        retention_days: Number($('#snapshot-retention').value),
        min_count: Number($('#snapshot-min').value),
        max_count: Number($('#snapshot-max').value)
      }
    };
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save settings');
    state.settings = clone(result);
    $('#imap-password').value = '';
    $('#imap-password-status').textContent = result.mailbox.password_set ? 'A password is saved. Leave this blank to keep it.' : 'No password is saved.';
    message.textContent = result.snapshot_notice || (result.parsedmarc_restart_required ? 'Settings saved. Restart parsedmarc to apply mailbox changes.' : 'Settings saved. Checks have been refreshed.');
    message.className = result.snapshot_notice ? 'pending' : 'success';
    renderSettingsDomains();
    await loadStatus();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'failure';
  } finally {
    button.disabled = false;
    button.textContent = 'Save settings';
  }
}

function normalizedRoute(pathname) {
  return ['/', '/domains', '/settings', '/help'].includes(pathname) ? pathname : '/';
}

async function showRoute(pathname, push = false) {
  const route = normalizedRoute(pathname);
  state.route = route;
  document.title = `${{ '/': 'Dashboard', '/domains': 'Domains', '/settings': 'Settings', '/help': 'Help' }[route]} · MailPosture`;
  if (push) history.pushState({}, '', route);
  const viewByRoute = { '/': '#dashboard-view', '/domains': '#domains-view', '/settings': '#settings-view', '/help': '#help-view' };
  Object.values(viewByRoute).forEach(selector => { $(selector).hidden = selector !== viewByRoute[route]; });
  const quiet = ['/settings', '/help'].includes(route);
  $('#refresh').hidden = quiet;
  $('#updated').hidden = quiet;
  document.querySelectorAll('[data-route]').forEach(link => {
    const active = link.getAttribute('href') === route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  if (route === '/settings' && !state.settingsLoaded) {
    try { await loadSettings(); } catch (error) { $('#settings-message').textContent = error.message; $('#settings-message').className = 'failure'; }
  }
  if (route === '/') renderDashboard();
  if (route === '/domains') renderDomain();
}

$('#refresh').onclick = async () => {
  const button = $('#refresh');
  button.disabled = true;
  button.textContent = 'Checking…';
  try { state.data = await fetch('/api/refresh', { method: 'POST' }).then(response => response.json()); renderStatus(); }
  finally { button.disabled = false; button.textContent = 'Run checks'; }
};

$('#settings-form').addEventListener('submit', saveSettings);
$('#domain-form').addEventListener('submit', saveDomain);
$('#add-domain').onclick = () => openDomainEditor();
$('#selector-add').onclick = addSelector;
$('#endpoint-add').onclick = addEndpoint;
document.querySelectorAll('.domain-cancel').forEach(button => { button.onclick = () => $('#domain-dialog').close(); });
document.querySelectorAll('input[name="theme"]').forEach(input => { input.onchange = () => setTheme(input.value); });
$('#report-source').onchange = updateSettingsVisibility;
$('#mailbox-enabled').onchange = updateSettingsVisibility;
$('#snapshots-enabled').onchange = updateSettingsVisibility;
$('#archive-folder').oninput = updateSettingsVisibility;
themeQuery.addEventListener?.('change', () => { if ((localStorage.getItem('mailposture-theme') || 'system') === 'system') setTheme('system', false); });

document.onclick = event => {
  const route = event.target.closest('[data-route]');
  if (route) { event.preventDefault(); showRoute(route.getAttribute('href'), true); return; }
  const openDomain = event.target.closest('[data-open-domain]');
  if (openDomain) { state.selected = Number(openDomain.dataset.openDomain); showRoute('/domains', true); return; }
  const domain = event.target.closest('[data-domain]');
  if (domain) { state.selected = Number(domain.dataset.domain); renderDomain(); return; }
  const dashboardCheck = event.target.closest('[data-dashboard-check]');
  if (dashboardCheck) { state.selected = Number(dashboardCheck.dataset.domainIndex); detail(dashboardCheck.dataset.dashboardCheck); return; }
  const check = event.target.closest('[data-check]');
  if (check) { detail(check.dataset.check); return; }
  if (event.target.closest('[data-add-domain]')) { openDomainEditor(); return; }
  const editDomain = event.target.closest('[data-edit-domain]');
  if (editDomain) { openDomainEditor(Number(editDomain.dataset.editDomain)); return; }
  const removeDomain = event.target.closest('[data-remove-domain]');
  if (removeDomain) {
    const index = Number(removeDomain.dataset.removeDomain);
    const removed = state.settings.monitored_domains.splice(index, 1)[0];
    delete state.settings.dkim_selectors[removed];
    delete state.settings.tls_endpoints[removed];
    renderSettingsDomains();
    $('#settings-message').textContent = `${removed} was removed. Save settings to apply this change.`;
    $('#settings-message').className = 'pending';
    return;
  }
  const editSelector = event.target.closest('[data-edit-selector]');
  if (editSelector) {
    const index = Number(editSelector.dataset.editSelector);
    state.editor.editingSelector = index;
    $('#selector-input').value = state.editor.selectors[index];
    $('#selector-input').focus();
    $('#selector-add').textContent = '✓';
    return;
  }
  const removeSelector = event.target.closest('[data-remove-selector]');
  if (removeSelector) { state.editor.selectors.splice(Number(removeSelector.dataset.removeSelector), 1); state.editor.editingSelector = null; $('#selector-input').value = ''; $('#selector-add').textContent = '＋'; renderEditorLists(); return; }
  const editEndpoint = event.target.closest('[data-edit-endpoint]');
  if (editEndpoint) {
    const index = Number(editEndpoint.dataset.editEndpoint);
    const endpoint = state.editor.endpoints[index];
    state.editor.editingEndpoint = index;
    $('#endpoint-host').value = endpoint.host;
    $('#endpoint-port').value = endpoint.port;
    $('#endpoint-host').focus();
    $('#endpoint-add').textContent = '✓';
    return;
  }
  const removeEndpoint = event.target.closest('[data-remove-endpoint]');
  if (removeEndpoint) { state.editor.endpoints.splice(Number(removeEndpoint.dataset.removeEndpoint), 1); state.editor.editingEndpoint = null; $('#endpoint-host').value = ''; $('#endpoint-port').value = '443'; $('#endpoint-add').textContent = '＋'; renderEditorLists(); }
};

window.onpopstate = () => showRoute(location.pathname);
$('#detail-dialog .close').onclick = () => $('#detail-dialog').close();
$('#detail-dialog').onclick = event => { if (event.target === $('#detail-dialog')) $('#detail-dialog').close(); };
$('#domain-dialog').onclick = event => { if (event.target === $('#domain-dialog')) $('#domain-dialog').close(); };
$('#selector-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addSelector(); } };
$('#endpoint-host').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addEndpoint(); } };
$('#endpoint-port').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addEndpoint(); } };

setTheme(localStorage.getItem('mailposture-theme') || 'system', false);
showRoute(location.pathname);
loadStatus();
setInterval(() => { if (state.data) $('#updated').textContent = ago(state.data.generated_at); }, 15000);
