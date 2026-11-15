"""End-to-end UI test: real app code in headless Chrome; NASA + CDN responses mocked."""
import io, json, re, sys, threading, http.server, functools, urllib.parse
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = sys.argv[1]
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
class Quiet(handler.func):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()

MAPLIBRE_STUB = """
window.maplibregl = (function(){
  class Src { constructor(o){this.o=o;} setData(d){this.data=d;} updateImage(o){this.o=o;} }
  class Map { constructor(){ this.s={}; this.l={}; this.h={}; window.__map=this; setTimeout(()=> (this.h.load||[]).forEach(f=>f()), 10); }
    on(e,f){ (this.h[e]=this.h[e]||[]).push(f); } addControl(){} fitBounds(b){ this.fit=b; }
    addSource(id,o){ if(this.s[id]) throw new Error('dup source '+id); this.s[id]=new Src(o);} getSource(id){return this.s[id];}
    removeSource(id){ delete this.s[id]; } addLayer(l,before){ if(this.l[l.id]) throw new Error('dup layer '+l.id); if(before && !this.l[before]) throw new Error('missing before '+before); this.l[l.id]=l; }
    getLayer(id){return this.l[id];} removeLayer(id){ delete this.l[id]; } setLayoutProperty(){} }
  return { Map, NavigationControl: class{}, ScaleControl: class{} };
})();"""
CHART_STUB = """window.Chart = class { constructor(el,cfg){ this.cfg=cfg; window.__chart=this; this.scales={x:{getPixelForValue:()=>0,getValueForPixel:()=>0}}; } update(){} destroy(){} };"""

DIST_XML = '''<ColorMaps><ColorMap units=""><Entries>
<ColorMapEntry rgb="0,0,0" transparent="true" label="No Data" nodata="true"/>
<ColorMapEntry rgb="255,230,0" label="First detection (&lt;50%)"/>
<ColorMapEntry rgb="255,140,0" label="Confirmed (&lt;50%)"/>
<ColorMapEntry rgb="230,30,30" label="First detection (&#8805;50%)"/>
<ColorMapEntry rgb="120,0,0" label="Confirmed (&#8805;50%)"/>
<ColorMapEntry rgb="200,200,200" label="Cloud"/></Entries></ColorMap></ColorMaps>'''
WATER_XML = '''<ColorMap><ColorMapEntry rgb="250,250,250" label="Not Water"/><ColorMapEntry rgb="0,0,255" label="Open Water"/>
<ColorMapEntry rgb="150,200,255" label="Partial Surface Water"/><ColorMapEntry rgb="220,220,220" label="Cloud/Cloud Shadow"/></ColorMap>'''

DATES = ['2026-05-10','2026-06-03','2026-07-01','2026-08-14','2026-09-20','2026-10-30']
requests = []

def png(w, h, layer, t):
    im = Image.new('RGBA', (w, h), (0,0,0,0)); d = ImageDraw.Draw(im)
    k = DATES.index(t) if t in DATES else 2
    frac = (k+1)/len(DATES)
    if 'DIST' in layer:
        d.rectangle([0,0,int(w*0.5*frac),h], fill=(120,0,0,255))
        d.rectangle([int(w*0.5*frac),0,int(w*0.6*frac)+1,h], fill=(255,230,0,255))
        d.rectangle([w-20,0,w,20], fill=(200,200,200,255))
    elif 'Radiometric' in layer:
        d.rectangle([0,0,w,h], fill=(150,150,150,255))
        d.rectangle([0,0,int(w*0.4*frac),h], fill=(150-int(90*frac),)*3+(255,))
    elif 'Surface_Water' in layer:
        d.rectangle([0,0,w,h], fill=(250,250,250,255))
        d.rectangle([0,int(h*0.7),w,h], fill=(0,0,255,255))
        if k >= 3: d.rectangle([0,int(h*0.55),w,int(h*0.7)], fill=(150,200,255,255))
    elif 'Thermal' in layer:
        for i in range(k*3): d.ellipse([10+i*7,40,14+i*7,44], fill=(255,0,0,255))
    out = io.BytesIO(); im.save(out, 'PNG'); return out.getvalue()

