"""Real Chromium GET/filter/theme regression against a disposable synthetic HTTP broker.

No production credentials, network services, external assets or auth bypass in product.
The fixture supplies an ordinary synthetic cookie via private process stdout only.
"""
import json
import os
import pathlib
import re
import subprocess
import tempfile
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import expect, sync_playwright


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    artifacts = pathlib.Path(os.environ.get('ADMIN_TEST_ARTIFACTS', tempfile.mkdtemp(prefix='psst-admin-pixels-')))
    artifacts.mkdir(parents=True, exist_ok=True)
    fixture = subprocess.Popen([os.environ.get('ADMIN_TEST_NODE', 'node'), 'scripts/admin-browser-fixture.mjs'], cwd=root, stdout=subprocess.PIPE, text=True)
    try:
        config = json.loads(fixture.stdout.readline())
        origin = config['origin']
        with sync_playwright() as p:
            options = {'headless': True}
            if os.environ.get('ADMIN_TEST_CHROMIUM'):
                options['executable_path'] = os.environ['ADMIN_TEST_CHROMIUM']
            browser = p.chromium.launch(**options)
            try:
                context = browser.new_context(viewport={'width': 1440, 'height': 1050}, color_scheme='light')
                context.add_cookies([{'name': 'psst_admin', 'value': config['cookie_value'], 'domain': urlsplit(origin).hostname, 'path': '/admin', 'httpOnly': True, 'sameSite': 'Strict'}])
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' and ('script' in msg.text.lower() or 'connect-src' in msg.text.lower()) else None)
                reads = []
                page.on('request', lambda request: reads.append(request.url) if request.resource_type == 'fetch' else None)
                page.goto(origin + '/admin/sessions')
                expect(page.locator('[data-live-filters]')).to_have_attribute('data-enhanced', 'true')
                expect(page.locator('[name=state]')).to_have_value('connected')
                expect(page.locator('tbody tr')).to_have_count(10)
                assert all('Connected' in text for text in page.locator('tbody .badge').all_text_contents())
                expect(page.locator('th[aria-sort]')).to_have_attribute('aria-sort', 'ascending')
                assert not page.locator('.apply-filters').is_visible()
                # Actual theme persistence and system change, not a CSS-only screenshot.
                theme = page.get_by_label('Appearance')
                theme.select_option('dark')
                expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
                page.add_init_script("document.addEventListener('DOMContentLoaded', () => window.__initialTheme = document.documentElement.dataset.theme, {once:true})")
                page.reload()
                expect(theme).to_have_value('dark')
                expect(page.locator('[data-live-filters]')).to_have_attribute('data-enhanced', 'true')
                cookies = [c for c in context.cookies(origin + '/admin') if c['name'] == 'psst_admin']
                assert len(cookies) == 1 and cookies[0]['path'] == '/admin', 'Fixture cookie must match the product path so renewal cannot duplicate it'
                assert page.evaluate('window.__initialTheme') == 'dark'
                page.emulate_media(color_scheme='light')
                expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
                page.screenshot(path=str(artifacts / '01-sessions-dark-desktop.png'), full_page=True)
                theme.select_option('system')
                expect(page.locator('html')).to_have_attribute('data-theme', 'light')
                page.emulate_media(color_scheme='dark')
                expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
                theme.select_option('light')
                page.screenshot(path=str(artifacts / '02-sessions-light-desktop.png'), full_page=True)
                # Debounce preserves the same focused input and its caret, sends one GET.
                name = page.locator('[name=name]')
                count = len(reads)
                name.press_sequentially('At', delay=30)
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                assert len(reads) == count + 1
                expect(name).to_be_focused()
                assert name.evaluate('(el) => el.selectionStart') == len('At')
                assert 'name=At' in page.url
                page.reload()
                expect(name).to_have_value('At')
                # Explicit All survives URL reload and history; resetting restores Connected.
                page.locator('[name=state]').select_option('all')
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                all_url = page.url
                name.fill('NO-MATCH')
                expect(page.get_by_role('heading', name='No sessions found')).to_be_visible()
                page.go_back()
                expect(name).to_have_value('At')
                expect(page.locator('[name=state]')).to_have_value('all')
                expect(page.locator('tbody tr')).not_to_have_count(0)
                page.go_forward()
                expect(page.get_by_role('heading', name='No sessions found')).to_be_visible()
                page.locator('a[data-list-read]').filter(has_text='Reset').click()
                expect(page.locator('[name=state]')).to_have_value('connected')
                expect(page.locator('tbody tr')).to_have_count(10)
                # Partial UUIDs do not issue doomed fetches or replace good results.
                count = len(reads)
                page.get_by_text('Exact identifiers', exact=True).click()
                exact = page.locator('[name=client_id]')
                exact.fill('not-yet-a-uuid')
                page.wait_for_timeout(450)
                assert len(reads) == count
                expect(page.locator('tbody tr')).to_have_count(10)
                expect(page.locator('[data-filter-status]')).to_contain_text('Previous results are unchanged')
                exact.fill('')
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                # Explicit column sorting, pagination and filter changes reset the cursor.
                page.get_by_role('link', name='Sort session name descending', exact=True).click()
                expect(page.locator('th[aria-sort]')).to_have_attribute('aria-sort', 'descending')
                expect(page.locator('[data-sort=name]')).to_be_focused()
                assert page.locator('[data-sort=name]').evaluate('(el) => el.tabIndex') == 0
                first_ids = page.locator('tbody tr').evaluate_all('(rows) => rows.map(r => r.dataset.clientId)')
                page.get_by_role('link', name='Next page').click()
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                assert 'cursor=' in page.url
                second_ids = page.locator('tbody tr').evaluate_all('(rows) => rows.map(r => r.dataset.clientId)')
                assert not set(first_ids).intersection(second_ids)
                page.locator('[name=client_type]').select_option('pi')
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                assert 'cursor=' not in page.url
                expect(page.locator('[name=direction]')).to_have_value('desc')
                # In-flight cancel retains the applied result, controls and URL.
                page.locator('[name=client_type]').select_option('')
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                applied_url = page.url
                pending = []
                def hold(route):
                    pending.append(route)
                page.route('**/admin/sessions?**', hold)
                name.fill('Atlas')
                expect(page.locator('[data-filter-status]')).to_have_text('Updating results…')
                page.get_by_role('button', name='Cancel update').click()
                expect(name).to_have_value('')
                assert page.url == applied_url
                for route in pending:
                    try:
                        route.abort()
                    except Exception:
                        pass
                page.unroute('**/admin/sessions?**', hold)
                # Popstate already changes URL: Cancel must restore the displayed view.
                name.fill('At')
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                before_back = page.url
                pending.clear()
                page.route('**/admin/sessions?**', hold)
                page.go_back()
                expect(page.locator('[data-filter-status]')).to_have_text('Updating results…')
                page.get_by_role('button', name='Cancel update').click()
                assert page.url == before_back
                expect(name).to_have_value('At')
                for route in pending:
                    try:
                        route.abort()
                    except Exception:
                        pass
                page.unroute('**/admin/sessions?**', hold)
                # Two out-of-order responses: old response cannot overwrite a newer request.
                pending.clear()
                page.route('**/admin/sessions?**', hold)
                name.fill('Atlas')
                expect(page.locator('[data-filter-status]')).to_have_text('Updating results…')
                page.wait_for_timeout(100)
                name.fill('Boreal')
                page.wait_for_timeout(450)
                assert len(pending) == 2
                pending[1].continue_()
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                try:
                    pending[0].continue_()
                except Exception:
                    pass
                page.wait_for_timeout(150)
                expect(name).to_have_value('Boreal')
                assert 'name=Boreal' in page.url
                page.unroute('**/admin/sessions?**', hold)
                # Error stays in-page; successful retry is explicit and retained.
                def unavailable(route):
                    route.fulfill(status=503, content_type='text/html', body='Unavailable')
                page.route('**/admin/sessions?**', unavailable)
                name.fill('A')
                expect(page.get_by_role('button', name='Retry', exact=True)).to_be_visible()
                assert 'name=Boreal' in page.url
                page.unroute('**/admin/sessions?**', unavailable)
                page.get_by_role('button', name='Retry', exact=True).click()
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                # Cross-page navigation remembers filters without leaking message bodies.
                session_url = page.url
                page.get_by_role('navigation').get_by_role('link', name='Messages', exact=True).click()
                expect(page.locator('tbody tr')).to_have_count(10)
                assert 'SYNTHETIC-DETAIL-ONLY' not in page.locator('body').inner_text()
                times = page.locator('tbody td:first-child time').evaluate_all('(items) => items.map(el => el.dateTime)')
                assert times == sorted(times, reverse=True)
                page.locator('[name=accepted_after]').fill('2026-11-01T00:00Z')
                expect(page.locator('[data-filter-status]')).to_contain_text('Updated.')
                page.locator('a[data-list-read]').filter(has_text='Reset').click()
                expect(page.locator('tbody tr')).to_have_count(10)
                page.locator('tbody tr').first.get_by_role('link', name='View message').click()
                expect(page.locator('.message-content')).to_contain_text('SYNTHETIC-DETAIL-ONLY')
                page.get_by_role('link', name='Back to messages').click()
                expect(page.locator('tbody tr')).to_have_count(10)
                theme.select_option('dark')
                page.screenshot(path=str(artifacts / '03-messages-dark-desktop.png'), full_page=True)
                page.get_by_role('navigation').get_by_role('link', name='Clients & sessions').click()
                assert page.url == session_url
                expect(name).to_have_value('A')
                # Mobile layout does not overflow the document (table scroll stays local).
                page.set_viewport_size({'width': 390, 'height': 844})
                page.screenshot(path=str(artifacts / '04-sessions-dark-mobile.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.get_by_role('navigation').get_by_role('link', name='Approvals').click()
                page.screenshot(path=str(artifacts / '05-approvals-dark-mobile.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                # Read-only enhancement never intercepts actual logout POST.
                with page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/admin/logout')) as logout:
                    page.get_by_role('button', name='Log out', exact=True).click()
                assert logout.value.status == 303
                expect(page.get_by_role('heading', name='Administrator login')).to_be_visible()
                assert not [e for e in errors if '503' not in e], errors
                # Storage failures must not disable filters/theme (restricted/private environments).
                storage = browser.new_context()
                storage.add_cookies([{'name': 'psst_admin', 'value': config['fallback_cookie'], 'domain': urlsplit(origin).hostname, 'path': '/admin', 'httpOnly': True, 'sameSite': 'Strict'}])
                storage.add_init_script("Object.defineProperty(window, 'localStorage', {get(){throw Error('blocked')}}); Object.defineProperty(window, 'sessionStorage', {get(){throw Error('blocked')}});")
                restricted = storage.new_page()
                restricted.goto(origin + '/admin/sessions')
                expect(restricted.locator('[data-live-filters]')).to_have_attribute('data-enhanced', 'true')
                restricted.get_by_label('Appearance').select_option('dark')
                expect(restricted.locator('html')).to_have_attribute('data-theme', 'dark')
                restricted.locator('[name=state]').select_option('all')
                expect(restricted.locator('[data-filter-status]')).to_contain_text('Updated.')
                storage.close()
                # No-JS fallback keeps ordinary GET form, Connected default and system CSS.
                nojs = browser.new_context(java_script_enabled=False)
                nojs.add_cookies([{'name': 'psst_admin', 'value': config['fallback_cookie'], 'domain': urlsplit(origin).hostname, 'path': '/admin', 'httpOnly': True, 'sameSite': 'Strict'}])
                fallback = nojs.new_page()
                fallback.goto(origin + '/admin/sessions')
                expect(fallback.get_by_role('button', name='Apply filters')).to_be_visible()
                fallback.locator('[name=state]').select_option('all')
                fallback.get_by_role('button', name='Apply filters').click()
                assert 'state=all' in fallback.url
                expect(fallback.locator('[name=state]')).to_have_value('all')
                print('PASS: live filters, debounce, focus, history, sorting/pagination, races, cancellation/error/retry, themes, navigation, metadata-only, logout and no-JS fallback. Screenshots: ' + str(artifacts))
            finally:
                browser.close()
    finally:
        fixture.terminate()
        fixture.wait(timeout=10)


if __name__ == '__main__':
    main()
