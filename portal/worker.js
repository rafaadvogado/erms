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
     ORIGENS      – https://rafaelmsouza.adv.br  (separe por vírgula se houver mais de um) */

const TIPOS_AGENDA = ['Audiência', 'Perícia'];
const FONTES_OK = ['DataJud', 'DJEN', 'Recorte', 'PJe'];
const STATUS_FASE = { 'Ativo': 'Em andamento', 'Suspenso': 'Suspenso', 'Arquivado provisoriamente': 'Arquivado provisoriamente' };
const dig = s => String(s || '').replace(/\D/g, '');
const b64 = u => btoa(String.fromCharCode(...new Uint8Array(u)));
const ub = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
let TOKEN = null, DADOS = null;

export default {
  async fetch(req, env, ctx) {
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
      return json({ ok: true, servico: 'ERMS – site' }, 200);
    } catch (e) {
      return json({ erro: e.message || 'erro' }, e.status || 500);
    }
  }
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
  const procs = (d.processos || []).filter(p => vivo(p) && (p.clienteId === c.id || (p.outrosClientes || []).includes(c.id)) && (p.portal || 'Mostrar') !== 'Ocultar' && dig(p.numero).length >= 15)
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
