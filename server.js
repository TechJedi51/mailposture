'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || 15);
const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const PUBLIC = path.join(__dirname, 'public');
const startedAt = Date.now();
let snapshot = { generated_at: null, refreshing: false, domains: [], summary: { critical: 0, warning: 0, healthy: 0 } };
let activeRefresh = null;

function assignments(value) {
  const output = {};
  for (const item of String(value || '').split(';').map(v => v.trim()).filter(Boolean)) {
    const i = item.indexOf('=');
    if (i < 1) throw new Error(`Invalid mapping "${item}"; expected domain=value|value`);
    output[item.slice(0, i).trim().toLowerCase()] = item.slice(i + 1).split('|').map(v => v.trim()).filter(Boolean);
  }
  return output;
}

function envConfig() {
  const domains = String(process.env.MONITORED_DOMAINS || '').split(',').map(v => v.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  if (!domains.length) throw new Error('MONITORED_DOMAINS must contain at least one domain');
  const selectors = assignments(process.env.DKIM_SELECTORS);
  const endpoints = assignments(process.env.TLS_ENDPOINTS);
  const reportDays = Number(process.env.REPORT_DAYS || 7);
  return {
    opensearch: {
      enabled: String(process.env.OPENSEARCH_ENABLED || 'true').toLowerCase() !== 'false',
      url: process.env.OPENSEARCH_URL || 'http://parsedmarc-opensearch:9200',
      index: process.env.OPENSEARCH_INDEX || 'dmarc_aggregate*',
      username: process.env.OPENSEARCH_USERNAME || 'admin',
      password: process.env.OPENSEARCH_PASSWORD || '',
      verify_tls: String(process.env.OPENSEARCH_VERIFY_TLS || 'false').toLowerCase() === 'true'
    },
    domains: domains.map(domain => ({
      domain,
      dkim_selectors: selectors[domain] || [],
      tls_endpoints: (endpoints[domain] || []).map(value => {
        const match = value.match(/^(.*?)(?::(\d+))?$/);
        return { host: match[1], port: Number(match[2] || 443) };
      }),
      report_days: reportDays
    }))
  };
}

function result(id, label, status, summary, detail, action, evidence = {}) { return { id, label, status, summary, detail, action, evidence }; }
function tags(record) {
  return Object.fromEntries(String(record || '').split(';').map(v => v.trim()).filter(Boolean).map(term => {
    const i = term.indexOf('='); return i < 0 ? [term.toLowerCase(), ''] : [term.slice(0, i).trim().toLowerCase(), term.slice(i + 1).trim()];
  }));
}
async function txt(name) { return (await dns.resolveTxt(name)).map(parts => parts.join('')); }
function protocol(records, prefix) { return records.filter(v => v.trim().toLowerCase().startsWith(prefix.toLowerCase())); }

async function dmarc(domain) {
  try {
    const found = protocol(await txt(`_dmarc.${domain}`), 'v=DMARC1');
    if (found.length !== 1) return result('dmarc', 'DMARC', 'critical', found.length ? 'Multiple DMARC records' : 'No DMARC policy', 'Receivers require exactly one DMARC1 TXT record.', 'Publish exactly one DMARC record with aggregate reporting.', { records: found });
    const parsed = tags(found[0]); const policy = (parsed.p || '').toLowerCase(); const pct = Number(parsed.pct || 100); const issues = [];
    if (!policy) issues.push('The required p tag is missing.');
    if (policy === 'none') issues.push('The policy monitors but does not enforce.');
    if (pct < 100) issues.push(`Enforcement covers only ${pct}% of failing mail.`);
    if (!parsed.rua) issues.push('No aggregate-report destination is published.');
    const status = !policy ? 'critical' : issues.length ? 'warning' : 'healthy';
    return result('dmarc', 'DMARC', status, `${policy || 'incomplete'} · ${pct}%`, issues.join(' ') || 'Enforcement and aggregate reporting are configured.', status === 'healthy' ? 'Keep reviewing legitimate sources and failures.' : 'Align every legitimate sender, then move toward p=reject; pct=100.', { record: found[0], tags: parsed });
  } catch (error) { return result('dmarc', 'DMARC', 'critical', 'No DMARC policy', error.message, 'Publish exactly one DMARC1 TXT record.'); }
}

function get(url, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith('https:') ? https : http).get(url, { timeout: TIMEOUT, headers: { 'user-agent': 'MailPosture/0.2.1' } }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > maxBytes) req.destroy(new Error('Response is too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out'))); req.on('error', reject);
  });
}

