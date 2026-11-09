#!/usr/bin/env python3
"""Gera os arquivos CRIPTOGRAFADOS do portal do cliente (rafaelmsouza.adv.br) a partir do dados.json do ERMS.

Uso: python3 portal_gerar.py DADOS.json PASTA_SAIDA [--entrada PASTA_ENTRADA]

Gera PASTA_SAIDA/c/<id>.json: UM arquivo por cliente, com todos os processos dele (exceto os marcados
"Ocultar" no campo Portal do cliente), legível só com CPF + senha do cliente.
  material = "<só dígitos do CPF>|<senha>"
  id    = PBKDF2-SHA256(material, "erms-portal-cli-v2", 200000) -> 16 bytes hex
  chave = PBKDF2-SHA256(material, "erms-portal-key-v2", 200000) -> AES-256-GCM
A senha vem de: (1) cadastro feito pelo cliente no site e APROVADO no ERMS (pessoa.portalChave = {id, k},
derivados no navegador do cliente — o ERMS nunca recebe a senha), ou (2) senha gerada no ERMS (pessoa.senhaPortal).
Cliente sem uma das duas não tem acesso. Remove a pasta antiga d/ (versão 1).
Nada legível sai deste script: nomes, números e andamentos ficam todos dentro do conteúdo cifrado.
"""
import base64, datetime, glob, hashlib, json, os, re, shutil, sys

def agora_br():
    """Horário de Brasília (UTC-3), independente do fuso da máquina."""
    return datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=3)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITER = 200000
FONTES_OK = ('DataJud', 'DJEN', 'Recorte', 'PJe')     # andamentos internos ("Lançamento manual") não vão ao portal
TIPOS_AGENDA = ('Audiência', 'Perícia')               # só compromissos que envolvem o cliente
STATUS_FASE = {'Ativo': 'Em andamento', 'Suspenso': 'Suspenso', 'Arquivado provisoriamente': 'Arquivado provisoriamente'}

dig = lambda s: re.sub(r'\D', '', str(s or ''))
b64 = lambda b: base64.b64encode(b).decode()


def pbkdf2(material, sal, n):
    return hashlib.pbkdf2_hmac('sha256', material.encode('utf-8'), sal, ITER, n)


def limpa_andamento(t):
    t = re.sub(r'\s*\((?:[^()]*?)(?:já lançad|confere|conferir|automação)[^()]*\)', '', str(t or ''), flags=re.I)
    t = re.sub(r'\s*–\s*segunda publicação idêntica', '', t)
    return re.sub(r'\s+', ' ', t).strip()


def carregar(dados_path, entrada=None):
    d = json.load(open(dados_path, encoding='utf-8'))
    # pacotes ainda não aplicados pelo app (caixa de entrada): só acrescenta registros novos
    if entrada:
        apl = set((d.get('config') or {}).get('pacotesAplicados') or [])
        for f in sorted(glob.glob(os.path.join(entrada, '*.json'))):
            if os.path.basename(f) in apl:
                continue
            try:
                A = json.load(open(f, encoding='utf-8'))
            except Exception:
                continue
            for c in ('pessoas', 'processos', 'andamentos', 'prazos'):
                ids = {x['id'] for x in d.get(c, [])}
                d.setdefault(c, []).extend(x for x in A.get(c, []) if x.get('id') not in ids and x.get('id') not in (d.get('excluidos') or {}))
            for k, s in (A.get('situacao') or {}).items():
                for p in d['processos']:
                    if p['id'] == k:
                        p['situacao'] = s
    exc = d.get('excluidos') or {}
    for c in ('pessoas', 'processos', 'andamentos', 'prazos'):
        d[c] = [x for x in d.get(c, []) if x.get('id') not in exc]
    return d


def chave_cliente(c):
    """(id_hex, chave_bytes) do cliente: cadastro aprovado no site (portalChave) ou senha gerada no ERMS (senhaPortal)."""
    pc = c.get('portalChave') or {}
    if pc.get('ativo') is False:
        return None, None
    if pc.get('id') and pc.get('k'):
        return pc['id'], base64.b64decode(pc['k'])
    senha = str(c.get('senhaPortal') or '').strip()
    doc = dig(c.get('doc'))
    if not senha or len(doc) not in (11, 14):
        return None, None
    material = f'{doc}|{senha}'
    return pbkdf2(material, b'erms-portal-cli-v2', 16).hex(), pbkdf2(material, b'erms-portal-key-v2', 32)


