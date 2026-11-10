#!/usr/bin/env python3
"""Gera o vídeo vertical (1080x1920, MP4) da notícia do dia para Reels, YouTube Shorts e TikTok,
na mesma identidade visual de gerar_post.py.

Uso: python3 gerar_video.py POST.json PASTA_SAIDA
POST.json: o mesmo do gerar_post.py
  {"etiqueta": "INSS · Tema", "titulo": "...", "pontos": ["...", "..."], "data": "AAAA-MM-DD"}
Saída: PASTA_SAIDA/video.mp4 (H.264, 30 fps, sem áudio: a música pode ser escolhida no próprio app)

Roteiro: título -> cada ponto aparece em sequência -> quadro final com o site.
O conteúdo fica dentro da zona segura dos apps (topo, rodapé e lateral direita ficam
cobertos pelos botões e pela legenda nos Reels/Shorts/TikTok).
"""
import html, json, os, subprocess, sys, tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
from gerar_post import b64, chrome  # noqa: E402

FONTES = ''.join(f"@font-face{{font-family:'{f}';font-weight:{w};src:url(data:font/woff2;base64,{b64('fonts/' + a)}) format('woff2')}}"
                 for f, w, a in [('S', 600, 'serif-600.woff2'), ('S', 700, 'serif-700.woff2'), ('I', 400, 'inter-400.woff2'),
                                 ('I', 600, 'inter-600.woff2'), ('I', 700, 'inter-700.woff2')])
LOGO = b64('logo.png')
FADE = 0.45


