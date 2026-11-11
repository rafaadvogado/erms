#!/usr/bin/env python3
"""Gera as imagens de Instagram (feed 1080x1350 e story 1080x1920) na identidade visual do Rafael de Mello Souza.

Uso: python3 gerar_post.py POST.json PASTA_SAIDA
POST.json: {"etiqueta": "INSS · Notícia", "titulo": "...", "pontos": ["...", "..."], "data": "AAAA-MM-DD"}
  - titulo: até ~70 caracteres; pontos: 2 a 4 frases curtas (até ~110 caracteres cada).
Saída: PASTA_SAIDA/feed.png, PASTA_SAIDA/story.png e o CARROSSEL PASTA_SAIDA/carrossel-1.png … carrossel-N.png (1080x1350)
  - opcional "slides": [{"titulo": "...", "texto": "..."}] para o miolo do carrossel (senão usa os pontos, um por slide).
Requer Google Chrome/Chromium (headless). Fontes: Cormorant Garamond e Inter (licença OFL), embutidas.
"""
import base64, html, json, os, shutil, subprocess, sys, tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
b64 = lambda p: base64.b64encode(open(os.path.join(AQUI, p), 'rb').read()).decode()


def chrome():
    for c in ('google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable'):
        if shutil.which(c):
            return shutil.which(c)
    raise SystemExit('Chrome/Chromium não encontrado')


