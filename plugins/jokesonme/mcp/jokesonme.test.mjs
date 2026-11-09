// 看我笑話外掛本機連線程式的測試（spec「Plugin tools」）。不連網：平台用假的 fetch。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MSG, TOOLS, makeCaller, readLink, serve, writeLink } from './jokesonme.mjs';

const TOKEN = `jk_cl_${'a'.repeat(64)}`;
const CODE = `jk_link_${'b'.repeat(24)}`;
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'jk-')), 'sub', 'claude.json');

/** 假平台：依路徑回固定資料，並記下收到的請求 */
function fakePlatform(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${init.method ?? 'GET'} ${path}`] ?? { status: 404, body: { error: '找不到' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const tool = (name) => TOOLS.find((t) => t.name === name);
const ctxWith = (file, fetchImpl, urlOverride = null) => {
  const cfg = { tokenFile: file, urlOverride };
  return { cfg, call: makeCaller(cfg, fetchImpl) };
};

test('六個工具都在，會寫入平台的兩個描述開頭要求先確認', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['whoami', 'link_account', 'list_tickets', 'get_ticket', 'create_ticket', 'act_on_ticket']);
  for (const n of ['create_ticket', 'act_on_ticket']) assert.match(tool(n).description, /呼叫前一定要先把要送出的內容完整列給使用者看/);
  assert.doesNotMatch(tool('list_tickets').description, /呼叫前一定要/);
});

test('spec 情境：沒連結就請 Claude 開票 → 回連結說明，而且沒有打平台', async () => {
  const p = fakePlatform({});
  const ctx = ctxWith(tmpFile(), p.fetchImpl);
  for (const n of ['whoami', 'list_tickets', 'get_ticket', 'create_ticket', 'act_on_ticket']) {
    const r = await tool(n).run(ctx, { number: 1, title: 't', category: '新功能', description: '', action: 'claim' });
    assert.deepEqual(r, { ok: false, error: MSG.notLinked }, n);
  }
  assert.equal(p.calls.length, 0);
});

test('link_account：從整句話抓出連結碼、存設定檔且權限 0600', async () => {
  const file = tmpFile();
  const p = fakePlatform({ 'POST /api/claude/link': { status: 200, body: { token: TOKEN, name: '傑哥' } } });
  const ctx = ctxWith(file, p.fetchImpl, 'http://localhost:3107');
  const r = await tool('link_account').run(ctx, { code: `連結看我笑話，代碼 ${CODE}` });
  assert.equal(r.ok, true);
  assert.match(r.text, /已連結為 傑哥/);
  assert.equal(p.calls[0].body.code, CODE);
  assert.equal(p.calls[0].headers.authorization, undefined, '換金鑰時不帶舊金鑰');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readLink(file).token, TOKEN);
  assert.equal(readLink(file).baseUrl, 'http://localhost:3107');
});

test('link_account：碼格式不對不打平台；平台拒絕時原樣轉達中文原因', async () => {
  const p = fakePlatform({ 'POST /api/claude/link': { status: 400, body: { error: '連結碼已經用過，請到平台重新產生' } } });
  const ctx = ctxWith(tmpFile(), p.fetchImpl);
  assert.deepEqual(await tool('link_account').run(ctx, { code: '代碼 abc' }), { ok: false, error: MSG.badCode });
  assert.equal(p.calls.length, 0);
  assert.deepEqual(await tool('link_account').run(ctx, { code: CODE }), { ok: false, error: '連結碼已經用過，請到平台重新產生' });
  assert.equal(existsSync(ctx.cfg.tokenFile), false, '失敗時不寫設定檔');
});

test('已連結：帶金鑰呼叫，平台 401（被撤銷）轉成連結說明', async () => {
  const file = tmpFile();
  writeLink(file, { baseUrl: 'http://x', token: TOKEN, name: '傑哥' });
  const p = fakePlatform({ 'GET /api/claude/tickets': { status: 401, body: { error: 'revoked' } } });
  const r = await tool('list_tickets').run(ctxWith(file, p.fetchImpl), {});
  assert.deepEqual(r, { ok: false, error: MSG.notLinked });
  assert.equal(p.calls[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('壞掉的設定檔、格式不對的金鑰都當沒連結', () => {
  const file = tmpFile();
  writeLink(file, { token: 'jk_cl_short' });
  assert.equal(readLink(file), null);
  writeFileSync(file, '{壞掉');
  assert.equal(readLink(file), null);
});

test('列票、開票、動作：把平台結果寫成中文，分類用中文名稱送出', async () => {
  const file = tmpFile();
  writeLink(file, { baseUrl: 'http://x', token: TOKEN, name: '傑哥' });
  const p = fakePlatform({
    'GET /api/claude/tickets?mine=1': { status: 200, body: { tickets: [{ number: 3, title: '首頁倒數', categoryLabel: '新功能', statusLabel: '處理中', reporter: '傑哥', owner: '柏文' }] } },
    'POST /api/claude/tickets': { status: 201, body: { number: 7, url: 'http://x/tickets?t=7' } },
    'POST /api/claude/tickets/3/actions': { status: 400, body: { error: '認領人不能驗收自己做的票，請回報人或管理員驗收' } },
  });
  const ctx = ctxWith(file, p.fetchImpl);
  assert.equal((await tool('list_tickets').run(ctx, { mine: true })).text, 'T-3《首頁倒數》（新功能／處理中）回報：傑哥，認領：柏文');
  const c = await tool('create_ticket').run(ctx, { title: '行事曆週末顏色', category: '修 Bug', description: '現在怎樣：…' });
  assert.equal(c.text, '已開票 T-7：http://x/tickets?t=7');
  assert.deepEqual(p.calls[1].body, { title: '行事曆週末顏色', category: '修 Bug', description: '現在怎樣：…' });
  assert.deepEqual(await tool('act_on_ticket').run(ctx, { number: 3, action: 'accept' }), { ok: false, error: '認領人不能驗收自己做的票，請回報人或管理員驗收' });
});

test('連不到平台：回固定的離線說明', async () => {
  const file = tmpFile();
  writeLink(file, { baseUrl: 'http://x', token: TOKEN, name: '傑哥' });
  const ctx = ctxWith(file, async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await tool('whoami').run(ctx, {}), { ok: false, error: MSG.offline });
});

test('JSON-RPC：initialize、tools/list、tools/call、通知不回、未知方法回錯', async () => {
  const input = new PassThrough();
  const out = [];
  serve({ tokenFile: tmpFile(), urlOverride: null }, { input, write: (s) => out.push(JSON.parse(s)) }, { fetchImpl: async () => { throw new Error('不該連網'); } });
  const send = (m) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'list_tickets', arguments: {} } });
  send({ id: 4, method: 'nope' });
  await new Promise((r) => setTimeout(r, 50));
  const byId = Object.fromEntries(out.map((m) => [m.id, m]));
  assert.equal(out.length, 4, '通知不回應');
  assert.equal(byId[1].result.serverInfo.name, 'jokesonme');
  assert.equal(byId[2].result.tools.length, 6);
  assert.deepEqual(byId[3].result, { content: [{ type: 'text', text: MSG.notLinked }], isError: true });
  assert.equal(byId[4].error.code, -32601);
});
