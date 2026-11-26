/* ERMS – intermediário do site rafaelmsouza.adv.br (Cloudflare Worker)
   Rotas:
     POST /cadastro  – recebe o cadastro do cliente (dados + chave derivada da senha; a senha NÃO vem)
                       e grava um pacote na caixa de entrada do ERMS (Dropbox): cadastro pendente + tarefa.
     GET  /c/<id>    – área do cliente: monta, CRIPTOGRAFA com a chave do cliente e devolve os processos (registra o acesso)
     GET  /v/<id>/<nº> – registra que o cliente abriu um processo
                       dele, lidos do dados.json do ERMS. Só responde para cadastros aprovados no ERMS.
   Variáveis (Settings → Variables and Secrets):
     DBX_REFRESH  (secreta) – token gerado no ERMS em Backup e ajustes → "Chave do site"
     DBX_APP_KEY  – h4lwztmql1yrikv
     ORIGENS      – https://rafaelmsouza.adv.br  (separe por vírgula se houver mais de um)
   Avisos no celular (opcional): KV namespace ligado como PUSH + gatilho Cron a cada 30 minutos.
     GET  /push/chave  – chave pública VAPID      POST /push/assinar – {fid, sub, noticias}      POST /push/sair – {endpoint}
   Acesso restrito da equipe (ERMS pelo site): rotas /acesso/* – veja o bloco "ACESSO RESTRITO" no fim deste arquivo.
     Precisa de um KV namespace ligado como ACESSO (ou usa o mesmo PUSH, se já existir). */

const TIPOS_AGENDA = ['Audiência', 'Perícia'];
const FONTES_OK = ['DataJud', 'DJEN', 'Recorte', 'PJe'];
const STATUS_FASE = { 'Ativo': 'Em andamento', 'Suspenso': 'Suspenso', 'Arquivado provisoriamente': 'Arquivado provisoriamente' };
const dig = s => String(s || '').replace(/\D/g, '');
const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u)));
const ub = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let TOKEN = null, DADOS = null;

export default {
  async fetch(req, env, ctx) {
    const u0 = new URL(req.url);
    if (u0.pathname.startsWith('/acesso/')) return rotaAcesso(req, env, u0, req.headers.get('Origin') || '', ctx);   // equipe (ERMS pelo site)
    const origens = (env.ORIGENS || 'https://rafaelmsouza.adv.br').split(',').map(s => s.trim());
    const origem = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': origens.includes(origem) ? origem : origens[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Vary': 'Origin' };
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      if (req.method === 'POST' && url.pathname === '/cadastro') {
        if (!origens.includes(origem)) return json({ erro: 'origem não permitida' }, 403);
        return json(await cadastro(await req.text(), env, req));
      }
      const m = url.pathname.match(/^\/c\/([0-9a-f]{32})$/);
      if (req.method === 'GET' && m) {
        const r = await areaCliente(m[1], env, req, ctx);
        return r ? json(r) : json({ erro: 'não encontrado' }, 404);
      }
      const v = url.pathname.match(/^\/v\/([0-9a-f]{32})\/(.{1,40})$/);          // cliente abriu um processo
      if (req.method === 'GET' && v) {
        const d = await lerDados(env), c = clientePorChave(d, v[1]);
        if (c && ctx) ctx.waitUntil(registrarAcesso(env, { tipo: 'processo', pid: c.id, nome: c.nome || '', numero: decodeURIComponent(v[2]).slice(0, 30), disp: dispositivo(req) }).catch(() => { }));
        return json({ ok: true });
      }
      // ---- avisos (notificações no celular do cliente) ----
      if (url.pathname.startsWith('/push/')) {
        if (!env.PUSH) return json({ erro: 'avisos ainda não configurados' }, 503);
        if (req.method === 'GET' && url.pathname === '/push/chave') return json({ chave: (await chavesVapid(env)).pub });
        if (req.method === 'POST' && !origens.includes(origem)) return json({ erro: 'origem não permitida' }, 403);
        if (req.method === 'POST' && url.pathname === '/push/assinar') return json(await assinarPush(await req.json(), env));
        if (req.method === 'POST' && url.pathname === '/push/sair') { const b = await req.json(); if (b && b.endpoint) await env.PUSH.delete('sub:' + await sha(b.endpoint)); return json({ ok: true }) }
      }
      return json({ ok: true, servico: 'ERMS – site', avisos: !!env.PUSH }, 200);
    } catch (e) {
      return json({ erro: e.message || 'erro' }, e.status || 500);
    }
  },
  // execução programada (Settings → Triggers → Cron, a cada 30 minutos): manda os avisos
  async scheduled(evento, env, ctx) { if (env.PUSH) ctx.waitUntil(rodarAvisos(env)) }
};

function falha(msg, status = 400) { const e = new Error(msg); e.status = status; return e }

