# Plays practice games in a real browser at phone and desktop size and saves screenshots.
# python3 tools/browser_test.py <docs dir> <out dir>
import sys, os, time, random, threading, http.server, functools
from playwright.sync_api import sync_playwright

docs, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=docs)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def play(page, tag, shots):
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:8766/index.html')
    page.fill('#name', 'Abhyuday')
    page.select_option('#bots', '2')
    page.screenshot(path=f'{out}/{tag}-1-home.png')
    page.click('#practice')
    page.wait_for_selector('[data-act="ready"]')
    page.screenshot(path=f'{out}/{tag}-2-peek.png')
    page.click('[data-act="ready"]')
    seen = set()
    t0 = time.time()
    powers = set()
    while time.time() - t0 < 150:
        if page.is_visible('#result'):
            page.screenshot(path=f'{out}/{tag}-9-result.png')
            if 'result' not in seen:
                seen.add('result')
                if len(seen) > 6: break
            page.click('#again')
            page.wait_for_selector('[data-act="ready"]', timeout=5000)
            page.click('[data-act="ready"]')
            continue
        status = page.inner_text('#status')
        acts = [b.get_attribute('data-act') for b in page.query_selector_all('#actions [data-act]:not([disabled])')]
        try:
            if 'Pick one of your cards to give' in status:
                page.click('#my-grid [data-uid].target'); continue
            if 'draw' in acts:
                if 'declareOpen' in acts and random.random() < 0.5:
                    page.click('[data-act="declareOpen"]'); page.fill('#declare-num', str(random.randint(0, 14)))
                    page.screenshot(path=f'{out}/{tag}-7-declare.png')
                    page.click('[data-act="declareGo"]'); time.sleep(0.4); continue
                page.click('[data-act="draw"]'); time.sleep(0.25)
                if 'decide' not in seen: seen.add('decide'); page.screenshot(path=f'{out}/{tag}-3-decide.png')
                continue
            if 'throw' in acts:
                if random.random() < 0.6:
                    cards = page.query_selector_all('#my-grid [data-uid].target')
                    random.choice(cards).click()
                else:
                    page.click('[data-act="throw"]')
                time.sleep(0.3); continue
            if 'useJack' in acts:
                page.click('[data-act="useJack"]'); powers.add('jack'); continue
            if 'skipPeek' in acts or 'pass' in acts:
                targets = page.query_selector_all('[data-uid].target')
                if targets:
                    if ('king' in status.lower() or 'Pick two' in status or 'different player' in status) and f'power-{status[:12]}' not in seen:
                        seen.add(f'power-{status[:12]}'); page.screenshot(path=f'{out}/{tag}-5-power-{len(powers)}.png')
                    powers.add(status[:20])
                    random.choice(targets).click(); time.sleep(0.35)
                    if page.query_selector('#my-grid .card.peek, #opps .card.peek') and 'peek' not in seen:
                        seen.add('peek'); page.screenshot(path=f'{out}/{tag}-6-peeked.png')
                    continue
                page.click('[data-act="pass"]'); continue
            if 'snap' in acts and random.random() < 0.03:
                page.click('[data-act="snap"]')
                page.screenshot(path=f'{out}/{tag}-8-snapmode.png')
                cards = page.query_selector_all('[data-uid]')
                random.choice(cards).click(); time.sleep(0.4); continue
        except Exception as e:
            pass
        time.sleep(0.15)
    page.screenshot(path=f'{out}/{tag}-10-end.png')
    return errs, powers

with sync_playwright() as p:
    b = p.chromium.launch()
    for tag, vp in [('phone', {'width': 390, 'height': 844}), ('desk', {'width': 1280, 'height': 860})]:
        ctx = b.new_context(viewport=vp, device_scale_factor=2 if tag == 'phone' else 1)
        page = ctx.new_page()
        errs, powers = play(page, tag, [])
        w = page.evaluate('document.documentElement.scrollWidth')
        print(tag, 'errors:', errs[:5], 'scrollWidth', w, 'powers seen', sorted(powers))
        ctx.close()
    b.close()
srv.shutdown()
