#!/usr/bin/env python3
"""Gera as imagens do canal do YouTube na identidade visual do Rafael de Mello Souza.

Uso: python3 gerar_youtube.py PASTA_SAIDA
Saída: banner.png (2560x1440, conteúdo dentro da área segura central de 1546x423)
       perfil.png (800x800, pensado para o recorte redondo)
"""
import os, subprocess, sys, tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
from gerar_post import b64, chrome  # noqa: E402

FONTES = ''.join(f"@font-face{{font-family:'{f}';font-weight:{w};src:url(data:font/woff2;base64,{b64('fonts/' + a)}) format('woff2')}}"
                 for f, w, a in [('S', 600, 'serif-600.woff2'), ('S', 700, 'serif-700.woff2'), ('I', 400, 'inter-400.woff2'),
                                 ('I', 600, 'inter-600.woff2'), ('I', 700, 'inter-700.woff2')])
BASE = f"""{FONTES}*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#0f1e3a;font-family:'I';color:#efe6d2;overflow:hidden;position:relative}}
.trama{{position:absolute;inset:0;background:repeating-linear-gradient(45deg,rgba(255,255,255,.035) 0 2px,transparent 2px 46px),repeating-linear-gradient(-45deg,rgba(255,255,255,.035) 0 2px,transparent 2px 46px)}}
.mono{{font-family:'S';font-weight:600;display:inline-flex;align-items:baseline;line-height:1;letter-spacing:-.02em}}
.mono .r{{display:inline-block;transform:scaleX(-1);color:#efe6d2}}
.mono .m{{color:#6a93d6;margin-left:-.06em}}
.mono .s{{color:#efe6d2}}"""
MONO = '<span class="mono"><span class="r">R</span><span class="m">M</span><span class="s">S</span></span>'


def perfil():
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{BASE}
body{{width:800px;height:800px;background:radial-gradient(circle at 50% 42%,#1e3d78 0,#0f1e3a 72%)}}
.c{{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}}
.mono{{font-size:330px;margin-top:-30px}}
.lin{{width:300px;height:3px;background:rgba(239,230,210,.5);margin:6px 0 26px}}
.oab{{font-size:36px;letter-spacing:7px;color:#cfd8ea;text-transform:uppercase;font-weight:600}}
</style></head><body><div class="trama"></div><div class="c">{MONO}<div class="lin"></div><div class="oab">Advogado</div></div></body></html>"""


def banner():
    # área segura do YouTube (visível em todos os aparelhos): 1546x423 no centro
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{BASE}
body{{width:2560px;height:1440px;background:linear-gradient(180deg,#1e3d78 0,#16305f 48%,#0f1e3a 100%)}}
.safe{{position:absolute;left:507px;top:508px;width:1546px;height:423px;display:flex;align-items:center;gap:70px}}
.logo{{flex:none;width:300px;height:300px;border-radius:28px;background:#0f1e3a;display:flex;align-items:center;justify-content:center;box-shadow:0 18px 50px rgba(0,0,0,.4)}}
.logo .mono{{font-size:122px;margin-top:-8px}}
.txt{{flex:1}}
.nome{{font-family:'S';font-weight:700;font-size:112px;color:#fff;line-height:1}}
.oab{{font-size:32px;letter-spacing:8px;color:#b9c6e4;text-transform:uppercase;margin-top:18px}}
.tema{{margin-top:34px;display:flex;gap:16px;flex-wrap:wrap}}
.tema span{{background:#efe6d2;color:#0f1e3a;font-weight:700;font-size:28px;letter-spacing:2px;text-transform:uppercase;padding:12px 24px;border-radius:99px}}
.tema span.o{{background:transparent;color:#efe6d2;border:2px solid rgba(239,230,210,.6)}}
.site{{position:absolute;left:507px;right:507px;top:960px;display:flex;justify-content:space-between;font-size:30px;color:#cfd8ea}}
.site b{{color:#efe6d2;font-weight:600}}
</style></head><body><div class="trama"></div><div class="safe"><div class="logo">{MONO}</div><div class="txt">
<div class="nome">Rafael de Mello Souza</div><div class="oab">Advogado · OAB/SP 352.797</div>
<div class="tema"><span>Notícias do INSS</span><span class="o">Direito Previdenciário</span></div></div></div>
<div class="site"><div><b>rafaelmsouza.adv.br</b> · @rafaadvogado</div><div>Conteúdo informativo</div></div>
</body></html>"""


def png(html_txt, destino, w, h):
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8') as f:
        f.write(html_txt)
    subprocess.run([chrome(), '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    f'--window-size={w},{h}', f'--screenshot={destino}', 'file://' + f.name], check=True, capture_output=True, timeout=120)
    os.unlink(f.name)


if __name__ == '__main__':
    saida = sys.argv[1]
    os.makedirs(saida, exist_ok=True)
    png(banner(), os.path.join(saida, 'youtube-banner.png'), 2560, 1440)
    png(perfil(), os.path.join(saida, 'youtube-perfil.png'), 800, 800)
    print(os.path.join(saida, 'youtube-banner.png'))
    print(os.path.join(saida, 'youtube-perfil.png'))