/* ---------- Dropbox ---------- */
async function token(env) {
  if (TOKEN && TOKEN.exp > Date.now()) return TOKEN.v;
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.DBX_REFRESH, client_id: env.DBX_APP_KEY }) });
  const j = await r.json();
  if (!r.ok) throw falha('Dropbox: ' + (j.error_description || r.status), 502);
  TOKEN = { v: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return TOKEN.v;
}
const argHeader = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
async function lerDados(env) {
  if (DADOS && DADOS.t > Date.now() - 30000) return DADOS.d;    // guarda por 30 s
  const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(env), 'Dropbox-API-Arg': argHeader({ path: '/dados.json' }) } });
  if (!r.ok) throw falha('Dropbox: leitura ' + r.status, 502);
  DADOS = { t: Date.now(), d: await r.json() };
  return DADOS.d;
}
async function gravarEntrada(env, nome, obj) {
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(env), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader({ path: '/entrada/' + nome, mode: 'add', autorename: true, mute: true }) }, body: JSON.stringify(obj) });
  if (!r.ok) throw falha('Dropbox: gravação ' + r.status, 502);
}

/* ---------- cadastro ---------- */
const cpfValido = c => { c = dig(c); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false; const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = s * 10 % 11; return r === 10 ? 0 : r }; return dv(9) === +c[9] && dv(10) === +c[10] };
const txt = (v, n) => String(v || '').replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, n);
async function cadastro(corpo, env, req) {
  if (corpo.length > 6000) throw falha('cadastro grande demais', 413);
  let d; try { d = JSON.parse(corpo) } catch (e) { throw falha('dados inválidos') }
  if (d.site) return { ok: true };                                  // robô (campo escondido preenchido)
  if (d.aceite !== true) throw falha('é preciso aceitar a Política de Privacidade');
  if (!cpfValido(d.cpf)) throw falha('CPF inválido');
  if (txt(d.nome, 120).split(/\s+/).length < 2) throw falha('informe o nome completo');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email || '')) throw falha('e-mail inválido');
  if (dig(d.telefone).length < 10 || dig(d.cep).length !== 8) throw falha('confira WhatsApp e CEP');
  if (!/^[0-9a-f]{32}$/.test(d.chave?.id || '') || !/^[A-Za-z0-9+/]{43}=$/.test(d.chave?.k || '')) throw falha('chave inválida');
  const agora = new Date(), iso = agora.toISOString(), hoje = new Date(agora.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  const id = 'pt' + agora.getTime().toString(36) + Math.random().toString(36).slice(2, 6);
  const cpf = dig(d.cpf), cpfF = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
  const reg = {
    id, status: 'Pendente', enviado: iso, ip: (req.headers.get('CF-Connecting-IP') || '').replace(/\.\d+$/, '.x'),
    nome: txt(d.nome, 120), cpf: cpfF, nascimento: txt(d.nascimento, 10), telefone: txt(d.telefone, 20), email: txt(d.email, 120).toLowerCase(),
    cep: txt(d.cep, 9), rua: txt(d.rua, 120), numero: txt(d.numero, 20), complemento: txt(d.complemento, 60), bairro: txt(d.bairro, 80), cidade: txt(d.cidade, 80), uf: txt(d.uf, 2).toUpperCase(),
    estadoCivil: txt(d.estadoCivil, 30), profissao: txt(d.profissao, 80), origem: txt(d.origem, 40),
    chave: { id: d.chave.id, k: d.chave.k }, aceite: { em: iso, texto: 'Li e aceito a Política de Privacidade e autorizo o uso destes dados pelo escritório para o meu atendimento e para a prestação dos serviços advocatícios.' }
  };
  const tarefa = { id: 'tk' + id, tipo: 'Tarefa', data: hoje, titulo: `Verificar cadastro do site: ${reg.nome} (CPF ${cpfF}) – conferir identidade e aprovar`, obs: `Cadastro feito pelo próprio cliente em rafaelmsouza.adv.br. Abra "Cadastros do site" no menu do ERMS para ver os dados e aprovar ou recusar. Confirme pelo WhatsApp ${reg.telefone} que foi o próprio cliente quem se cadastrou.`, portalId: id, feito: false };
  await gravarEntrada(env, `${iso.replace(/[-:T]/g, '').slice(0, 14)}-site-cadastro.json`, { v: 1, criado: iso, fonte: 'Cadastro pelo site', portal: [reg], prazos: [tarefa] });
  return { ok: true };
}

