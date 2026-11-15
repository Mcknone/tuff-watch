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
    getLayer(id){return this.l[id];} removeLayer(id){ delete this.l[id]; } setLayoutProperty(){}
    setProjection(p){ this.proj=p; } setTerrain(t){ this.terrain=t; } getPitch(){ return 0; } getZoom(){ return 2; }
    easeTo(){} resize(){}
    getCanvasContainer(){ return document.getElementById('map'); } getCanvas(){ return document.getElementById('map'); }
    unproject(p){ return { lng: 10 + p[0] / 100, lat: -5 - p[1] / 100 }; } getCenter(){ return { lng: 140.3, lat: -8.25 }; }
    get dragRotate(){ return { enable(){} }; } get touchZoomRotate(){ return { enable(){} }; } get touchPitch(){ return { enable(){} }; } }
  class Marker { constructor(){ window.__markers = (window.__markers || 0) + 1; } setLngLat(){ return this; } addTo(){ return this; } remove(){} }
  return { Map, Marker, NavigationControl: class{}, ScaleControl: class{} };
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
        assert bbox[0] < bbox[2] and bbox[1] < bbox[3] and abs(bbox[0]) <= 90 and abs(bbox[2]) <= 90, 'WMS 1.3.0 lat,lon order expected'
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
    # flood output at the last date
    page.click('.tabs button[data-tab=findings]')
    flood = page.inner_text('.finding.water'); print('FLOOD:\n', flood[:900])
    # pre-event baseline comparison on the map
    page.check('#show-baseline'); page.wait_for_timeout(100)
    legend_base = page.inner_text('#legend')
    page.uncheck('#show-baseline')
    # middle-click on the map adds an AOI point, right-click menu is suppressed
    rows0 = page.locator('#coord-body tr').count()
    page.dispatch_event('#map', 'mousedown', {'button': 1, 'clientX': 400, 'clientY': 300})
    page.dispatch_event('#map', 'mouseup', {'button': 1, 'clientX': 401, 'clientY': 300})
    page.wait_for_timeout(100)
    rows1 = page.locator('#coord-body tr').count()
    ctx_prevented = page.evaluate("(() => { const e = new MouseEvent('contextmenu', {bubbles: true, cancelable: true}); document.getElementById('map').dispatchEvent(e); return e.defaultPrevented; })()")
    toast = page.inner_text('#toast')
    # a plain left click never adds a point; "Add point" mode uses a crosshair + explicit button
    page.dispatch_event('#map', 'click', {'button': 0, 'clientX': 300, 'clientY': 200})
    page.wait_for_timeout(100)
    rows_after_click = page.locator('#coord-body tr').count()
    page.click('#pick-btn'); crosshair = page.is_visible('#crosshair')
    page.click('#pick-add'); page.wait_for_timeout(100)
    rows_after_pick = page.locator('#coord-body tr').count()
    page.click('#pick-done'); crosshair_off = not page.is_visible('#crosshair')

    # ---- event timeline ----
    ev_ids = page.evaluate("[...document.querySelectorAll('#tl-svg [data-ev]')].map(g => g.dataset.ev)")
    page.click('#tl-svg [data-ev=ev-water] rect >> nth=0', force=True); page.wait_for_timeout(150)
    ev_date = page.inner_text('#tl-date'); ev_chip = page.inner_text('#phase-chip')
    ev_card = page.inner_text('.event-card')
    page.click('#phase-nav [data-phase=before]'); page.wait_for_timeout(100)
    before_date = page.inner_text('#tl-date'); before_chip = page.inner_text('#phase-chip')
    before_findings = page.inner_text('.finding.water')
    after_disabled = page.is_disabled('#phase-nav [data-phase=after]')
    page.click('#phase-nav [data-phase=during]'); page.wait_for_timeout(100)
    during_date = page.inner_text('#tl-date')
    layers_during = page.evaluate("Object.keys(window.__map.l)")
    with page.expect_download() as dlj: page.click('#export-json')
    ev_json = json.load(open(dlj.value.path()))['events']
    # guided tour
    page.click('#tour-btn')
    tour_titles = []
    for k in range(8):
        tour_titles.append(page.inner_text('#tour-title'))
        if k < 7: page.click('.tour-next')
    last_btn = page.inner_text('.tour-next'); progress = page.inner_text('.tour-count')
    page.click('.tour-prev'); back_title = page.inner_text('#tour-title')
    page.click('.tour-skip'); tour_closed = page.locator('.tour').count() == 0
    page.click('#tour-btn'); reopened = page.inner_text('#tour-title'); page.keyboard.press('Escape')
    with page.expect_download() as dl: page.click('#export-csv')
    csv = open(dl.value.path()).read()
    # documented records: Palisades example (CAL FIRE reported start + containment)
    page.select_option('#examples', '2'); page.wait_for_timeout(200)
    page.click('#analyze')
    page.wait_for_function("document.querySelector('#analyze').disabled === false && document.querySelector('.event-card')", timeout=30000)
    page.select_option('#event-select', 'ev-fire') if page.is_visible('#event-select') else None
    page.wait_for_timeout(150)
    fire_card = page.inner_text('.event-card')
    # date filtering: shorten the period so the containment date falls outside it
    page.fill('#end', '2025-01-20'); page.click('#analyze')
    page.wait_for_function("document.querySelector('#analyze').disabled === false", timeout=30000)
    page.wait_for_timeout(200)
    page.select_option('#event-select', 'ev-fire') if page.is_visible('#event-select') else None
    fire_card2 = page.inner_text('.event-card')
    page.screenshot(path='/home/claude/e2e_screenshot.png', full_page=False)
    b.close()
