#!/usr/bin/env node
/*
 * Loja do Jeff Insane — checkout Pix (SyncPay) com entrega automática do livro.
 *
 *  1. O site chama POST /api/pedido  → criamos a cobrança Pix no SyncPay e devolvemos o copia e cola.
 *  2. O SyncPay avisa em /webhook/syncpay/<token>  (e o site também pergunta em GET /api/pedido/:id).
 *     Nunca confiamos no aviso: sempre confirmamos o status direto na API do SyncPay.
 *  3. Pago → geramos um link de download pessoal (/baixar/<chave>) com os arquivos da última
 *     Release do repositório privado do livro.
 *
 * Sem dependências: Node 18+ (usa fetch nativo).  Configuração por variáveis de ambiente (veja .env.exemplo).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------------ configuração
const E = process.env;
function carregarEnv(arq) {               // lê um arquivo .env simples, se existir
  try {
    for (const linha of fs.readFileSync(arq, 'utf8').split(/\r?\n/)) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in E)) E[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
}
carregarEnv(path.join(__dirname, '.env'));

const CFG = {
  porta: +(E.PORT || 8787),
  urlPublica: (E.PUBLIC_URL || 'http://localhost:8787').replace(/\/$/, ''),
  origens: (E.ALLOWED_ORIGINS || 'https://gabrielbatman266.github.io').split(',').map(s => s.trim()),
  preco: +(E.PRECO || 19.90),
  produto: E.PRODUTO || 'Livro Já Deu Certo',
  syncBase: (E.SYNC_BASE || 'https://api.syncpayments.com.br').replace(/\/$/, ''),
  syncId: E.SYNC_CLIENT_ID || '',
  syncSecret: E.SYNC_CLIENT_SECRET || '',
  webhookToken: E.WEBHOOK_TOKEN || '',
  ghToken: E.GH_TOKEN || '',
  ghRepo: E.GH_REPO || 'Gabrielbatman266/Ja-Deu-Certo',
  telegramBot: E.TELEGRAM_BOT_TOKEN || '',
  telegramChat: E.TELEGRAM_CHAT_ID || '',
  maxDownloads: +(E.MAX_DOWNLOADS || 30),
  diasLink: +(E.DIAS_LINK || 365),
  mock: E.SYNC_MOCK === '1',              // modo de teste: não chama o SyncPay nem o GitHub
  pastaDados: E.DATA_DIR || path.join(__dirname, 'dados'),
  pastaMock: E.MOCK_FILES || path.join(__dirname, '..', 'build', 'dist'),
};
fs.mkdirSync(CFG.pastaDados, { recursive: true });
const ARQ = path.join(CFG.pastaDados, 'pedidos.json');

function faltando() {
  if (CFG.mock) return [];
  return ['SYNC_CLIENT_ID', 'SYNC_CLIENT_SECRET', 'WEBHOOK_TOKEN', 'GH_TOKEN', 'PUBLIC_URL'].filter(k => !E[k]);
}

// ------------------------------------------------------------------ armazenamento (arquivo JSON)
let DB = { pedidos: {} };
try { DB = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch (_) {}
let salvando = Promise.resolve();
function salvar() {
  salvando = salvando.then(() => {
    const tmp = ARQ + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 1));
    fs.renameSync(tmp, ARQ);
  }).catch(e => log('erro ao salvar', e.message));
  return salvando;
}
const id = (n = 18) => crypto.randomBytes(n).toString('base64url');
const agora = () => new Date().toISOString();
function log(...a) { console.log(new Date().toISOString().slice(0, 19), ...a); }

// ------------------------------------------------------------------ SyncPay
let tokenCache = { valor: '', expira: 0 };
async function syncToken() {
  if (tokenCache.valor && Date.now() < tokenCache.expira - 60_000) return tokenCache.valor;
  const r = await fetch(CFG.syncBase + '/api/partner/v1/auth-token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CFG.syncId, client_secret: CFG.syncSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('SyncPay auth ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  tokenCache = { valor: j.access_token, expira: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.valor;
}
async function syncFetch(caminho, opts = {}) {
  const t = await syncToken();
  const r = await fetch(CFG.syncBase + caminho, {
    ...opts, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
async function criarCobranca(p) {
  if (CFG.mock) return { pix_code: '00020126MOCK' + p.id.slice(0, 10) + '5204000053039865802BR6304MOCK', identifier: 'mock-' + p.id };
  const { ok, status, j } = await syncFetch('/api/partner/v1/cash-in', {
    method: 'POST',
    body: JSON.stringify({
      amount: CFG.preco, description: CFG.produto,
      webhook_url: `${CFG.urlPublica}/webhook/syncpay/${CFG.webhookToken}`,
      client: { name: p.nome, cpf: p.cpf, email: p.email, phone: p.telefone },
    }),
  });
  if (!ok || !j.pix_code) { const e = new Error('cash-in ' + status); e.detalhe = j; throw e; }
  return { pix_code: j.pix_code, identifier: j.identifier };
}
async function statusNoSyncPay(identifier) {
  if (CFG.mock) { const p = Object.values(DB.pedidos).find(x => x.identifier === identifier); return p && p._mockPago ? 'completed' : 'pending'; }
  const { ok, j } = await syncFetch('/api/partner/v1/transaction/' + encodeURIComponent(identifier));
  if (!ok) return null;
  const d = j.data || j;
  return { status: String(d.status || '').toLowerCase(), valor: +d.amount || 0 };
}

// ------------------------------------------------------------------ confirmação e entrega
async function confirmar(p, origem) {
  if (p.status === 'pago') return p;
  const r = await statusNoSyncPay(p.identifier);
  const st = typeof r === 'string' ? r : r && r.status;
  const valor = typeof r === 'object' && r ? r.valor : CFG.preco;
  if (st === 'completed') {
    if (!CFG.mock && valor && valor + 0.001 < CFG.preco) { log('valor menor que o preço', p.id, valor); return p; }
    p.status = 'pago'; p.pagoEm = agora(); p.chave = id(24); p.downloads = 0;
    p.expira = new Date(Date.now() + CFG.diasLink * 864e5).toISOString();
    await salvar();
    log('PAGO', p.id, origem);
    avisar(`💰 Venda confirmada: ${CFG.produto} · R$ ${CFG.preco.toFixed(2).replace('.', ',')}\n👤 ${p.nome}\n🕒 ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  } else if (['failed', 'refunded', 'med'].includes(st)) {
    p.status = st; await salvar();
  }
  return p;
}
function avisar(texto) {
  if (!CFG.telegramBot || !CFG.telegramChat) return;
  fetch(`https://api.telegram.org/bot${CFG.telegramBot}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CFG.telegramChat, text: texto }),
  }).catch(() => {});
}

let releaseCache = { em: 0, dados: null };
async function ultimaRelease() {
  if (CFG.mock) {
    const arquivos = fs.existsSync(CFG.pastaMock) ? fs.readdirSync(CFG.pastaMock) : [];
    return { tag: 'teste', assets: arquivos.map(n => ({ id: n, name: n, size: fs.statSync(path.join(CFG.pastaMock, n)).size })) };
  }
  if (releaseCache.dados && Date.now() - releaseCache.em < 5 * 60_000) return releaseCache.dados;
  const r = await fetch(`https://api.github.com/repos/${CFG.ghRepo}/releases/latest`, {
    headers: { Authorization: 'Bearer ' + CFG.ghToken, Accept: 'application/vnd.github+json', 'User-Agent': 'loja-jeff' },
  });
  if (!r.ok) throw new Error('GitHub release ' + r.status);
  const j = await r.json();
  releaseCache = { em: Date.now(), dados: { tag: j.tag_name, assets: j.assets.map(a => ({ id: a.id, name: a.name, size: a.size })) } };
  return releaseCache.dados;
}
const ROTULO = n => /Letra-Grande/.test(n) ? ['📄', 'PDF · letra grande', 'Pra quem gosta de letra maior'] :
  /\.pdf$/.test(n) ? ['📄', 'PDF', 'Pra ler no celular, no computador ou imprimir'] :
  /\.epub$/.test(n) ? ['📘', 'EPUB', 'Pra Kindle, Apple Books, Play Livros e outros leitores'] :
  /Interativo/.test(n) ? ['📱', 'Livro interativo', 'Abra no navegador do celular: tem jornada, busca e áudio'] : ['📎', n, ''];

// ------------------------------------------------------------------ validações
const soDig = s => String(s || '').replace(/\D/g, '');
function cpfValido(c) {
  c = soDig(c); if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) { let s = 0; for (let i = 0; i < t; i++) s += +c[i] * (t + 1 - i); if (((s * 10) % 11) % 10 !== +c[t]) return false; }
  return true;
}
const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));

// limite simples por IP
const tentativas = new Map();
function limitado(ip, max = 8, janela = 3600_000) {
  const t = Date.now(), l = (tentativas.get(ip) || []).filter(x => t - x < janela);
  l.push(t); tentativas.set(ip, l); return l.length > max;
}

// ------------------------------------------------------------------ HTTP
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (CFG.origens.includes(o) || CFG.origens.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}
function json(res, cod, obj) { res.writeHead(cod, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function corpo(req, max = 20_000) {
  return new Promise((ok, erro) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > max) { erro(new Error('grande demais')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (_) { ok({}); } });
  });
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ipDe = req => (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function paginaDownload(p, rel) {
  const itens = rel.assets.map(a => { const [ic, t, d] = ROTULO(a.name);
    return `<a class="f" href="/baixar/${p.chave}/${encodeURIComponent(a.id)}"><span>${ic}</span><span><b>${esc(t)}</b><small>${esc(d)} · ${(a.size / 1048576).toFixed(1)} MB</small></span><em>Baixar</em></a>`; }).join('');
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Seu livro · Já Deu Certo</title><style>
body{margin:0;background:radial-gradient(60vmax 40vmax at 85% 5%,rgba(180,100,255,.25),transparent 60%),#05040f;color:#ece8ff;font-family:system-ui,sans-serif;min-height:100vh}
main{max-width:480px;margin:0 auto;padding:40px 18px}h1{font-family:Georgia,serif;font-size:2rem;color:#ffe6a8;margin:.2em 0}
p{color:#b9b2dd;line-height:1.5}.f{display:flex;gap:14px;align-items:center;padding:14px 16px;margin:10px 0;border-radius:18px;background:rgba(22,16,52,.7);border:1px solid rgba(180,140,255,.3);color:#ece8ff;text-decoration:none}
.f span:first-child{font-size:1.6rem}.f span:nth-child(2){flex:1}.f b{display:block}.f small{color:#b9b2dd;font-size:.8rem}.f em{font-style:normal;font-weight:800;color:#05040f;background:#f5c96a;border-radius:99px;padding:8px 14px}
.box{margin-top:18px;padding:14px;border-radius:16px;border:1px dashed rgba(127,227,255,.4);font-size:.9rem;color:#b9b2dd}.k{color:#7fe3ff;font-weight:800;letter-spacing:.2em;font-size:.75rem}
</style></head><body><main><div class="k">PAGAMENTO CONFIRMADO ✦</div><h1>Já deu certo, ${esc(p.nome.split(' ')[0])}!</h1>
<p>Seu livro está pronto. Baixe os formatos que quiser. Este link é só seu.</p>${itens}
<div class="box">📌 <b>Guarde este link</b> (salve nos favoritos ou mande pra você mesmo no WhatsApp). Você pode baixar de novo quando quiser, e as atualizações do livro aparecem aqui.<br><br>Versão: ${esc(rel.tag)}</div>
<p style="font-size:.85rem;margin-top:22px">Algum problema? Fale comigo no WhatsApp e informe o código <b>${esc(p.id.slice(0, 8).toUpperCase())}</b>.</p></main></body></html>`;
}

function paginaSetup() {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Configurar loja</title>
<style>body{margin:0;background:#05040f;color:#ece8ff;font-family:system-ui,sans-serif}main{max-width:480px;margin:0 auto;padding:28px 18px}h1{color:#ffe6a8;font-family:Georgia,serif}
label{display:block;margin:14px 0;font-weight:700;font-size:.9rem;color:#b9b2dd}input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:13px;border-radius:12px;border:1px solid #4b3d8a;background:#120d2c;color:#fff;font-size:16px}
button{width:100%;padding:15px;border:0;border-radius:99px;background:#f5c96a;font-weight:800;font-size:1rem;margin-top:10px}small{color:#8f87b8}#out{margin-top:18px;padding:14px;border-radius:12px;background:#120d2c;white-space:pre-wrap;line-height:1.5}</style></head>
<body><main><h1>Configurar a loja ✦</h1><p>Status agora: <b>${faltando().length ? 'faltando ' + faltando().join(', ') : 'tudo configurado'}</b></p>
<form id="f"><label>Senha de configuração<input name="senha" type="password" required></label>
<label>SyncPay · client_id<input name="sync_id" required autocomplete="off"></label>
<label>SyncPay · client_secret<input name="sync_secret" type="password" required autocomplete="off"></label>
<label>GitHub · token só de leitura<input name="gh_token" type="password" required autocomplete="off"><small>Repositório Ja-Deu-Certo, permissão Contents: Read-only</small></label>
<label>Telegram · token do bot (opcional)<input name="tg_bot" autocomplete="off"></label>
<label>Telegram · chat id (opcional)<input name="tg_chat" autocomplete="off"></label>
<button>Salvar e testar</button></form><div id="out" hidden></div>
<script>f.onsubmit=async e=>{e.preventDefault();out.hidden=false;out.textContent='Testando…';const d=Object.fromEntries(new FormData(f));
const r=await fetch('/configurar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json();
out.textContent=j.ok?'SyncPay: '+j.teste.syncpay+'\\nGitHub: '+j.teste.github+'\\n\\nIP pra autorizar na SyncPay: '+j.ip+'\\nEndereço da loja: '+j.url+'\\n\\nSalvo. A loja reinicia sozinha em 2 segundos.':(j.erro||'Erro')}</script></main></body></html>`;
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const P = url.pathname;
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    // ---------- saúde
    if (P === '/' || P === '/saude') return json(res, 200, { ok: true, modo: CFG.mock ? 'teste' : 'real', faltando: faltando() });

    // ---------- configuração pelo celular (precisa de SENHA_SETUP no .env)
    if (P === '/configurar' && E.SENHA_SETUP) {
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(paginaSetup()); }
      if (req.method === 'POST') {
        if (limitado('setup:' + ipDe(req), 5, 600e3)) return json(res, 429, { erro: 'Muitas tentativas. Espere 10 minutos.' });
        const b = await corpo(req);
        if (String(b.senha || '') !== E.SENHA_SETUP) return json(res, 401, { erro: 'Senha errada.' });
        const novo = { SYNC_CLIENT_ID: b.sync_id, SYNC_CLIENT_SECRET: b.sync_secret, GH_TOKEN: b.gh_token, TELEGRAM_BOT_TOKEN: b.tg_bot, TELEGRAM_CHAT_ID: b.tg_chat };
        for (const k in novo) novo[k] = String(novo[k] || '').trim().replace(/[\r\n"']/g, '');
        // testa antes de salvar
        const teste = {};
        try { const r = await fetch(CFG.syncBase + '/api/partner/v1/auth-token', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_id: novo.SYNC_CLIENT_ID, client_secret: novo.SYNC_CLIENT_SECRET }) });
          const j = await r.json().catch(() => ({})); teste.syncpay = r.ok && j.access_token ? 'ok' : 'falhou (' + r.status + ') ' + (j.message || ''); } catch (e) { teste.syncpay = 'falhou: ' + e.message; }
        try { const r = await fetch(`https://api.github.com/repos/${CFG.ghRepo}/releases/latest`, { headers: { Authorization: 'Bearer ' + novo.GH_TOKEN, 'User-Agent': 'loja-jeff' } });
          const j = await r.json().catch(() => ({})); teste.github = r.ok ? 'ok (' + j.tag_name + ', ' + (j.assets || []).length + ' arquivos)' : 'falhou (' + r.status + ')'; } catch (e) { teste.github = 'falhou: ' + e.message; }
        if (!E.WEBHOOK_TOKEN) novo.WEBHOOK_TOKEN = id() + id();
        const arq = path.join(__dirname, '.env');
        let txt = fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : '';
        for (const [k, v] of Object.entries(novo)) { if (!v && k.startsWith('TELEGRAM')) continue; const re = new RegExp('^' + k + '=.*$', 'm'); txt = re.test(txt) ? txt.replace(re, k + '=' + v) : txt.replace(/\n?$/, '\n' + k + '=' + v + '\n'); }
        fs.writeFileSync(arq, txt, { mode: 0o600 });
        let ip = ''; try { ip = (await (await fetch('https://api.ipify.org')).text()).trim(); } catch (_) {}
        json(res, 200, { ok: true, teste, ip, url: CFG.urlPublica });
        log('configuração salva pelo /configurar; reiniciando'); setTimeout(() => process.exit(0), 600);   // o systemd liga de novo já com o .env novo
        return;
      }
    }

    // ---------- novo pedido
    if (P === '/api/pedido' && req.method === 'POST') {
      if (faltando().length) return json(res, 503, { erro: 'A loja ainda está sendo configurada. Compre pelo WhatsApp por enquanto.' });
      if (limitado(ipDe(req))) return json(res, 429, { erro: 'Muitas tentativas. Espere um pouco e tente de novo.' });
      const b = await corpo(req);
      const p = { id: id(), nome: String(b.nome || '').trim().slice(0, 80), cpf: soDig(b.cpf), email: String(b.email || '').trim().toLowerCase().slice(0, 120),
        telefone: soDig(b.telefone).replace(/^55(?=\d{10,11}$)/, ''), status: 'pendente', criado: agora(), origem: String(b.origem || '').slice(0, 40) };
      const erros = {};
      if (p.nome.length < 3) erros.nome = 'Escreva seu nome.';
      if (!cpfValido(p.cpf)) erros.cpf = 'CPF inválido.';
      if (!emailValido(p.email)) erros.email = 'E-mail inválido.';
      if (!/^\d{10,11}$/.test(p.telefone)) erros.telefone = 'WhatsApp com DDD, só números.';
      if (Object.keys(erros).length) return json(res, 422, { erro: 'Confira os dados.', erros });
      const c = await criarCobranca(p);
      Object.assign(p, c); DB.pedidos[p.id] = p; await salvar();
      log('pedido', p.id, p.identifier);
      return json(res, 200, { pedido: p.id, pix_code: p.pix_code, valor: CFG.preco });
    }

    // ---------- consultar pedido (o site pergunta a cada poucos segundos)
    let m = P.match(/^\/api\/pedido\/([\w-]{10,40})$/);
    if (m && req.method === 'GET') {
      const p = DB.pedidos[m[1]]; if (!p) return json(res, 404, { erro: 'Pedido não encontrado.' });
      if (p.status === 'pendente' && (!p._ultimo || Date.now() - p._ultimo > 4000)) { p._ultimo = Date.now(); await confirmar(p, 'consulta'); }
      return json(res, 200, { status: p.status, download: p.status === 'pago' ? `${CFG.urlPublica}/baixar/${p.chave}` : null });
    }

    // ---------- webhook do SyncPay (token no caminho; nunca confiamos no corpo)
    m = P.match(/^\/webhook\/syncpay\/([\w-]+)$/);
    if (m && req.method === 'POST') {
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!CFG.webhookToken || (m[1] !== CFG.webhookToken && auth !== CFG.webhookToken)) return json(res, 401, { erro: 'não autorizado' });
      const b = await corpo(req, 200_000); const d = b.data || b;
      const ids = [d.identifier, d.id, d.reference_id, d.transaction_id].filter(Boolean).map(String);
      const p = Object.values(DB.pedidos).find(x => ids.includes(String(x.identifier)));
      if (p) await confirmar(p, 'webhook'); else log('webhook sem pedido', ids.join(','));
      return json(res, 200, { ok: true });
    }

    // ---------- teste: simular pagamento
    m = P.match(/^\/teste\/pagar\/([\w-]+)$/);
    if (m && CFG.mock) { const p = DB.pedidos[m[1]]; if (!p) return json(res, 404, {}); p._mockPago = true; await confirmar(p, 'teste'); return json(res, 200, { ok: true }); }

    // ---------- página e arquivos do comprador
    m = P.match(/^\/baixar\/([\w-]{20,40})(?:\/([^/]+))?$/);
    if (m && req.method === 'GET') {
      const p = Object.values(DB.pedidos).find(x => x.chave === m[1]);
      if (!p || p.status !== 'pago') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Link inválido.'); }
      if (new Date(p.expira) < new Date()) { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Este link expirou. Fale comigo no WhatsApp.'); }
      const rel = await ultimaRelease();
      if (!m[2]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); return res.end(paginaDownload(p, rel)); }
      const a = rel.assets.find(x => String(x.id) === decodeURIComponent(m[2]));
      if (!a) { res.writeHead(404); return res.end(); }
      if (p.downloads >= CFG.maxDownloads) { res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Limite de downloads atingido. Fale comigo no WhatsApp.'); }
      p.downloads++; await salvar();
      const tipo = a.name.endsWith('.pdf') ? 'application/pdf' : a.name.endsWith('.epub') ? 'application/epub+zip' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': tipo, 'Content-Disposition': `attachment; filename="${a.name}"`, 'Cache-Control': 'private, no-store' });
      if (CFG.mock) return fs.createReadStream(path.join(CFG.pastaMock, a.name)).pipe(res);
      const r = await fetch(`https://api.github.com/repos/${CFG.ghRepo}/releases/assets/${a.id}`, {
        headers: { Authorization: 'Bearer ' + CFG.ghToken, Accept: 'application/octet-stream', 'User-Agent': 'loja-jeff' }, redirect: 'follow',
      });
      if (!r.ok) throw new Error('GitHub asset ' + r.status);
      const { Readable } = require('stream');
      return Readable.fromWeb(r.body).pipe(res);
    }

    json(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    log('ERRO', P, e.message, e.detalhe ? JSON.stringify(e.detalhe).slice(0, 300) : '');
    if (!res.headersSent) json(res, 502, { erro: 'Não consegui gerar o Pix agora. Tente de novo em instantes ou fale comigo no WhatsApp.' });
    else res.end();
  }
});

if (require.main === module) {
  const f = faltando();
  if (f.length && !E.SENHA_SETUP) { console.error('Faltam variáveis no .env:', f.join(', ')); process.exit(1); }
  if (f.length) log('aguardando configuração em ' + CFG.urlPublica + '/configurar (faltando: ' + f.join(', ') + ')');
  servidor.listen(CFG.porta, () => log(`loja no ar na porta ${CFG.porta} (${CFG.mock ? 'MODO TESTE' : 'modo real'}) · ${CFG.urlPublica}`));
}
module.exports = { servidor, cpfValido };