/* ---------- área do cliente ---------- */
const limpa = t => String(t || '').replace(/\s*\((?:[^()]*?)(?:já lançad|confere|conferir|automação)[^()]*\)/gi, '').replace(/\s*–\s*segunda publicação idêntica/g, '').replace(/\s+/g, ' ').trim();
function clientePorChave(d, fid) {
  const exc = d.excluidos || {};
  return (d.pessoas || []).find(p => !exc[p.id] && p.portalChave && p.portalChave.id === fid && p.portalChave.ativo !== false) || null;
}
const dispositivo = req => /Mobi|Android|iPhone|iPad/i.test(req.headers.get('User-Agent') || '') ? 'celular' : 'computador';
/* registro de acessos: /acessos/AAAA-MM.json (lido pelo ERMS em "Acessos dos clientes") */
async function registrarAcesso(env, reg) {
  const br = new Date(Date.now() - 3 * 3600e3).toISOString(), path = `/acessos/${br.slice(0, 7)}.json`;
  reg = { em: new Date().toISOString(), ...reg };
  const auth = 'Bearer ' + await token(env);
  let lista = [];
  const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: auth, 'Dropbox-API-Arg': argHeader({ path }) } });
  if (r.ok) { try { lista = await r.json() } catch (e) { lista = [] } }
  lista.push(reg); if (lista.length > 5000) lista = lista.slice(-5000);
  await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader({ path, mode: 'overwrite', mute: true }) }, body: JSON.stringify(lista) });
}
async function areaCliente(fid, env, req, ctx) {
  const d = await lerDados(env), exc = d.excluidos || {};
  const vivo = x => x && !exc[x.id];
  const c = clientePorChave(d, fid);
  if (!c) return null;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const P = Object.fromEntries((d.pessoas || []).map(p => [p.id, p]));
  const procs = (d.processos || []).filter(p => vivo(p) && (p.clienteId === c.id || (p.outrosClientes || []).includes(c.id) || (p.observadores || []).includes(c.id)) && (p.portal || 'Mostrar') !== 'Ocultar' && dig(p.numero).length >= 15)
    .sort((a, b) => ((['Ativo', 'Suspenso'].includes(a.status || 'Ativo') ? 0 : 1) - (['Ativo', 'Suspenso'].includes(b.status || 'Ativo') ? 0 : 1)) || String(a.numero).localeCompare(String(b.numero)));
  if (ctx && req) ctx.waitUntil(registrarAcesso(env, { tipo: 'entrada', pid: c.id, nome: c.nome || '', proc: procs.filter(p => ['Ativo', 'Suspenso'].includes(p.status || 'Ativo')).length, disp: dispositivo(req) }).catch(() => { }));
  const conteudo = {
    cliente: c.nome || '', atualizado: hoje,
    processos: procs.map(p => {
      const st = p.status || 'Ativo';
      const ands = (d.andamentos || []).filter(a => vivo(a) && a.processoId === p.id && FONTES_OK.some(f => String(a.fonte || 'DataJud').includes(f)))
        .sort((a, b) => String(b.data || '').localeCompare(String(a.data || ''))).slice(0, 15)
        .map(a => ({ data: a.data || '', texto: limpa(a.descricao) })).filter(a => a.texto);
      const agenda = (d.prazos || []).filter(z => vivo(z) && z.processoId === p.id && TIPOS_AGENDA.includes(z.tipo) && !z.feito && (z.data || '') >= hoje)
        .sort((a, b) => String(a.data + (a.hora || '')).localeCompare(String(b.data + (b.hora || ''))))
        .map(z => ({ data: z.data, hora: z.hora || '', tipo: z.tipo, titulo: String(z.titulo || '').replace(/^⚠\s*\S+\s*–\s*/, ''), local: z.local || '' }));
      return { numero: p.numero || '', acao: p.acao || '', area: p.area || '', tribunal: p.tribunal || '', vara: p.vara || '', comarca: p.comarca || '',
        parteContraria: (P[p.contrariaId] || {}).nome || '', ativo: ['Ativo', 'Suspenso'].includes(st),
        situacaoCadastral: STATUS_FASE[st] || (st.startsWith('Encerrado') || ['Arquivado', 'Acordo'].includes(st) ? 'Encerrado' : st),
        resumo: String(p.situacao || '').trim(), andamentos: ands, agenda };
    })
  };
  const chave = await crypto.subtle.importKey('raw', ub(c.portalChave.k), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chave, new TextEncoder().encode(JSON.stringify(conteudo)));
  return { v: 2, iv: b64(iv), c: b64(ct) };
}


/* ====================== AVISOS (Web Push) ======================
   KV "PUSH" (Settings → Bindings → KV namespace, nome da variável: PUSH):
     meta:vapid      – par de chaves VAPID, criado automaticamente na 1ª vez (a privada nunca sai daqui)
     meta:noticias   – data do último resumo semanal de notícias enviado
     sub:<hash>      – {fid, sub, noticias, vistos:[ids], criado} – um por celular
   Texto dos avisos é genérico (sigilo/LGPD): o detalhe só aparece dentro do app, após o login. */
const b64u = u => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64u = s => ub(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const cat = (...a) => { const r = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { r.set(x, o); o += x.length } return r };
const te = s => new TextEncoder().encode(s);
async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', te(s)))].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 40) }
async function hmac(chave, dados) { const k = await crypto.subtle.importKey('raw', chave, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, dados)) }

async function chavesVapid(env) {
  let v = await env.PUSH.get('meta:vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await env.PUSH.put('meta:vapid', JSON.stringify(v));
  }
  return v;
}

