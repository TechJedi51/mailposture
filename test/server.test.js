'use strict';
const assert=require('assert'),fs=require('fs');
const app=require('../server');
async function run(){
  assert.deepStrictEqual(app.assignments('example.com=s1|s2;example.net=google'),{'example.com':['s1','s2'],'example.net':['google']});
  process.env.MONITORED_DOMAINS='example.com,example.net';
  process.env.DKIM_SELECTORS='example.com=s1|s2;example.net=google';
  process.env.TLS_ENDPOINTS='example.com=mta-sts.example.com:443|mail.example.com:465';
  process.env.OPENSEARCH_PASSWORD='test-only';
  const config=app.envConfig();
  assert.strictEqual(config.domains.length,2);
  assert.deepStrictEqual(config.domains[0].dkim_selectors,['s1','s2']);
  assert.deepStrictEqual(config.domains[0].tls_endpoints,[{host:'mta-sts.example.com',port:443},{host:'mail.example.com',port:465}]);
  assert.strictEqual(app.mxMatch('mx1.example.com','*.example.com'),true);
  process.env.DEMO_MODE='true';const status=await app.refresh();assert.strictEqual(status.domains.length,1);assert.ok(status.summary.critical>0);
  assert.match(fs.readFileSync('public/index.html','utf8'),/MailPosture/);
  console.log('All MailPosture checks passed.');
}
run().catch(e=>{console.error(e);process.exitCode=1});