function policyFile(body) {
  const values = {};
  for (const line of body.split(/\r?\n/)) { const i = line.indexOf(':'); if (i < 0) continue; const key = line.slice(0, i).trim().toLowerCase(); const value = line.slice(i + 1).trim(); if (key === 'mx') (values.mx ||= []).push(value); else values[key] = value; }
  return values;
}
function mxMatch(host, pattern) { const h = host.toLowerCase().replace(/\.$/, ''); const p = pattern.toLowerCase().replace(/\.$/, ''); return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h !== p.slice(2) : h === p; }

async function mtaSts(domain) {
  const evidence = {};
  try {
    const records = protocol(await txt(`_mta-sts.${domain}`), 'v=STSv1'); evidence.dns = records;
    if (records.length !== 1) return result('mta_sts', 'MTA-STS', 'critical', 'Not configured', 'Expected exactly one STSv1 DNS signal.', 'Publish the DNS signal and a valid HTTPS policy.', evidence);
    const response = await get(`https://mta-sts.${domain}/.well-known/mta-sts.txt`, 65536); evidence.http_status = response.status;
    if (response.status !== 200) return result('mta_sts', 'MTA-STS', 'critical', `Policy returned HTTP ${response.status}`, 'Senders require a successful policy fetch.', 'Serve the policy at the exact well-known path.', evidence);
    const policy = policyFile(response.body); const mx = await dns.resolveMx(domain); evidence.policy = policy; evidence.domain_mx = mx;
    if (policy.version !== 'STSv1' || !['enforce', 'testing', 'none'].includes(policy.mode) || !policy.max_age || (policy.mode !== 'none' && !(policy.mx || []).length)) return result('mta_sts', 'MTA-STS', 'critical', 'Invalid policy', 'Required policy fields are missing or invalid.', 'Set version, mode, max_age, and the MX entries.', evidence);
    const uncovered = mx.map(v => v.exchange).filter(host => !(policy.mx || []).some(pattern => mxMatch(host, pattern)));
    if (uncovered.length) return result('mta_sts', 'MTA-STS', 'critical', 'MX hosts not covered', uncovered.join(', '), 'Add every active mail exchanger to the policy.', evidence);
    if (policy.mode !== 'enforce') return result('mta_sts', 'MTA-STS', 'warning', `${policy.mode} mode`, 'Authenticated TLS is not yet required.', 'Review TLS reports, change to enforce, and rotate the DNS id.', evidence);
    return result('mta_sts', 'MTA-STS', 'healthy', 'Enforced', `${mx.length} MX host(s) covered.`, 'Rotate the DNS id whenever the policy changes.', evidence);
  } catch (error) { return result('mta_sts', 'MTA-STS', 'critical', 'Check failed', error.message, 'Verify DNS, HTTPS, and the policy endpoint.', evidence); }
}

async function tlsRpt(domain) {
  try { const found = protocol(await txt(`_smtp._tls.${domain}`), 'v=TLSRPTv1'); if (found.length === 1 && tags(found[0]).rua) return result('tls_rpt', 'TLS reporting', 'healthy', 'Reports enabled', 'SMTP TLS failures have a report destination.', 'Review TLS reports before policy changes.', { record: found[0] }); }
  catch (_) {}
  return result('tls_rpt', 'TLS reporting', 'warning', 'Reports unavailable', 'No valid TLSRPTv1 record with rua was found.', 'Publish a TLS-RPT record so delivery failures are observable.');
}