/* envia 1 aviso (RFC 8291 aes128gcm + RFC 8292 VAPID); devolve o status HTTP do serviço de push */
async function enviarPush(env, sub, msg) {
  const v = await chavesVapid(env);
  const destino = new URL(sub.endpoint);
  const jwtCab = b64u(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const jwtCorpo = b64u(te(JSON.stringify({ aud: destino.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:rafaelmsouza@adv.oabsp.org.br' })));
  const priv = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const assin = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, te(jwtCab + '.' + jwtCorpo)));
  const jwt = jwtCab + '.' + jwtCorpo + '.' + b64u(assin);
  // criptografia do conteúdo
  const uaPub = ub64u(sub.keys.p256dh), auth = ub64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(auth, segredo);
  const ikm = (await hmac(prkKey, cat(te('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(sal, ikm);
  const cek = (await hmac(prk, cat(te('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const chaveAes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, chaveAes, cat(te(JSON.stringify(msg)), new Uint8Array([2]))));
  const corpo = cat(sal, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, cifrado);
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt}, k=${v.pub}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' }, body: corpo });
  return r.status;
}

/* o que o cliente vê no app: ids dos andamentos e compromissos dos processos dele (mesmas regras da área do cliente) */
function idsDoCliente(d, c) {
  const exc = d.excluidos || {}, vivo = x => x && !exc[x.id], hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const procs = (d.processos || []).filter(p => vivo(p) && (p.clienteId === c.id || (p.outrosClientes || []).includes(c.id) || (p.observadores || []).includes(c.id))
    && (p.portal || 'Mostrar') !== 'Ocultar' && dig(p.numero).length >= 15 && ['Ativo', 'Suspenso'].includes(p.status || 'Ativo'));
  const ps = new Set(procs.map(p => p.id)), ids = [];
  (d.andamentos || []).forEach(a => { if (vivo(a) && ps.has(a.processoId) && FONTES_OK.some(f => String(a.fonte || 'DataJud').includes(f))) ids.push(a.id) });
  (d.prazos || []).forEach(z => { if (vivo(z) && ps.has(z.processoId) && TIPOS_AGENDA.includes(z.tipo) && !z.feito && (z.data || '') >= hoje) ids.push(z.id) });
  return ids;
}

async function assinarPush(b, env) {
  if (!b || !/^[0-9a-f]{32}$/.test(b.fid || '') || !b.sub || !/^https:\/\//.test(b.sub.endpoint || '') || !b.sub.keys?.p256dh || !b.sub.keys?.auth) throw falha('dados inválidos');
  const d = await lerDados(env), c = clientePorChave(d, b.fid);
  if (!c) throw falha('acesso não encontrado', 404);
  const reg = { fid: b.fid, sub: { endpoint: b.sub.endpoint, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth } }, noticias: !!b.noticias, vistos: idsDoCliente(d, c), criado: new Date().toISOString() };
  await env.PUSH.put('sub:' + await sha(reg.sub.endpoint), JSON.stringify(reg));
  return { ok: true };
}

async function rodarAvisos(env) {
  DADOS = null; const d = await lerDados(env);
  const br = new Date(Date.now() - 3 * 3600e3), semana = br.toISOString().slice(0, 10);
  // resumo semanal de notícias: segunda-feira, entre 9h e 10h (horário de Brasília)
  let resumo = null;
  if (br.getUTCDay() === 1 && br.getUTCHours() === 9) {
    const meta = await env.PUSH.get('meta:noticias');
    if (meta !== semana) {
      try {
        const site = (env.ORIGENS || 'https://rafaelmsouza.adv.br').split(',')[0].trim();
        const L = await (await fetch(site + '/noticias.json', { cf: { cacheTtl: 0 } })).json();
        const desde = new Date(br.getTime() - 7 * 864e5).toISOString().slice(0, 10);
        const n = (L || []).filter(x => (x.data || '') > desde).length;
        if (n) resumo = { title: 'Notícias do INSS da semana', body: `${n} ${n === 1 ? 'notícia nova' : 'notícias novas'} no site. Toque para ler.`, url: '/#noticias' };
      } catch (e) { }
      await env.PUSH.put('meta:noticias', semana);
    }
  }
  let cursor;
  do {
    const lista = await env.PUSH.list({ prefix: 'sub:', cursor });
    for (const k of lista.keys) {
      const reg = await env.PUSH.get(k.name, 'json'); if (!reg) continue;
      const c = clientePorChave(d, reg.fid);
      if (!c) { await env.PUSH.delete(k.name); continue }            // acesso bloqueado ou senha trocada
      const ids = idsDoCliente(d, c), vistos = new Set(reg.vistos || []);
      const novos = ids.filter(i => !vistos.has(i));
      let st = 201;
      if (novos.length) st = await enviarPush(env, reg.sub, { title: 'Novidade no seu processo', body: 'Seu processo teve uma atualização. Toque para ver.', url: '/#consulta' }).catch(() => 0);
      if (resumo && reg.noticias && st !== 404 && st !== 410) st = await enviarPush(env, reg.sub, resumo).catch(() => 0);
      if (st === 404 || st === 410) { await env.PUSH.delete(k.name); continue }   // celular desinstalou ou desativou
      if (novos.length) { reg.vistos = ids; await env.PUSH.put(k.name, JSON.stringify(reg)) }
    }
    cursor = lista.list_complete ? null : lista.cursor;
  } while (cursor);
}

/* ================= ACESSO RESTRITO (equipe) =================
   ERMS pelo site, para quem NÃO tem o Dropbox do escritório: CPF + senha + código do app autenticador.
   Usuários: Dropbox /acesso/usuarios.json (criados pelo Dr. Rafael no ERMS em "Usuários e acessos").
   Registro de uso: Dropbox /acesso/registros/AAAA-MM.json.
   Precisa de um KV namespace ligado como ACESSO (ou o mesmo PUSH já existente).
   A senha nunca chega aqui: o navegador deriva uma chave (PBKDF2) e o intermediário guarda só o hash dela.
     POST /acesso/sal      {cpf}                         → sal da senha
     POST /acesso/ativar1  {cpf, convite}                → segredo do autenticador (QR)
     POST /acesso/ativar2  {cpf, convite, chave, codigo} → grava senha + autenticador, devolve a sessão
     POST /acesso/entrar   {cpf, chave, codigo}          → sessão (10 h)
     GET  /acesso/dados                                  → dados filtrados pelas permissões
     POST /acesso/salvar   {mudados:{col:[...]}, excluidos:{id:data}} → grava no dados.json e devolve os dados */
const ORIGENS_ACESSO = ['https://rafaadvogado.github.io'];
const SESSAO_H = 10;
const COLS_EQ = ['pessoas', 'processos', 'andamentos', 'prazos', 'conversas', 'leads', 'honorarios'];
const PROTEGIDOS = { pessoas: ['portalChave', 'senhaPortal', 'senhaInss'], processos: [] };
let USU = null;

async function rotaAcesso(req, env, url, origem, ctx) {
  const ok = [...ORIGENS_ACESSO, ...(env.ORIGENS || 'https://rafaelmsouza.adv.br').split(',').map(s => s.trim())];
  const cors = { 'Access-Control-Allow-Origin': ok.includes(origem) ? origem : ORIGENS_ACESSO[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    const KV = env.ACESSO || env.PUSH;
    if (!KV) return json({ erro: 'Acesso restrito ainda não configurado no intermediário (falta ligar o KV "ACESSO").' }, 503);
    if (req.method === 'POST' && !ok.includes(origem)) return json({ erro: 'origem não permitida' }, 403);
    const rota = url.pathname.slice(8), ip = req.headers.get('CF-Connecting-IP') || '';
    const ctxA = { env, KV, ip, req, ctx };
    if (req.method === 'POST' && rota === 'sal') return json(await acSal(await corpoJson(req), ctxA));
    if (req.method === 'POST' && rota === 'ativar1') return json(await acAtivar1(await corpoJson(req), ctxA));
    if (req.method === 'POST' && rota === 'ativar2') return json(await acAtivar2(await corpoJson(req), ctxA));
    if (req.method === 'POST' && rota === 'entrar') return json(await acEntrar(await corpoJson(req), ctxA));
    if (rota === 'dados' || rota === 'salvar') {
      const u = await acSessao(req, ctxA);
      if (req.method === 'GET' && rota === 'dados') { const d = await lerDadosRev(env); return json({ db: escopoDb(d.d, u), usuario: pubUsuario(u), em: new Date().toISOString() }) }
      if (req.method === 'POST' && rota === 'salvar') return json(await acSalvar(await corpoJson(req, 3e6), u, ctxA));
    }
    return json({ erro: 'rota desconhecida' }, 404);
  } catch (e) {
    return json({ erro: e.message || 'erro' }, e.status || 500);
  }
}
async function corpoJson(req, max = 4000) {
  const t = await req.text();
  if (t.length > max) throw falha('pedido grande demais', 413);
  try { return JSON.parse(t) || {} } catch (e) { throw falha('dados inválidos') }
}

/* ---------- utilidades ---------- */
const hex = u => [...new Uint8Array(u)].map(x => x.toString(16).padStart(2, '0')).join('');
async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? te(s) : s)) }
function igual(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0 }
async function segredo(c) {
  if (c.env.ACESSO_SEGREDO) return ub(c.env.ACESSO_SEGREDO);
  let s = await c.KV.get('acesso:segredo');
  if (!s) { s = b64(crypto.getRandomValues(new Uint8Array(32))); await c.KV.put('acesso:segredo', s) }
  return ub(s);
}
async function chaveAes(c) { const k = await hmac(await segredo(c), te('totp-aes')); return crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt']) }
async function cifrar(c, texto) { const iv = crypto.getRandomValues(new Uint8Array(12)); const x = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await chaveAes(c), te(texto)); return b64(iv) + '.' + b64(x) }
async function decifrar(c, s) { const [iv, x] = String(s).split('.'); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub(iv) }, await chaveAes(c), ub(x))) }
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32(u) { let bits = 0, v = 0, o = ''; for (const x of u) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5 } } if (bits > 0) o += B32[(v << (5 - bits)) & 31]; return o }
function ub32(s) { s = String(s).toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = 0, v = 0; const o = []; for (const ch of s) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8 } } return new Uint8Array(o) }
async function totpEm(seg, passo) {
  const m = new Uint8Array(8); let n = passo; for (let i = 7; i >= 0; i--) { m[i] = n & 255; n = Math.floor(n / 256) }
  const k = await crypto.subtle.importKey('raw', ub32(seg), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, m)), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}