srv.shutdown()

print('EVENTS', ev_ids, ev_date, ev_chip, before_date, before_chip, during_date, after_disabled)
print('EVENT CARD:\n', ev_card[:900])
print('EV JSON', json.dumps([{k: e[k] for k in ('id', 'status', 'onset_window', 'end_window', 'confidence')} for e in ev_json])[:900])
print('pick', rows_after_click, rows_after_pick, crosshair, crosshair_off)
print('FIRE', fire_card[:600]); print('FIRE filtered', fire_card2[:300])
print('TOUR', tour_titles, last_btn, progress, back_title, tour_closed, reopened)
print('rows', rows0, rows1, 'ctx prevented', ctx_prevented, 'toast', toast)
print('first date', first_date, '| layers original', layers_orig, '| classified', layers_cls, '| ctx', layers_ctx)
print('CSV lines', len(csv.splitlines())); print(csv.splitlines()[0]); print(csv.splitlines()[1])
print('ERRORS', errors)
assert not [e for e in errors if 'Failed to load resource' not in e], errors
assert 'returned real NASA data' in status
assert 'Vegetation loss' in findings and 'Severe' in findings and 'km²' in findings
assert 'Detected by 2+ independent sensors' in findings
assert 'Live data' in sources and 'No acquisitions' in sources and 'NISAR' in sources
assert 'colour map not available' in sources        # chlorophyll colour map 404 fallback
assert svg_circles >= 10
assert first_date == '2026-05-01'
assert any(l.startswith('gibs-') for l in layers_orig) and 'classified' in layers_cls and 'ctx-viirs-tc' in layers_ctx
assert 'Severe' in legend and len(csv.splitlines()) > 10
# floods: categorical extent + confidence, never a severity level, never the whole area
assert 'Newly inundated' in flood and 'Valid coverage' in flood and 'Confidence' in flood and 'Baseline' in flood
assert 'Severe' not in flood and 'Moderate' not in flood
assert 'New water detected' in flood or 'No new water detected' in flood or 'Insufficient data' in flood
assert 'class table' in sources                      # MODIS flood colour map 404 -> not used, not guessed
assert 'Newly inundated' in legend and 'pre-event baseline' in legend_base
assert 'new_water_km2' in csv.splitlines()[0]
# map controls
assert rows1 == rows0 + 1 and ctx_prevented and 'added' in toast
# tour
assert tour_titles[0].startswith('Welcome') and len(set(tour_titles)) == 8
# events: flood onset is the window between the last dry (2026-07-01) and first flooded (2026-08-14) observation
assert 'ev-water' in ev_ids
wev = next(e for e in ev_json if e['id'] == 'ev-water')
assert wev['onset_window']['earliest'] == '2026-07-01' and wev['onset_window']['latest'] == '2026-08-14'
assert wev['status'] == 'ongoing' and wev['end_window'] is None and wev['date_estimation_method'] and wev['sources']
assert wev['supporting_observations'] and wev['confidence'] in ('High', 'Medium', 'Low')
assert ev_date == '2026-08-14' and ev_chip.startswith('During')
assert before_date == '2026-07-01' and before_chip.startswith('Before') and 'Pre-event baseline' not in ev_date
assert after_disabled and during_date == '2026-08-14'
assert 'Onset' in ev_card and 'window' in ev_card and 'Peak observed' in ev_card and 'not observed' in ev_card
assert 'classified' in layers_during
fev = next(e for e in ev_json if e['id'] == 'ev-fire')
assert fev['status'] in ('none', 'ongoing', 'detected', 'insufficient')
assert 'on or before' in fire_card                     # fire seen from the first sample: start not bounded, not back-dated
# left click never adds points; crosshair mode does
assert rows_after_click == rows1 and crosshair and rows_after_pick == rows1 + 1 and crosshair_off
# documented records (Palisades example): shown as reported, separate from detections, filtered by period
assert 'Containment' in fire_card and 'reported, not satellite-derived' in fire_card and 'not</b> containment' not in fire_card
assert 'is not containment' in fire_card.replace('\n', ' ') or 'not containment' in fire_card
assert 'Containment' not in fire_card2 and 'Reported' in fire_card2
assert last_btn == 'Start exploring' and progress == 'Step 8 of 8' and tour_closed and reopened.startswith('Welcome')
print('E2E: all assertions passed')
