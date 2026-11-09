// 看我笑話外掛的本機連線程式（jokesonme 平台 change claude-ticket-tools；spec「Plugin tools」）。
// 讓 Claude 在任何資料夾替本人開票、查票、認領、交付、驗收。每個工具都轉呼叫平台的 /api/claude/* 端點，
// 平台用的是跟網頁同一套規則，所以這裡不判斷權限、只負責轉送與把結果寫成中文。
//
// 外掛資料夾沒有 node_modules，所以這支程式不能 import 任何套件，只用 node 內建模組與 fetch。
// 通訊：stdio 一行一則 JSON-RPC 2.0（寫法同傑比工具組的 dashboard bridge）。
//
// 連結流程：平台「我的」→「連結 Claude」→ 產生連結碼 jk_link_… → 跟 Claude 說「連結看我笑話，代碼 …」
// → link_account 打 POST /api/claude/link 換成這台電腦專用的金鑰 jk_cl_…，存到本機設定檔（權限 0600）。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const API_VERSION = 1;
export const DEFAULT_URL = 'https://jokesonme.jesse-chen.workers.dev';
const USER_AGENT = 'jokesonme-claude-plugin/1.0';
const TOKEN_RE = /^jk_cl_[0-9a-f]{64}$/;
const CODE_RE = /jk_link_[0-9a-f]{24}/;

export function tokenFilePath(env = process.env, platform = process.platform) {
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Jokesonme', 'claude.json');
  return join(homedir(), '.config', 'jokesonme', 'claude.json');
}

/* ---------- 給使用者看的固定句子 ---------- */

export const MSG = {
  notLinked:
    '這台電腦還沒連結看我笑話（或連結已被撤銷）。\n' +
    '1. 登入看我笑話平台，到「我的」→「連結 Claude」，按「產生連結碼」。\n' +
    '2. 把頁面上那句「連結看我笑話，代碼 jk_link_…」貼給 Claude。\n' +
    '連結碼 10 分鐘內有效、只能用一次。',
  offline: '連不到看我笑話平台，請確認網路後再試。',
  badCode: '連結碼的格式不對。請到平台「我的」→「連結 Claude」重新產生，把整句「連結看我笑話，代碼 jk_link_…」貼過來。',
  outdated: '看我笑話平台已經更新，請更新外掛：在 Claude 輸入 /plugin marketplace update jokesonme，再重新開啟 Claude。',
};

export function config(env = process.env) {
  return {
    tokenFile: env.JOKESONME_TOKEN_FILE || tokenFilePath(env),
    urlOverride: env.JOKESONME_URL ? env.JOKESONME_URL.replace(/\/+$/, '') : null,
  };
}

/** 讀設定檔 { baseUrl, token, name, linkedAt }；不存在、壞掉、金鑰格式不對都當沒連結（null）。 */
export function readLink(file) {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof j?.token !== 'string' || !TOKEN_RE.test(j.token)) return null;
    return { baseUrl: typeof j.baseUrl === 'string' ? j.baseUrl.replace(/\/+$/, '') : DEFAULT_URL, token: j.token, name: j.name ?? null, linkedAt: j.linkedAt ?? null };
  } catch {
    return null;
  }
}

export function writeLink(file, link) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // 檔案已存在時 writeFileSync 不會改權限
}

export function deviceName() {
  return hostname().replace(/\.local$/, '').slice(0, 80) || '這台電腦';
}

/* ---------- 呼叫平台 ---------- */

