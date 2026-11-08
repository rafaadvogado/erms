#!/usr/bin/env python3
"""Gera os arquivos CRIPTOGRAFADOS do portal do cliente (rafaelmsouza.adv.br) a partir do dados.json do ERMS.

Uso: python3 portal_gerar.py DADOS.json PASTA_SAIDA [--entrada PASTA_ENTRADA]

Para cada processo (exceto os marcados "Ocultar" no campo Portal do cliente) cujo cliente tem CPF/CNPJ,
gera PASTA_SAIDA/d/<id>.json, legível só com: número do processo + CPF + senha do portal (padrão 1988).
  id   = PBKDF2-SHA256(material, "erms-portal-id-v1", 200000) -> 16 bytes hex
  chave= PBKDF2-SHA256(material, sal aleatório, 200000) -> AES-256-GCM
  material = "<só dígitos do processo>|<só dígitos do CPF>|<senha>"
Nada legível sai deste script: nomes, números e andamentos ficam todos dentro do conteúdo cifrado.
"""
import base64, datetime, glob, hashlib, json, os, re, shutil, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITER = 200000
SENHA_PADRAO = '1988'
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


def gerar(d, saida):
    hoje = datetime.date.today().isoformat()
    P = {p['id']: p for p in d['pessoas']}
    and_por = {}
    for a in d['andamentos']:
        and_por.setdefault(a.get('processoId'), []).append(a)
    agenda_por = {}
    for z in d['prazos']:
        if z.get('processoId') and z.get('tipo') in TIPOS_AGENDA and not z.get('feito') and (z.get('data') or '') >= hoje:
            agenda_por.setdefault(z['processoId'], []).append(z)
    pasta = os.path.join(saida, 'd')
    if os.path.isdir(pasta):
        shutil.rmtree(pasta)
    os.makedirs(pasta)
    res = {'gerados': 0, 'sem_cpf': [], 'ocultos': 0, 'sem_numero': 0}
    for p in d['processos']:
        if (p.get('portal') or 'Mostrar') == 'Ocultar':
            res['ocultos'] += 1
            continue
        num = dig(p.get('numero'))
        if len(num) < 15:
            res['sem_numero'] += 1
            continue
        c = P.get(p.get('clienteId')) or {}
        doc = dig(c.get('doc'))
        if len(doc) not in (11, 14):
            if (p.get('status') or 'Ativo') in ('Ativo', 'Suspenso'):
                res['sem_cpf'].append(c.get('nome') or '?')
            continue
        senha = str(c.get('senhaPortal') or '').strip() or SENHA_PADRAO
        st = p.get('status') or 'Ativo'
        ands = sorted([a for a in and_por.get(p['id'], []) if any(f in str(a.get('fonte') or 'DataJud') for f in FONTES_OK)],
                      key=lambda a: a.get('data') or '', reverse=True)[:15]
        conteudo = {
            'cliente': c.get('nome', ''), 'numero': p.get('numero', ''), 'acao': p.get('acao', ''), 'area': p.get('area', ''),
            'tribunal': p.get('tribunal', ''), 'vara': p.get('vara', ''), 'comarca': p.get('comarca', ''),
            'parteContraria': (P.get(p.get('contrariaId')) or {}).get('nome', ''),
            'ativo': st in ('Ativo', 'Suspenso'), 'situacaoCadastral': STATUS_FASE.get(st, 'Encerrado' if st.startswith('Encerrado') or st in ('Arquivado', 'Acordo') else st),
            'resumo': (p.get('situacao') or '').strip(),
            'andamentos': [{'data': a.get('data', ''), 'texto': limpa_andamento(a.get('descricao'))} for a in ands if limpa_andamento(a.get('descricao'))],
            'agenda': [{'data': z.get('data', ''), 'hora': z.get('hora', ''), 'tipo': z.get('tipo', ''), 'titulo': re.sub(r'^⚠\s*\w+\s*–\s*', '', z.get('titulo', '')), 'local': z.get('local', '')}
                       for z in sorted(agenda_por.get(p['id'], []), key=lambda z: (z.get('data') or '', z.get('hora') or ''))],
            'atualizado': hoje,
        }
        material = f'{num}|{doc}|{senha}'
        fid = pbkdf2(material, b'erms-portal-id-v1', 16).hex()
        sal, iv = os.urandom(16), os.urandom(12)
        ct = AESGCM(pbkdf2(material, sal, 32)).encrypt(iv, json.dumps(conteudo, ensure_ascii=False).encode('utf-8'), None)
        json.dump({'v': 1, 's': b64(sal), 'iv': b64(iv), 'c': b64(ct)}, open(os.path.join(pasta, fid + '.json'), 'w'))
        res['gerados'] += 1
    json.dump({'atualizado': datetime.datetime.now().strftime('%Y-%m-%dT%H:%M')}, open(os.path.join(saida, 'atualizado.json'), 'w'))
    return res


if __name__ == '__main__':
    args = sys.argv[1:]
    ent = None
    if '--entrada' in args:
        i = args.index('--entrada'); ent = args[i + 1]; del args[i:i + 2]
    r = gerar(carregar(args[0], ent), args[1])
    r['sem_cpf'] = sorted(set(r['sem_cpf']))
    print(json.dumps(r, ensure_ascii=False, indent=1))