async function bimi(domain, dmarcResult) {
  try {
    const found = protocol(await txt(`default._bimi.${domain}`), 'v=BIMI1');
    if (found.length !== 1) return result('bimi', 'BIMI', 'warning', 'Not configured', 'Expected exactly one BIMI1 record.', 'Publish BIMI after DMARC enforcement and a compliant logo are ready.');
    const parsed = tags(found[0]); const dm = dmarcResult.evidence.tags || {}; const enforced = ['quarantine', 'reject'].includes((dm.p || '').toLowerCase()) && Number(dm.pct || 100) === 100;
    if (!enforced) return result('bimi', 'BIMI', 'critical', 'DMARC prerequisite not met', 'BIMI requires enforcement applied to all mail.', 'Enforce DMARC before troubleshooting BIMI.', { record: found[0] });
    if (!parsed.l?.startsWith('https://')) return result('bimi', 'BIMI', 'critical', 'Logo URL missing', 'The l tag must contain an HTTPS SVG URL.', 'Publish a compliant SVG Tiny P/S logo.', { record: found[0] });
    const logo = await get(parsed.l, 2097152); const safeSvg = logo.status === 200 && /<svg\b/i.test(logo.body) && !/<script\b|javascript:|<foreignObject\b/i.test(logo.body);
    if (!safeSvg) return result('bimi', 'BIMI', 'critical', 'Logo cannot be validated', `Logo endpoint returned HTTP ${logo.status}.`, 'Serve a safe, compliant SVG directly over HTTPS.', { record: found[0], logo_status: logo.status });
    return result('bimi', 'BIMI', parsed.a ? 'healthy' : 'warning', parsed.a ? 'Logo and certificate published' : 'Self-asserted logo', parsed.a ? 'Record, logo, and evidence URL are present.' : 'No VMC/CMC evidence URL is published.', parsed.a ? 'Recheck after changes.' : 'Consider a VMC or CMC for broader support.', { record: found[0], tags: parsed });
  } catch (error) { return result('bimi', 'BIMI', 'warning', 'Not configured', error.message, 'Publish BIMI after DMARC enforcement is ready.'); }
}

function certificate(endpoint) {
  return new Promise(resolve => {
    const socket = tls.connect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host, rejectUnauthorized: false, timeout: TIMEOUT }, () => {
      const cert = socket.getPeerCertificate(true); const authorized = socket.authorized; const authError = socket.authorizationError; socket.end();
      if (!cert.valid_to) return resolve(result(`tls_${endpoint.host}_${endpoint.port}`, 'TLS certificate', 'critical', `${endpoint.host}:${endpoint.port} unavailable`, 'No peer certificate was returned.', 'Check TLS availability.'));
      const expiry = new Date(cert.valid_to); const days = Math.floor((expiry - Date.now()) / 86400000); const evidence = { host: endpoint.host, port: endpoint.port, issuer: cert.issuer, valid_to: expiry.toISOString(), authorized, authorization_error: authError };
      if (!authorized) return resolve(result(`tls_${endpoint.host}_${endpoint.port}`, 'TLS certificate', 'critical', 'Certificate not trusted', String(authError), 'Install a publicly trusted certificate for this hostname.', evidence));
      const status = days < 14 ? 'critical' : days < 30 ? 'warning' : 'healthy'; resolve(result(`tls_${endpoint.host}_${endpoint.port}`, 'TLS certificate', status, `${days} days remaining`, `${endpoint.host}:${endpoint.port} presents a trusted certificate.`, days < 30 ? 'Confirm renewal is scheduled and working.' : 'No action required.', evidence));
    });
    socket.on('timeout', () => { socket.destroy(); resolve(result(`tls_${endpoint.host}_${endpoint.port}`, 'TLS certificate', 'critical', 'Connection timed out', `${endpoint.host}:${endpoint.port} did not respond.`, 'Check routing and service availability.')); });
    socket.on('error', error => resolve(result(`tls_${endpoint.host}_${endpoint.port}`, 'TLS certificate', 'critical', 'Connection failed', error.message, 'Check routing and TLS service availability.')));
  });
}

async function dkim(domain, selectors) {
  if (!selectors.length) return result('dkim', 'DKIM', 'warning', 'No selectors configured', 'Selectors cannot be discovered reliably from DNS.', 'Set DKIM_SELECTORS for this domain.');
  const keys = [];
  for (const selector of selectors) {
    try {
      const found = protocol(await txt(`${selector}._domainkey.${domain}`), 'v=DKIM1'); if (found.length !== 1) { keys.push({ selector, status: 'critical', issue: found.length ? 'multiple records' : 'record missing' }); continue; }
      const parsed = tags(found[0]); if (!parsed.p) { keys.push({ selector, status: 'critical', issue: 'key missing or revoked' }); continue; }
      let bits = null; try { const pem = `-----BEGIN PUBLIC KEY-----\n${parsed.p.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`; bits = crypto.createPublicKey(pem).asymmetricKeyDetails?.modulusLength || null; } catch (_) {}
      keys.push({ selector, bits, status: bits && bits < 1024 ? 'critical' : bits && bits < 2048 ? 'warning' : 'healthy', issue: bits && bits < 2048 ? `${bits}-bit RSA key` : null });
    } catch (error) { keys.push({ selector, status: 'critical', issue: 'record missing' }); }
  }
  const bad = keys.filter(v => v.status !== 'healthy'); const status = keys.some(v => v.status === 'critical') ? 'critical' : bad.length ? 'warning' : 'healthy';
  return result('dkim', 'DKIM', status, `${keys.length - bad.length}/${keys.length} selectors healthy`, bad.map(v => `${v.selector}: ${v.issue}`).join('; ') || 'Every configured selector publishes a usable key.', status === 'healthy' ? 'Retire old selectors only after mail has aged out.' : 'Replace missing, revoked, or weak keys.', { selectors: keys });
}