/** 回 { ok: true, status, data } 或 { ok: false, error }；401 一律換成「還沒連結」的說明。 */
export function makeCaller(cfg, fetchImpl = fetch) {
  return async function call(path, { method = 'GET', body, auth = true } = {}) {
    let base = cfg.urlOverride ?? DEFAULT_URL;
    const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
    if (auth) {
      const link = readLink(cfg.tokenFile);
      if (!link) return { ok: false, error: MSG.notLinked };
      base = cfg.urlOverride ?? link.baseUrl;
      headers.authorization = `Bearer ${link.token}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      return { ok: false, error: MSG.offline };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.status === 401 && auth) return { ok: false, error: MSG.notLinked };
    if (!res.ok) return { ok: false, error: data?.error || `看我笑話平台回應錯誤（${res.status}），請稍後再試。` };
    return { ok: true, status: res.status, data, base };
  };
}

/* ---------- 把結果寫成中文 ---------- */

const ACTION_LABEL = { claim: '認領', unclaim: '取消認領', deliver: '交付', accept: '驗收通過', reject: '退回', wontfix: '不做' };

export function ticketLine(t) {
  return `T-${t.number}《${t.title}》（${t.categoryLabel}／${t.statusLabel}）回報：${t.reporter}，認領：${t.owner ?? '沒人'}`;
}

export function ticketDetail(d) {
  const t = d.ticket;
  const lines = [
    `T-${t.number}《${t.title}》`,
    `分類：${t.categoryLabel}　狀態：${t.statusLabel}　回報：${t.reporter}　認領：${t.owner ?? '沒人'}`,
    `下一步：${d.nextStep}`,
    `你現在能做的動作：${d.allowedActions.length ? d.allowedActions.map((a) => ACTION_LABEL[a] ?? a).join('、') : '沒有'}`,
    `網頁：${t.url}`,
    '',
    '描述：',
    t.description?.trim() || '（沒有寫描述）',
    '',
    '歷史：',
    ...d.history.map((h) => `- ${h.at.slice(0, 16).replace('T', ' ')} ${h.who} ${h.action}${h.note ? `：${h.note}` : ''}`),
  ];
  if (d.kickoff) lines.push('', '開工指令（認領人與管理員才看得到）：', d.kickoff);
  return lines.join('\n');
}

/* ---------- 工具 ---------- */

const CONFIRM_FIRST = '呼叫前一定要先把要送出的內容完整列給使用者看，等對方明確說好才呼叫；不要自己決定。';

export const TOOLS = [
  {
    name: 'whoami',
    description: '查這台電腦連結的是看我笑話平台的哪個人、連結是否還有效。使用者問「我連好了嗎」「我是誰」時用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const r = await ctx.call('/api/claude/whoami');
      if (!r.ok) return r;
      const v = await ctx.call('/api/claude/version', { auth: false });
      const outdated = v.ok && Number(v.data?.api) > API_VERSION;
      return { ok: true, text: `已連結：${r.data.name}（${r.data.role === 'admin' ? '管理員' : '成員'}）。${outdated ? `\n${MSG.outdated}` : ''}` };
    },
  },
  {
    name: 'link_account',
    description: '用平台產生的連結碼把這台電腦連結到看我笑話。使用者貼出「連結看我笑話，代碼 jk_link_…」時呼叫，code 帶整句或只帶代碼都可以。',
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: '連結碼 jk_link_…（可以是包含它的整句話）' } }, required: ['code'], additionalProperties: false },
    async run(ctx, args) {
      const m = CODE_RE.exec(String(args.code ?? ''));
      if (!m) return { ok: false, error: MSG.badCode };
      const r = await ctx.call('/api/claude/link', { method: 'POST', auth: false, body: { code: m[0], device: deviceName() } });
      if (!r.ok) return r;
      writeLink(ctx.cfg.tokenFile, { baseUrl: r.base, token: r.data.token, name: r.data.name, linkedAt: new Date().toISOString() });
      return { ok: true, text: `已連結為 ${r.data.name}。之後在任何資料夾都可以請我開票、查票、認領、交付、驗收。要取消連結，到平台「我的」→「連結 Claude」按撤銷。` };
    },
  },
  {
    name: 'list_tickets',
    description: '列出看我笑話平台「開發」頁的票。預設列進行中（待處理、處理中、待驗收）；closed=true 列已結案；mine=true 只列我開的或我認領的。開票前也用這個查有沒有重複的票。',
    inputSchema: {
      type: 'object',
      properties: { closed: { type: 'boolean', description: '列已結案（已完成、不做）' }, mine: { type: 'boolean', description: '只列我開的或我認領的' } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const qs = new URLSearchParams();
      if (args.closed) qs.set('seg', 'closed');
      if (args.mine) qs.set('mine', '1');
      const r = await ctx.call(`/api/claude/tickets${qs.size ? `?${qs}` : ''}`);
      if (!r.ok) return r;
      const list = r.data.tickets ?? [];
      return { ok: true, text: list.length ? list.map(ticketLine).join('\n') : '沒有符合的票。' };
    },
  },
  {
    name: 'get_ticket',
    description: '看一張票的完整內容：描述、歷史、下一步、我現在能做的動作；我是認領人或管理員時也會附上開工指令。',
    inputSchema: { type: 'object', properties: { number: { type: 'integer', minimum: 1, description: '票號 T-n 的 n' } }, required: ['number'], additionalProperties: false },
    async run(ctx, args) {
      const r = await ctx.call(`/api/claude/tickets/${Number(args.number)}`);
      if (!r.ok) return r;
      return { ok: true, text: ticketDetail(r.data) };
    },
  },
  {
    name: 'create_ticket',
    description:
      `在看我笑話平台「開發」頁開一張票，回報人是使用者本人。${CONFIRM_FIRST}` +
      '開票前照 ticket-rules 使用指引：問清楚四段描述、用 list_tickets 查重複、列出完整草稿（標題、分類、描述）給使用者確認。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 120, description: '標題，120 字以內' },
        category: { type: 'string', enum: ['新功能', '修 Bug', '改善流程', '修正資料'], description: '分類' },
        description: { type: 'string', description: '四段描述：現在怎樣／希望變成／做完看得到什麼（驗收）／誰會用、誰看得到' },
      },
      required: ['title', 'category', 'description'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const r = await ctx.call('/api/claude/tickets', { method: 'POST', body: { title: args.title, category: args.category, description: args.description } });
      if (!r.ok) return r;
      return { ok: true, text: `已開票 T-${r.data.number}：${r.data.url}` };
    },
  },
  {
    name: 'act_on_ticket',
    description:
      `對一張票做動作：認領（claim）、取消認領（unclaim）、交付（deliver）、驗收通過（accept）、退回（reject）、不做（wontfix）。${CONFIRM_FIRST}` +
      '退回與不做一定要帶 note（原因）。編輯票與重新開放只能到網頁上做。',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1, description: '票號 T-n 的 n' },
        action: { type: 'string', enum: ['claim', 'unclaim', 'deliver', 'accept', 'reject', 'wontfix'] },
        note: { type: 'string', description: '原因（退回、不做必填）' },
      },
      required: ['number', 'action'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const r = await ctx.call(`/api/claude/tickets/${Number(args.number)}/actions`, { method: 'POST', body: { action: args.action, note: args.note ?? '' } });
      if (!r.ok) return r;
      return { ok: true, text: `T-${r.data.number} 已${ACTION_LABEL[args.action] ?? args.action}。` };
    },
  },
];

const INSTRUCTIONS =
  '看我笑話平台「開發」頁的票。使用者說「幫我開一張票」「把這個記成票」→ 照 ticket-rules 使用指引問清楚、查重複、列草稿確認後 create_ticket；' +
  '「有哪些票」→ list_tickets；「T-3 現在怎樣」→ get_ticket；「我來做 T-3」「T-3 做好了」「T-3 驗收通過」→ 先確認再 act_on_ticket。' +
  '工具回「還沒連結」時，把那段說明原樣告訴使用者；使用者貼出連結碼就呼叫 link_account。';

/* ---------- stdio JSON-RPC ---------- */

export function serve(cfg = config(), io = { input: process.stdin, write: (s) => process.stdout.write(s) }, { fetchImpl = fetch } = {}) {
  const send = (msg) => io.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const tools = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const ctx = { cfg, call: makeCaller(cfg, fetchImpl) };
  createInterface({ input: io.input }).on('line', async (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.id === undefined || req.id === null) return; // 通知（initialized 等）不用回
    try {
      if (req.method === 'initialize') {
        send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jokesonme', version: '1.0.0' }, instructions: INSTRUCTIONS } });
      } else if (req.method === 'tools/list') {
        send({ id: req.id, result: { tools } });
      } else if (req.method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === req.params?.name);
        if (!tool) {
          send({ id: req.id, error: { code: -32602, message: `沒有 ${req.params?.name} 這個工具` } });
          return;
        }
        const r = await tool.run(ctx, req.params?.arguments ?? {});
        send({ id: req.id, result: { content: [{ type: 'text', text: r.ok ? r.text : r.error }], isError: !r.ok } });
      } else if (req.method === 'ping') {
        send({ id: req.id, result: {} });
      } else {
        send({ id: req.id, error: { code: -32601, message: `不支援 ${req.method}` } });
      }
    } catch (e) {
      send({ id: req.id, error: { code: -32603, message: `工具出錯：${e?.message ?? e}` } });
    }
  });
}

// 被測試 import 時不要啟動
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) serve();