def quadro(post, etapa, final=False):
    """etapa = quantos pontos já aparecem (0 = só o título)."""
    e = html.escape
    d = post.get('data', '')
    data = f'{d[8:10]}/{d[5:7]}/{d[0:4]}' if len(d) == 10 else ''
    tit = len(post['titulo'])
    tam = 100 if tit < 40 else 88 if tit < 60 else 78
    pontos = post.get('pontos', [])[:4]
    lis = ''.join(f'<li class="{"on" if i < etapa else "off"}{" atual" if i == etapa - 1 and not final else ""}">{e(p)}</li>'
                  for i, p in enumerate(pontos))
    fim = '' if not final else f"""<div class="fim"><div class="caixa">
<div class="k">Leia a notícia completa</div><div class="site">rafaelmsouza.adv.br</div>
<div class="k2">Siga <b>@rafaadvogado</b> para mais notícias do INSS</div><div class="info">Conteúdo informativo</div></div></div>"""
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{FONTES}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{width:1080px;height:1920px;overflow:hidden;background:#0f1e3a;font-family:'I';color:#efe6d2;position:relative}}
.faixa{{position:absolute;left:0;right:0;top:0;height:560px;background:#1e3d78}}
.faixa:after{{content:"";position:absolute;inset:0;background:repeating-linear-gradient(45deg,rgba(255,255,255,.035) 0 2px,transparent 2px 46px),repeating-linear-gradient(-45deg,rgba(255,255,255,.035) 0 2px,transparent 2px 46px)}}
.wrap{{position:absolute;left:80px;right:160px;top:260px;bottom:430px;display:flex;flex-direction:column}}
.top{{display:flex;align-items:center;gap:24px}}
.top img{{width:110px;height:110px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35)}}
.nome{{font-family:'S';font-weight:700;font-size:44px;color:#fff;line-height:1.05}}
.oab{{font-size:21px;letter-spacing:4px;color:#b9c6e4;margin-top:8px;text-transform:uppercase}}
.etq{{margin-top:120px;align-self:flex-start;background:#efe6d2;color:#0f1e3a;font-weight:700;font-size:26px;letter-spacing:3px;text-transform:uppercase;padding:12px 24px;border-radius:99px}}
h1{{font-family:'S';font-weight:700;font-size:{tam}px;line-height:1.04;color:#fff;margin-top:34px}}
ul{{list-style:none;margin-top:56px}}
li{{font-size:40px;line-height:1.34;color:#e7ecf6;padding-left:46px;position:relative;margin-bottom:28px}}
li:before{{content:"";position:absolute;left:0;top:18px;width:20px;height:20px;border-radius:50%;background:#6a93d6}}
li.off{{opacity:0}}
li.atual{{color:#fff;font-weight:600}}
li.atual:before{{background:#efe6d2}}
.rod{{margin-top:auto;border-top:2px solid rgba(239,230,210,.25);padding-top:26px;display:flex;justify-content:space-between;font-size:26px;color:#cfd8ea}}
.rod b{{color:#efe6d2;font-weight:600}}
.fim{{position:absolute;inset:0;background:rgba(10,20,40,.86);display:flex;align-items:center;justify-content:center;padding:0 160px 200px 80px}}
.caixa{{background:#efe6d2;color:#0f1e3a;border-radius:28px;padding:70px 60px;text-align:center;width:100%}}
.k{{font-size:34px;font-weight:600;letter-spacing:1px}}
.site{{font-family:'S';font-weight:700;font-size:72px;margin:18px 0 34px;color:#1e3d78}}
.k2{{font-size:32px;line-height:1.35}}
.info{{font-size:24px;letter-spacing:3px;text-transform:uppercase;margin-top:34px;color:#4a5a7a}}
</style></head><body><div class="faixa"></div><div class="wrap">
<div class="top"><img src="data:image/png;base64,{LOGO}"><div><div class="nome">Rafael de Mello Souza</div><div class="oab">Advogado · OAB/SP 352.797</div></div></div>
<div class="etq">{e(post.get('etiqueta', 'INSS · Notícia'))}</div>
<h1>{e(post['titulo'])}</h1>
<ul>{lis}</ul>
<div class="rod"><div><b>@rafaadvogado</b><br>rafaelmsouza.adv.br</div><div style="text-align:right">{data}<br>Conteúdo informativo</div></div>
</div>{fim}</body></html>"""


def png(html_txt, destino):
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8') as f:
        f.write(html_txt)
    subprocess.run([chrome(), '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--window-size=1080,1920', f'--screenshot={destino}', 'file://' + f.name], check=True, capture_output=True, timeout=120)
    os.unlink(f.name)


def render(post, saida):
    os.makedirs(saida, exist_ok=True)
    tmp = tempfile.mkdtemp()
    pontos = post.get('pontos', [])[:4]
    etapas = [(0, False, 3.5)]
    for i, p in enumerate(pontos, 1):
        etapas.append((i, False, max(3.2, min(6.5, len(p) / 15 + 1.2))))  # tempo de leitura
    etapas.append((len(pontos), True, 4.0))
    imgs = []
    for n, (k, fim, dur) in enumerate(etapas):
        p = os.path.join(tmp, f'q{n}.png')
        png(quadro(post, k, fim), p)
        imgs.append((p, dur))
    # cada quadro dura dur + FADE (o fade come FADE do seguinte)
    cmd = ['ffmpeg', '-y', '-loglevel', 'error']
    for p, dur in imgs:
        cmd += ['-loop', '1', '-framerate', '30', '-t', f'{dur + FADE:.2f}', '-i', p]
    filtros, ant, t = [], '[0:v]', 0.0
    for i in range(1, len(imgs)):
        t += imgs[i - 1][1]
        filtros.append(f'{ant}[{i}:v]xfade=transition=fade:duration={FADE}:offset={t:.2f}[v{i}]')
        ant = f'[v{i}]'
    filtros.append(f'{ant}format=yuv420p[out]')
    out = os.path.join(saida, 'video.mp4')
    cmd += ['-filter_complex', ';'.join(filtros), '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-r', '30', '-movflags', '+faststart', out]
    subprocess.run(cmd, check=True)
    # capa (primeiro quadro com todos os pontos) para usar como miniatura, se quiser
    capa = os.path.join(saida, 'capa.png')
    png(quadro(post, len(pontos)), capa)
    return [out, capa]


if __name__ == '__main__':
    print('\n'.join(render(json.load(open(sys.argv[1], encoding='utf-8')), sys.argv[2])))