function osRequest(config, endpoint, method = 'GET', body = null) {
  const url = new URL(`${config.url.replace(/\/$/, '')}/${config.index}/${endpoint}`); const payload = body === null ? null : Buffer.from(JSON.stringify(body)); const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Basic ${auth}`, accept: 'application/json' }; if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    const req = (url.protocol === 'https:' ? https : http).request(url, { method, timeout: TIMEOUT, rejectUnauthorized: config.verify_tls, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { try { const data = JSON.parse(Buffer.concat(chunks)); const reason = data.error?.root_cause?.[0]?.reason || data.error?.caused_by?.reason || data.error?.reason; res.statusCode < 300 ? resolve(data) : reject(new Error(reason || `OpenSearch HTTP ${res.statusCode}`)); } catch (e) { reject(e); } });
    }); req.on('timeout', () => req.destroy(new Error('OpenSearch timed out'))); req.on('error', reject); req.end(payload || undefined);
  });
}

function selectSourceField(fields = {}) {
  const base = Object.values(fields.source_ip_address || {}).some(definition => definition.aggregatable);
  if (base) return 'source_ip_address';
  const keyword = Object.values(fields['source_ip_address.keyword'] || {}).some(definition => definition.aggregatable);
  return keyword ? 'source_ip_address.keyword' : null;
}

const sourceFieldCache = new Map();
async function sourceAggregationField(config) {
  const key = `${config.url}/${config.index}`;
  if (!sourceFieldCache.has(key)) sourceFieldCache.set(key, osRequest(config, '_field_caps?fields=source_ip_address,source_ip_address.keyword').then(data => selectSourceField(data.fields)).catch(() => null));
  return sourceFieldCache.get(key);
}

async function reports(domain, config, days) {
  if (!config.enabled) return result('dmarc_reports', 'DMARC reports', 'info', 'OpenSearch disabled', 'DNS posture is monitored, but parsedmarc aggregate results are not connected.', 'Set OPENSEARCH_ENABLED=true and supply the connection variables to add observed authentication results.');
  try {
    const sourceField = await sourceAggregationField(config);
    const failedAggregations = { total: { sum: { field: 'message_count' } } };
    if (sourceField) failedAggregations.sources = { terms: { field: sourceField, size: 5 }, aggs: { messages: { sum: { field: 'message_count' } } } };
    const data = await osRequest(config, '_search', 'POST', { size: 0, query: { bool: { must: [{ range: { date_begin: { gte: `now-${days}d` } } }, { match_phrase: { header_from: domain } }] } }, aggs: { total: { sum: { field: 'message_count' } }, passed: { filter: { term: { passed_dmarc: true } }, aggs: { total: { sum: { field: 'message_count' } } } }, failed: { filter: { term: { passed_dmarc: false } }, aggs: failedAggregations } } });
    const total = data.aggregations?.total?.value || 0; const passed = data.aggregations?.passed?.total?.value || 0; const failed = data.aggregations?.failed?.total?.value || 0; const rate = total ? Math.round(passed / total * 1000) / 10 : null; const sources = (data.aggregations?.failed?.sources?.buckets || []).map(v => ({ ip: v.key, messages: v.messages?.value || v.doc_count })); const status = !total ? 'warning' : rate < 90 ? 'critical' : rate < 98 ? 'warning' : 'healthy';
    const mappingNote = sourceField ? '' : ' Source-IP ranking is unavailable because the field is not aggregatable in these indices.';
    return result('dmarc_reports', 'DMARC reports', status, total ? `${rate}% aligned` : 'No recent reports', (total ? `${Math.round(failed)} of ${Math.round(total)} messages failed in ${days} days.` : 'No matching aggregate reports were found.') + mappingNote, total && status !== 'healthy' ? (sourceField ? 'Review top failing sources and align legitimate senders.' : 'Review failing records in parsedmarc and align legitimate senders.') : 'Watch for new failing sources.', { period_days: days, total, failed, pass_rate: rate, source_field: sourceField, top_failing_sources: sources });
  } catch (error) { return result('dmarc_reports', 'DMARC reports', 'warning', 'OpenSearch query failed', error.message, 'Verify the OpenSearch environment variables and parsedmarc index.'); }
}

function summarize(domain, checks) { const rank = { healthy: 0, info: 1, warning: 2, critical: 3 }; return { domain, status: checks.reduce((a, v) => rank[v.status] > rank[a] ? v.status : a, 'healthy'), checks, counts: { critical: checks.filter(v => v.status === 'critical').length, warning: checks.filter(v => v.status === 'warning').length, healthy: checks.filter(v => v.status === 'healthy').length } }; }
async function checkDomain(entry, config) {
  const dm = await dmarc(entry.domain); const [sts, tlsreport, brand, keys, aggregate, ...certs] = await Promise.all([mtaSts(entry.domain), tlsRpt(entry.domain), bimi(entry.domain, dm), dkim(entry.domain, entry.dkim_selectors), reports(entry.domain, config.opensearch, entry.report_days), ...entry.tls_endpoints.map(certificate)]);
  if (!certs.length) certs.push(result('tls_config', 'TLS certificate', 'warning', 'No endpoints configured', 'No certificate endpoints are configured for this domain.', 'Set TLS_ENDPOINTS for this domain.'));
  return summarize(entry.domain, [dm, aggregate, sts, tlsreport, brand, ...certs, keys]);
}
function demo() { return summarize('example.com', [result('dmarc','DMARC','warning','quarantine · 25%','Enforcement covers only 25%.','Increase enforcement after resolving legitimate senders.'), result('dmarc_reports','DMARC reports','critical','91.8% aligned','1,246 messages failed in 7 days.','Review the top failing sources.'), result('mta_sts','MTA-STS','healthy','Enforced','Every MX host is covered.','Rotate the DNS id after changes.'), result('bimi','BIMI','warning','Self-asserted logo','No mark certificate is published.','Consider a VMC or CMC.'), result('tls_demo','TLS certificate','healthy','64 days remaining','Certificate is trusted.','No action required.'), result('dkim','DKIM','warning','1/2 selectors healthy','legacy: 1024-bit key','Rotate the legacy key.')]); }

async function refresh() {
  if (activeRefresh) return activeRefresh; snapshot.refreshing = true;
  activeRefresh = (async () => { try { const config = process.env.DEMO_MODE === 'true' ? null : envConfig(); const domains = config ? await Promise.all(config.domains.map(v => checkDomain(v, config))) : [demo()]; snapshot = { generated_at: new Date().toISOString(), refreshing: false, domains, summary: { critical: domains.reduce((n,d)=>n+d.counts.critical,0), warning: domains.reduce((n,d)=>n+d.counts.warning,0), healthy: domains.reduce((n,d)=>n+d.counts.healthy,0) } }; } catch (error) { snapshot = { ...snapshot, generated_at: new Date().toISOString(), refreshing: false, error: error.message }; } finally { activeRefresh = null; } return snapshot; })(); return activeRefresh;
}

function json(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body); }
function staticFile(req, res) { const name = req.url === '/' ? 'index.html' : req.url.split('?')[0].replace(/^\//, ''); const file = path.normalize(path.join(PUBLIC, name)); if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); } fs.readFile(file, (e, data) => { if (e) { res.writeHead(404); return res.end(); } const type = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8' }[path.extname(file)] || 'application/octet-stream'; res.writeHead(200, { 'content-type': type, 'x-content-type-options':'nosniff' }); res.end(data); }); }
const server = http.createServer(async (req,res) => { if (req.url === '/healthz') return json(res, snapshot.error ? 503 : 200, { ok: !snapshot.error, uptime_seconds: Math.floor((Date.now()-startedAt)/1000) }); if (req.url === '/api/status' && req.method === 'GET') return json(res,200,snapshot); if (req.url === '/api/refresh' && req.method === 'POST') return json(res,202,await refresh()); staticFile(req,res); });
function start() { server.listen(PORT,'0.0.0.0',()=>{ console.log(`MailPosture listening on :${PORT}`); refresh(); setInterval(refresh,Math.max(1,REFRESH_MINUTES)*60000).unref(); }); }
if (require.main === module) start();
module.exports = { assignments, envConfig, tags, policyFile, mxMatch, selectSourceField, summarize, refresh, getSnapshot:()=>snapshot };