def montar(post, alt):
    e = html.escape
    fontes = ''.join(f"@font-face{{font-family:'{f}';font-weight:{w};src:url(data:font/woff2;base64,{b64('fonts/' + a)}) format('woff2')}}"
                     for f, w, a in [('S', 600, 'serif-600.woff2'), ('S', 700, 'serif-700.woff2'), ('I', 400, 'inter-400.woff2'), ('I', 600, 'inter-600.woff2'), ('I', 700, 'inter-700.woff2')])
    d = post.get('data', '')
    data = f'{d[8:10]}/{d[5:7]}/{d[0:4]}' if len(d) == 10 else ''
    story = alt == 1920
    tit = len(post['titulo'])
    tam = (96 if tit < 40 else 84 if tit < 60 else 74) + (8 if story else 0)
    pontos = ''.join(f'<li>{e(p)}</li>' for p in post.get('pontos', [])[:4])
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{fontes}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{width:1080px;height:{alt}px;overflow:hidden;background:#0f1e3a;font-family:'I';color:#efe6d2;position:relative}}
.faixa{{position:absolute;left:0;right:0;top:0;height:{'340' if story else '258'}px;background:#1e3d78}}
.faixa:after{{content:"";position:absolute;inset:0;background:repeating-linear-gradient(45deg,rgba(255,255,255,.035) 0 2px,transparent 2px 46px),repeating-linear-gradient(-45deg,rgba(255,255,255,.035) 0 2px,transparent 2px 46px)}}
.wrap{{position:relative;height:100%;padding:{'150px 90px 140px' if story else '80px 84px 70px'};display:flex;flex-direction:column}}
.top{{display:flex;align-items:center;gap:26px}}
.top img{{width:118px;height:118px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35)}}
.nome{{font-family:'S';font-weight:700;font-size:46px;letter-spacing:1px;color:#fff;line-height:1.05}}
.oab{{font-size:22px;letter-spacing:5px;color:#b9c6e4;margin-top:8px;text-transform:uppercase}}
.etq{{display:inline-block;margin-top:{'130' if story else '96'}px;background:#efe6d2;color:#0f1e3a;font-weight:700;font-size:26px;letter-spacing:3px;text-transform:uppercase;padding:12px 24px;border-radius:99px;align-self:flex-start}}
h1{{font-family:'S';font-weight:700;font-size:{tam}px;line-height:1.04;color:#fff;margin-top:36px}}
ul{{list-style:none;margin-top:{'60' if story else '44'}px}}
li{{font-size:{'40' if story else '36'}px;line-height:1.38;color:#e7ecf6;padding-left:44px;position:relative;margin-bottom:26px}}
li:before{{content:"";position:absolute;left:0;top:17px;width:18px;height:18px;border-radius:50%;background:#6a93d6}}
.rod{{margin-top:auto;border-top:2px solid rgba(239,230,210,.25);padding-top:30px;display:flex;justify-content:space-between;align-items:flex-end;font-size:26px;color:#cfd8ea}}
.rod b{{color:#efe6d2;font-weight:600}}
.cta{{font-size:{'34' if story else '28'}px;color:#efe6d2;font-weight:600;margin-top:{'40' if story else '0'}px}}
</style></head><body><div class="faixa"></div><div class="wrap">
<div class="top"><img src="data:image/png;base64,{b64('logo.png')}"><div><div class="nome">Rafael de Mello Souza</div><div class="oab">Advogado · OAB/SP 352.797</div></div></div>
<div class="etq">{e(post.get('etiqueta', 'INSS · Notícia'))}</div>
<h1>{e(post['titulo'])}</h1>
<ul>{pontos}</ul>
{'<div class="cta">Dúvidas? Fale comigo no WhatsApp: (14) 99611-9228</div>' if story else ''}
<div class="rod"><div><b>@rafaadvogado</b><br>rafaelmsouza.adv.br</div><div style="text-align:right">{data}<br>Conteúdo informativo</div></div>
</div></body></html>"""


def render(post, saida):
    os.makedirs(saida, exist_ok=True)
    for nome, alt in (('feed', 1350), ('story', 1920)):
        with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8') as f:
            f.write(montar(post, alt))
        png = os.path.join(saida, nome + '.png')
        subprocess.run([chrome(), '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                        f'--window-size=1080,{alt}', f'--screenshot={png}', 'file://' + f.name], check=True, capture_output=True, timeout=120)
        os.unlink(f.name)
    return [os.path.join(saida, 'feed.png'), os.path.join(saida, 'story.png')]


def _fontes():
    return ''.join(f"@font-face{{font-family:'{f}';font-weight:{w};src:url(data:font/woff2;base64,{b64('fonts/' + a)}) format('woff2')}}"
                   for f, w, a in [('S', 600, 'serif-600.woff2'), ('S', 700, 'serif-700.woff2'), ('I', 400, 'inter-400.woff2'), ('I', 600, 'inter-600.woff2'), ('I', 700, 'inter-700.woff2')])


def _slide(corpo, n, total, data):
    e = html.escape
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{_fontes()}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{width:1080px;height:1350px;overflow:hidden;background:#0f1e3a;font-family:'I';color:#efe6d2;position:relative}}
body:before{{content:"";position:absolute;inset:0;background:repeating-linear-gradient(45deg,rgba(255,255,255,.03) 0 2px,transparent 2px 60px),repeating-linear-gradient(-45deg,rgba(255,255,255,.03) 0 2px,transparent 2px 60px)}}
.top{{position:absolute;left:84px;right:84px;top:70px;display:flex;align-items:center;gap:20px}}
.top img{{width:84px;height:84px;border-radius:12px}}
.top b{{display:block;font-family:'S';font-weight:700;font-size:36px;color:#fff}} .top span{{font-size:19px;letter-spacing:4px;color:#b9c6e4}}
.cont{{position:absolute;left:84px;right:84px;top:250px;bottom:190px;display:flex;flex-direction:column;justify-content:center}}
.etq{{align-self:flex-start;background:#efe6d2;color:#0f1e3a;font-weight:700;font-size:26px;letter-spacing:3px;text-transform:uppercase;padding:12px 24px;border-radius:99px;margin-bottom:40px}}
h1{{font-family:'S';font-weight:700;color:#fff;line-height:1.04}}
.num{{font-family:'S';font-weight:700;font-size:150px;line-height:1;color:#6a93d6;margin-bottom:10px}}
p{{font-size:56px;line-height:1.3;color:#e7ecf6}}
.sub{{font-size:34px;color:#cfd8ea;margin-top:28px;line-height:1.4}}
.rod{{position:absolute;left:84px;right:84px;bottom:70px;border-top:2px solid rgba(239,230,210,.25);padding-top:26px;display:flex;justify-content:space-between;font-size:24px;color:#cfd8ea}}
.rod b{{color:#efe6d2}} .seta{{color:#efe6d2;font-weight:700}}
.cta{{background:#efe6d2;color:#0f1e3a;border-radius:24px;padding:46px 50px}} .cta h1{{color:#0f1e3a}} .cta p{{color:#0f1e3a}}
</style></head><body>
<div class="top"><img src="data:image/png;base64,{b64('logo.png')}"><div><b>Rafael de Mello Souza</b><span>ADVOGADO · OAB/SP 352.797</span></div></div>
<div class="cont">{corpo}</div>
<div class="rod"><div><b>@rafaadvogado</b> · rafaelmsouza.adv.br</div><div>{n}/{total}{' &nbsp;<span class="seta">arraste →</span>' if n < total else ''}</div></div>
</body></html>"""


def carrossel(post, saida):
    """Carrossel do feed: capa + 1 slide por ponto (ou por item de "slides") + slide final."""
    e = html.escape
    d = post.get('data', '')
    data = f'{d[8:10]}/{d[5:7]}/{d[0:4]}' if len(d) == 10 else ''
    miolo = post.get('slides') or [{'texto': p} for p in post.get('pontos', [])[:5]]
    tit = post['titulo']; tam = 104 if len(tit) < 40 else 90 if len(tit) < 60 else 78
    corpos = [f'<div class="etq">{e(post.get("etiqueta", "INSS · Notícia"))}</div><h1 style="font-size:{tam}px">{e(tit)}</h1><div class="sub">{data + " · " if data else ""}Entenda em {len(miolo)} pontos</div>']
    for i, sl in enumerate(miolo, 1):
        t = sl.get('titulo')
        corpos.append(f'<div class="num">{i:02d}</div>' + (f'<h1 style="font-size:64px;margin-bottom:24px">{e(t)}</h1>' if t else '') + f'<p>{e(sl.get("texto", ""))}</p>')
    corpos.append('<div class="cta"><h1 style="font-size:70px">Ficou com dúvida?</h1><p style="font-size:38px;margin-top:22px">Leia a notícia completa em <b>rafaelmsouza.adv.br</b> e siga <b>@rafaadvogado</b> para mais notícias do INSS.</p><p style="font-size:30px;margin-top:22px">WhatsApp: (14) 99611-9228</p><p style="font-size:22px;margin-top:26px;letter-spacing:3px">CONTEÚDO INFORMATIVO</p></div>')
    os.makedirs(saida, exist_ok=True); out = []
    for n, c in enumerate(corpos, 1):
        with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8') as f:
            f.write(_slide(c, n, len(corpos), data))
        png = os.path.join(saida, f'carrossel-{n}.png')
        subprocess.run([chrome(), '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                        '--window-size=1080,1350', f'--screenshot={png}', 'file://' + f.name], check=True, capture_output=True, timeout=120)
        os.unlink(f.name); out.append(png)
    return out


if __name__ == '__main__':
    post = json.load(open(sys.argv[1], encoding='utf-8'))
    print('\n'.join(render(post, sys.argv[2]) + carrossel(post, sys.argv[2])))
    print('AVISO: o Dr. Rafael pediu em 11/11/2026 o CARROSSEL diário do Instagram: confira e envie também carrossel-*.png (renomeie para carrossel-AAAA-MM-DD-N.png) com a legenda do carrossel.')