/* confere o código (aceita 30 s antes/depois); devolve o passo usado ou -1 */
async function totpConfere(seg, codigo) {
  codigo = dig(codigo); if (codigo.length !== 6) return -1;
  const p = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) if (igual(await totpEm(seg, p + d), codigo)) return p + d;
  return -1;
}
/* limite de tentativas: 5 erros por CPF e 20 por IP a cada 15 min */
async function bloqueado(c, cpf) {
  const [a, b] = await Promise.all([c.KV.get('tent:' + cpf), c.KV.get('tentip:' + c.ip)]);
  if (+(a || 0) >= 5 || +(b || 0) >= 20) throw falha('Muitas tentativas. Aguarde 15 minutos e tente de novo.', 429);
}
async function errou(c, cpf) {
  const [a, b] = await Promise.all([c.KV.get('tent:' + cpf), c.KV.get('tentip:' + c.ip)]);
  await Promise.all([c.KV.put('tent:' + cpf, String(+(a || 0) + 1), { expirationTtl: 900 }), c.KV.put('tentip:' + c.ip, String(+(b || 0) + 1), { expirationTtl: 900 })]);
}

/* ---------- Dropbox: arquivos com controle de versão ---------- */
async function dbxLer(env, path) {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(env), 'Dropbox-API-Arg': argHeader({ path }) } });
  if (r.status === 409) return null;
  if (!r.ok) throw falha('Dropbox: leitura ' + r.status, 502);
  const meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}');
  return { texto: await r.text(), rev: meta.rev };
}
async function dbxGravar(env, path, texto, rev) {
  const modo = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + await token(env), 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': argHeader({ path, mode: modo, autorename: false, mute: true }) }, body: texto });
  if (r.status === 409) return null;                      // outra pessoa gravou antes: ler de novo
  if (!r.ok) throw falha('Dropbox: gravação ' + r.status, 502);
  return (await r.json()).rev;
}
async function lerDadosRev(env) {
  const f = await dbxLer(env, '/dados.json');
  if (!f) throw falha('dados do escritório não encontrados', 502);
  const d = JSON.parse(f.texto);
  DADOS = { t: Date.now(), d };
  return { d, rev: f.rev };
}
async function lerUsuarios(env, fresco) {
  if (!fresco && USU && USU.t > Date.now() - 15000) return USU;
  const f = await dbxLer(env, '/acesso/usuarios.json');
  const j = f ? JSON.parse(f.texto) : { usuarios: [] };
  j.usuarios = Array.isArray(j.usuarios) ? j.usuarios : [];
  USU = { t: Date.now(), j, rev: f && f.rev };
  return USU;
}
/* altera um usuário com segurança (relê se outra pessoa gravou no meio) */
async function alterarUsuario(env, id, fn) {
  for (let i = 0; i < 4; i++) {
    const U = await lerUsuarios(env, true), u = U.j.usuarios.find(x => x.id === id);
    if (!u) throw falha('usuário não encontrado', 404);
    fn(u);
    const rev = await dbxGravar(env, '/acesso/usuarios.json', JSON.stringify(U.j, null, 1), U.rev);
    if (rev) { USU = { t: Date.now(), j: U.j, rev }; return u }
  }
  throw falha('não foi possível gravar agora; tente de novo', 503);
}
async function registrar(c, u, acao, det) {
  const br = new Date(Date.now() - 3 * 3600e3).toISOString(), path = `/acesso/registros/${br.slice(0, 7)}.json`;
  const reg = { em: new Date().toISOString(), u: u ? u.id : '', nome: u ? u.nome : '', acao, det: det || '', disp: dispositivo(c.req), ip: c.ip.replace(/[.:][0-9a-f]+$/i, '.x') };
  for (let i = 0; i < 3; i++) {
    const f = await dbxLer(c.env, path);
    let L = []; if (f) { try { L = JSON.parse(f.texto) } catch (e) { L = [] } }
    L.push(reg); if (L.length > 8000) L = L.slice(-8000);
    if (await dbxGravar(c.env, path, JSON.stringify(L), f && f.rev)) return;
  }
}
const depois = (c, p) => { const q = Promise.resolve(p).catch(() => { }); if (c.ctx) c.ctx.waitUntil(q); return q };