def api(route):
    url = urllib.parse.urlparse(route.request.url); q = dict(urllib.parse.parse_qsl(url.query))
    requests.append(url.path + '?' + url.query)
    if url.path == '/api/health': return route.fulfill(json={'ok': True})
    if url.path == '/api/cmr/granules':
        name = q['short_name']
        if 'NISAR' in name: return route.fulfill(json={'hits':0,'returned':0,'dates':[],'collections':[],'sample':[],'query':'https://cmr.example/q'})
        if 'MODISA' in name: return route.fulfill(status=502, json={'error':'CMR HTTP 503'})
        return route.fulfill(json={'hits':len(DATES)*3,'returned':len(DATES)*3,'dates':DATES,'collections':['C1'],'sample':[],'query':'https://cmr.earthdata.nasa.gov/search/granules.json?short_name='+name})
    if url.path.startswith('/api/gibs/colormap/'):
        layer = url.path.split('/')[-1]
        if 'DIST' in layer: return route.fulfill(body=DIST_XML, content_type='text/xml')
        if 'Surface_Water' in layer: return route.fulfill(body=WATER_XML, content_type='text/xml')
        return route.fulfill(status=404, json={'error':'NASA HTTP 404'})
    if url.path == '/api/gibs/wms':
        w, h = int(q['WIDTH']), int(q['HEIGHT'])
        if q.get('proj') == '3857': return route.fulfill(body=png(w,h,q['LAYERS'],q.get('TIME','')), content_type='image/png')
        bbox = [float(v) for v in q['BBOX'].split(',')]
        assert bbox[0] < bbox[2] and bbox[1] < bbox[3] and bbox[0] < 0, 'WMS 1.3.0 lat,lon order expected'
        return route.fulfill(body=png(w,h,q['LAYERS'],q.get('TIME','')), content_type='image/png')
    route.fulfill(status=404, json={'error':'?'})

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    page = b.new_page(viewport={'width':1500,'height':950})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.route(re.compile(r'.*unpkg\.com/.*\.js$'), lambda r: r.fulfill(body=MAPLIBRE_STUB, content_type='application/javascript'))
    page.route(re.compile(r'.*unpkg\.com/.*\.css$'), lambda r: r.fulfill(body='', content_type='text/css'))
    page.route(re.compile(r'.*jsdelivr\.net/.*'), lambda r: r.fulfill(body=CHART_STUB, content_type='application/javascript'))
    page.route(re.compile(r'.*/api/.*'), api)
    page.goto('http://127.0.0.1:8765/index.html')
    page.wait_for_timeout(600)
    assert page.locator('#coord-body tr').count() == 1, 'example row loaded'
    assert 'Area:' in page.inner_text('#aoi-info'), page.inner_text('#aoi-info')
    # invalid coordinate handling
    page.fill('#coord-body tr .lat', '95'); page.dispatch_event('#coord-body tr .lat', 'change'); page.wait_for_timeout(100)
    assert 'latitude must be' in page.inner_text('#aoi-info')
    page.fill('#coord-body tr .lat', '-8.30'); page.dispatch_event('#coord-body tr .lat', 'change'); page.wait_for_timeout(100)
    # phenomena: vegetation, water, fire (example 0) + add algae
    page.check('#phenomena input[value=algae]')
    page.fill('#start', '2026-05-01'); page.fill('#end', '2026-11-10')
    page.click('#analyze')
    page.wait_for_function("document.querySelector('#analyze').disabled === false && document.querySelector('#slider').max > 0", timeout=30000)
    page.wait_for_timeout(300)
    status = page.inner_text('#status'); print('STATUS:', status)
    findings = page.inner_text('#findings'); print('FINDINGS:\n', findings[:1600])
    page.click('.tabs button[data-tab=sources]'); sources = page.inner_text('#sources'); print('SOURCES:\n', sources[:2500])
    svg_circles = page.locator('#tl-svg circle').count(); print('timeline circles', svg_circles)
    # interact: slider to first date, then play one step, switch view
    page.evaluate("document.querySelector('#slider').value=0; document.querySelector('#slider').dispatchEvent(new Event('input'))")
    first_date = page.inner_text('#tl-date')
    page.click('.tabs button[data-tab=findings]'); f0 = page.inner_text('#findings')
    page.click('.seg button[data-view=original]')
    layers_orig = page.evaluate("Object.keys(window.__map.l)")
    page.click('.seg button[data-view=classified]')
    page.evaluate("document.querySelector('#slider').value=document.querySelector('#slider').max; document.querySelector('#slider').dispatchEvent(new Event('input'))")
    layers_cls = page.evaluate("Object.keys(window.__map.l)")
    page.select_option('#context', 'viirs-tc'); page.wait_for_timeout(100)
    layers_ctx = page.evaluate("Object.keys(window.__map.l)")
    legend = page.inner_text('#legend')
    with page.expect_download() as dl: page.click('#export-csv')
    csv = open(dl.value.path()).read()
    page.screenshot(path='/home/claude/e2e_screenshot.png', full_page=False)
    b.close()
srv.shutdown()

print('first date', first_date, '| layers original', layers_orig, '| classified', layers_cls, '| ctx', layers_ctx)
print('CSV lines', len(csv.splitlines())); print(csv.splitlines()[0]); print(csv.splitlines()[1])
print('ERRORS', errors)
assert not [e for e in errors if 'Failed to load resource' not in e], errors
assert 'returned real NASA data' in status
assert 'Vegetation loss' in findings and 'Severe' in findings and 'km²' in findings
assert 'Detected by 2+ independent sensors' in findings
assert 'LIVE' in sources and 'No acquisitions' in sources and 'NISAR' in sources
assert 'colour map not available' in sources        # chlorophyll colour map 404 fallback
assert svg_circles >= 10
assert first_date == '2026-05-01'
assert any(l.startswith('gibs-') for l in layers_orig) and 'classified' in layers_cls and 'ctx-viirs-tc' in layers_ctx
assert 'Severe' in legend and len(csv.splitlines()) > 10
print('E2E: all assertions passed')