def conteudo_processo(p, d, P, and_por, agenda_por):
    st = p.get('status') or 'Ativo'
    ands = sorted([a for a in and_por.get(p['id'], []) if any(f in str(a.get('fonte') or 'DataJud') for f in FONTES_OK)],
                  key=lambda a: a.get('data') or '', reverse=True)[:15]
    return {
        'numero': p.get('numero', ''), 'acao': p.get('acao', ''), 'area': p.get('area', ''),
        'tribunal': p.get('tribunal', ''), 'vara': p.get('vara', ''), 'comarca': p.get('comarca', ''),
        'parteContraria': (P.get(p.get('contrariaId')) or {}).get('nome', ''),
        'ativo': st in ('Ativo', 'Suspenso'), 'situacaoCadastral': STATUS_FASE.get(st, 'Encerrado' if st.startswith('Encerrado') or st in ('Arquivado', 'Acordo') else st),
        'resumo': (p.get('situacao') or '').strip(),
        'andamentos': [{'data': a.get('data', ''), 'texto': limpa_andamento(a.get('descricao'))} for a in ands if limpa_andamento(a.get('descricao'))],
        'agenda': [{'data': z.get('data', ''), 'hora': z.get('hora', ''), 'tipo': z.get('tipo', ''), 'titulo': re.sub(r'^⚠\s*\w+\s*–\s*', '', z.get('titulo', '')), 'local': z.get('local', '')}
                   for z in sorted(agenda_por.get(p['id'], []), key=lambda z: (z.get('data') or '', z.get('hora') or ''))],
    }


def gerar(d, saida):
    hoje = agora_br().date().isoformat()
    P = {p['id']: p for p in d['pessoas']}
    and_por, agenda_por, proc_por = {}, {}, {}
    for a in d['andamentos']:
        and_por.setdefault(a.get('processoId'), []).append(a)
    for z in d['prazos']:
        if z.get('processoId') and z.get('tipo') in TIPOS_AGENDA and not z.get('feito') and (z.get('data') or '') >= hoje:
            agenda_por.setdefault(z['processoId'], []).append(z)
    for p in d['processos']:
        if (p.get('portal') or 'Mostrar') != 'Ocultar' and len(dig(p.get('numero'))) >= 15:
            for cid in dict.fromkeys([p.get('clienteId')] + list(p.get('outrosClientes') or [])):
                proc_por.setdefault(cid, []).append(p)
    for velha in ('d', 'c'):
        if os.path.isdir(os.path.join(saida, velha)):
            shutil.rmtree(os.path.join(saida, velha))
    pasta = os.path.join(saida, 'c')
    os.makedirs(pasta)
    res = {'clientes_com_acesso': 0, 'processos_disponiveis': 0, 'sem_senha': [], 'sem_cpf': []}
    for cid, procs in proc_por.items():
        c = P.get(cid) or {}
        ativos = [p for p in procs if (p.get('status') or 'Ativo') in ('Ativo', 'Suspenso')]
        fid, k = chave_cliente(c)
        if not fid:
            if ativos:
                (res['sem_cpf'] if len(dig(c.get('doc'))) not in (11, 14) else res['sem_senha']).append(c.get('nome') or '?')
            continue
        procs = sorted(procs, key=lambda p: (0 if (p.get('status') or 'Ativo') in ('Ativo', 'Suspenso') else 1, p.get('numero') or ''))
        conteudo = {'cliente': c.get('nome', ''), 'atualizado': hoje,
                    'processos': [conteudo_processo(p, d, P, and_por, agenda_por) for p in procs]}
        iv = os.urandom(12)
        ct = AESGCM(k).encrypt(iv, json.dumps(conteudo, ensure_ascii=False).encode('utf-8'), None)
        json.dump({'v': 2, 'iv': b64(iv), 'c': b64(ct)}, open(os.path.join(pasta, fid + '.json'), 'w'))
        res['clientes_com_acesso'] += 1
        res['processos_disponiveis'] += len(procs)
    open(os.path.join(pasta, '.keep'), 'w').close()
    json.dump({'atualizado': agora_br().strftime('%Y-%m-%dT%H:%M')}, open(os.path.join(saida, 'atualizado.json'), 'w'))
    return res


if __name__ == '__main__':
    args = sys.argv[1:]
    ent = None
    if '--entrada' in args:
        i = args.index('--entrada'); ent = args[i + 1]; del args[i:i + 2]
    r = gerar(carregar(args[0], ent), args[1])
    r['sem_cpf'] = sorted(set(r['sem_cpf'])); r['sem_senha'] = sorted(set(r['sem_senha']))
    print(json.dumps(r, ensure_ascii=False, indent=1))