/* ---------- usuários ---------- */
async function acharUsuario(c, cpf) {
  cpf = dig(cpf); if (!cpfValido(cpf)) throw falha('CPF inválido');
  const U = await lerUsuarios(c.env);
  return U.j.usuarios.find(x => dig(x.cpf) === cpf) || null;
}
const pubUsuario = u => ({ id: u.id, nome: u.nome, perfil: u.perfil || 'restrito', honorarios: !!u.honorarios, leads: !!u.leads, excluir: u.perfil === 'total' });
async function salFalso(c, cpf) { return b64u((await hmac(await segredo(c), te('sal:' + cpf))).slice(0, 16)) }
async function acSal(b, c) {
  const cpf = dig(b.cpf), u = await acharUsuario(c, cpf);
  return { sal: u && u.sal && u.ativo !== false ? u.sal : await salFalso(c, cpf) };
}
async function conviteOk(c, u, convite) {
  if (!u || u.ativo === false || !u.convite || !u.convite.hash) return false;
  if (u.convite.exp && u.convite.exp < new Date().toISOString()) return false;
  return igual(u.convite.hash, await sha256hex(String(convite || '').toUpperCase().replace(/[^A-Z0-9]/g, '')));
}
async function acAtivar1(b, c) {
  const cpf = dig(b.cpf); await bloqueado(c, cpf);
  const u = await acharUsuario(c, cpf);
  if (!(await conviteOk(c, u, b.convite))) { await errou(c, cpf); throw falha('CPF ou código de convite não conferem (ou o convite venceu).', 401) }
  const seg = b32(crypto.getRandomValues(new Uint8Array(20))), sal = b64u(crypto.getRandomValues(new Uint8Array(16)));
  await c.KV.put('pend:' + u.id, JSON.stringify({ seg, sal }), { expirationTtl: 1800 });
  const rot = encodeURIComponent('ERMS:' + u.nome.split(' ')[0] + ' ' + cpf.slice(-4));
  return { sal, segredo: seg, otpauth: `otpauth://totp/${rot}?secret=${seg}&issuer=ERMS&algorithm=SHA1&digits=6&period=30`, nome: u.nome };
}
async function acAtivar2(b, c) {
  const cpf = dig(b.cpf); await bloqueado(c, cpf);
  const u = await acharUsuario(c, cpf);
  if (!(await conviteOk(c, u, b.convite))) { await errou(c, cpf); throw falha('CPF ou código de convite não conferem (ou o convite venceu).', 401) }
  const pend = JSON.parse(await c.KV.get('pend:' + u.id) || 'null');
  if (!pend) throw falha('O tempo para concluir passou. Comece o primeiro acesso de novo.', 410);
  if (!/^[A-Za-z0-9_-]{43}$/.test(b.chave || '')) throw falha('senha inválida');
  const passo = await totpConfere(pend.seg, b.codigo);
  if (passo < 0) { await errou(c, cpf); throw falha('Código do autenticador não confere. Confira a hora do celular e use o código que está aparecendo agora.', 401) }
  const chaveHash = await sha256hex(b.chave), totp = { c: await cifrar(c, pend.seg), ult: passo };
  const novo = await alterarUsuario(c.env, u.id, x => { x.sal = pend.sal; x.chaveHash = chaveHash; x.totp = totp; x.convite = null; x.ver = (x.ver || 0) + 1; x.ativadoEm = new Date().toISOString() });
  await c.KV.delete('pend:' + u.id);
  depois(c, registrar(c, novo, 'primeiro acesso', 'senha e autenticador cadastrados'));
  return { token: await emitirSessao(c, novo), usuario: pubUsuario(novo) };
}
async function acEntrar(b, c) {
  const cpf = dig(b.cpf); await bloqueado(c, cpf);
  const u = await acharUsuario(c, cpf);
  const falhou = async (msg = 'CPF, senha ou código não conferem.') => { await errou(c, cpf); if (u) depois(c, registrar(c, u, 'tentativa recusada', msg)); throw falha(msg, 401) };
  if (!u || u.ativo === false || !u.chaveHash || !u.totp) { await sha256hex(String(b.chave || '')); return falhou() }
  if (!igual(u.chaveHash, await sha256hex(String(b.chave || '')))) return falhou();
  let seg; try { seg = await decifrar(c, u.totp.c) } catch (e) { return falhou('Autenticador precisa ser cadastrado de novo. Peça ao Dr. Rafael um novo convite.') }
  const passo = await totpConfere(seg, b.codigo);
  if (passo < 0) return falhou();
  const ult = +(await c.KV.get('totp:' + u.id) || u.totp.ult || 0);
  if (passo <= ult) return falhou('Este código já foi usado. Aguarde o próximo código do autenticador.');
  await c.KV.put('totp:' + u.id, String(passo), { expirationTtl: 3600 });
  await c.KV.delete('tent:' + cpf);
  depois(c, registrar(c, u, 'entrou'));
  return { token: await emitirSessao(c, u), usuario: pubUsuario(u) };
}
async function emitirSessao(c, u) {
  const p = b64u(te(JSON.stringify({ u: u.id, v: u.ver || 0, exp: Date.now() + SESSAO_H * 3600e3 })));
  return p + '.' + b64u(await hmac(await segredo(c), te('sessao.' + p)));
}
async function acSessao(req, c) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const [p, s] = t.split('.');
  const sair = () => { throw falha('Sessão encerrada. Entre de novo.', 401) };
  if (!p || !s || !igual(s, b64u(await hmac(await segredo(c), te('sessao.' + p))))) sair();
  let o; try { o = JSON.parse(new TextDecoder().decode(ub64u(p))) } catch (e) { sair() }
  if (!o.exp || o.exp < Date.now()) sair();
  const U = await lerUsuarios(c.env), u = U.j.usuarios.find(x => x.id === o.u);
  if (!u || u.ativo === false || (u.ver || 0) !== o.v) sair();
  return u;
}

/* ---------- o que cada usuário enxerga ---------- */
function alcance(d, u) {
  const exc = d.excluidos || {}, vivo = x => x && x.id && !exc[x.id];
  const total = u.perfil === 'total';
  const cols = { pessoas: 1, processos: 1, andamentos: 1, prazos: 1, conversas: 1, leads: !!u.leads, honorarios: !!u.honorarios };
  if (total) return { total, cols, vivo, ve: () => true };
  const extra = new Set(u.processos || []), resp = String(u.responsavel || '').trim();
  const procs = new Set((d.processos || []).filter(p => vivo(p) && ((resp && p.responsavel === resp) || extra.has(p.id) || p.criadoPor === u.id)).map(p => p.id));
  const clientes = new Set(), pessoas = new Set();
  (d.processos || []).forEach(p => {
    if (!procs.has(p.id)) return;
    [p.clienteId, ...(p.outrosClientes || [])].forEach(x => { if (x) { clientes.add(x); pessoas.add(x) } });
    [p.contrariaId, ...(p.observadores || [])].forEach(x => x && pessoas.add(x));
  });
  (d.pessoas || []).forEach(p => { if (p.criadoPor === u.id) { pessoas.add(p.id); clientes.add(p.id) } });
  const ve = (col, r) => {
    if (r.criadoPor === u.id) return true;
    if (col === 'processos') return procs.has(r.id);
    if (col === 'pessoas') return pessoas.has(r.id);
    if (col === 'leads') return true;
    if (r.processoId) return procs.has(r.processoId);
    if (r.pessoaId) return clientes.has(r.pessoaId);
    if (col === 'conversas' && r.leadId) return !!u.leads;
    return false;
  };
  return { total, cols, vivo, ve, procs, pessoas };
}
function limparRegistro(col, r) {
  const x = { ...r };
  (PROTEGIDOS[col] || []).forEach(k => delete x[k]);
  return x;
}
function escopoDb(d, u) {
  const A = alcance(d, u), r = { excluidos: {}, config: { seedVer: (d.config || {}).seedVer || 99, criado: (d.config || {}).criado || '' } };
  COLS_EQ.forEach(c => { r[c] = A.cols[c] ? (d[c] || []).filter(x => A.vivo(x) && A.ve(c, x)).map(x => limparRegistro(c, x)) : [] });
  r.portal = [];
  return r;
}

/* ---------- gravação ---------- */
async function acSalvar(b, u, c) {
  const mud = b.mudados || {}, exc = b.excluidos || {};
  let n = 0, rec = 0, apag = 0;
  for (let tent = 0; tent < 4; tent++) {
    const { d, rev } = await lerDadosRev(c.env);
    COLS_EQ.forEach(col => d[col] = Array.isArray(d[col]) ? d[col] : []);
    d.excluidos = d.excluidos || {};
    const A = alcance(d, u), agora = new Date().toISOString();
    n = 0; rec = 0; apag = 0;
    const novosProc = new Set();
    // primeiro os processos novos (para andamentos/prazos do mesmo envio poderem se ligar a eles)
    const ordem = ['pessoas', 'processos', 'andamentos', 'prazos', 'conversas', 'leads', 'honorarios'];
    for (const col of ordem) {
      const lista = Array.isArray(mud[col]) ? mud[col] : [];
      if (!lista.length) continue;
      if (!A.cols[col]) { rec += lista.length; continue }
      const idx = new Map(d[col].map((x, i) => [x.id, i]));
      for (const x0 of lista) {
        if (!x0 || typeof x0 !== 'object' || !/^[A-Za-z0-9_.:-]{1,60}$/.test(String(x0.id || ''))) { rec++; continue }
        const i = idx.get(x0.id), atual = i === undefined ? null : d[col][i];
        if (d.excluidos[x0.id]) { rec++; continue }
        const x = { ...x0 }; delete x._m; delete x._por;
        (PROTEGIDOS[col] || []).forEach(k => delete x[k]);
        if (atual) {
          if (!A.ve(col, atual)) { rec++; continue }
          (PROTEGIDOS[col] || []).forEach(k => { if (k in atual) x[k] = atual[k] });
          if (!A.total && col === 'processos') x.responsavel = atual.responsavel;
          if (atual.criadoPor) x.criadoPor = atual.criadoPor; else delete x.criadoPor;
          if (!A.total && x.processoId !== atual.processoId && x.processoId && !A.procs.has(x.processoId) && !novosProc.has(x.processoId)) x.processoId = atual.processoId;
          d[col][i] = { ...x, _m: agora, _por: u.nome };
        } else {
          if (!A.total) {
            if (col === 'processos') { if (u.responsavel) x.responsavel = u.responsavel; novosProc.add(x.id) }
            if (x.processoId && !A.procs.has(x.processoId) && !novosProc.has(x.processoId)) { rec++; continue }
          }
          x.criadoPor = u.id;
          d[col].push({ ...x, criado: x.criado || agora, _m: agora, _por: u.nome });
          idx.set(x.id, d[col].length - 1);
          if (col === 'processos') A.procs && A.procs.add(x.id);
        }
        n++;
      }
    }
    for (const [id, t] of Object.entries(exc)) {
      for (const col of COLS_EQ) {
        const i = d[col].findIndex(x => x.id === id); if (i < 0) continue;
        const r = d[col][i];
        if (!A.cols[col] || !A.ve(col, r) || !(A.total || r.criadoPor === u.id)) { rec++; break }
        d[col].splice(i, 1); d.excluidos[id] = agora; apag++; break;
      }
    }
    if (!n && !apag) return { db: escopoDb(d, u), gravados: 0, recusados: rec };
    d.config = d.config || {}; d.config.alterado = agora;
    const texto = JSON.stringify(d);
    if (texto.length < 1000) throw falha('gravação recusada (dados vazios)', 500);
    const novoRev = await dbxGravar(c.env, '/dados.json', texto, rev);
    if (!novoRev) continue;                                // conflito: alguém gravou antes — refaz
    DADOS = { t: Date.now(), d };
    depois(c, registrar(c, u, 'alterou', `${n} registro(s)${apag ? `, ${apag} excluído(s)` : ''}`));
    return { db: escopoDb(d, u), gravados: n, excluidos: apag, recusados: rec };
  }
  throw falha('O sistema está ocupado gravando outra alteração. Tente de novo em instantes.', 503);
}
