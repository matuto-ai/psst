"""Actual browser approval flow against disposable CI HTTPS, never production."""
import json
import os
import pathlib
import re
import subprocess
import tempfile
from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


def assert_approval_state(page, request_id, state):
    """Check only this request's status badge, not an untrusted row label."""
    badge = page.locator('[data-request-id="' + request_id + '"]').locator('.badge')
    expect(badge).to_have_text(re.compile(r"^\s*" + re.escape(state) + r"\s*$", re.IGNORECASE))


def initial_login_page(page, url):
    """Retry only initial read-only navigation after a transient route change."""
    for attempt in range(3):
        try:
            return page.goto(url)
        except PlaywrightError as error:
            # Chromium's exact initial-navigation network change, not TLS,
            # timeout, authentication, assertions or any form POST/action.
            if not str(error).startswith("Page.goto: net::ERR_NETWORK_CHANGED at ") or attempt == 2:
                raise
            print("Initial read-only login GET interrupted by network change; retrying.", flush=True)
            page.wait_for_timeout(250)


def main():
    origin = os.environ["APPROVAL_TEST_ORIGIN"]
    password = os.environ["APPROVAL_TEST_PASSWORD"]
    ids = json.loads(os.environ["APPROVAL_TEST_REQUESTS"])
    ca = os.environ["APPROVAL_TEST_CA"]
    # Playwright's APIRequestContext is a separate Node TLS client, not Chromium.
    os.environ["NODE_EXTRA_CA_CERTS"] = ca
    artifacts = pathlib.Path(os.environ["APPROVAL_TEST_ARTIFACTS"])
    artifacts.mkdir(parents=True, exist_ok=True)
    # Trust only this disposable CA in a new browser user's NSS database.
    # No OS trust changes, blanket TLS bypass, or existing browser profile.
    with tempfile.TemporaryDirectory(prefix="psst-browser-home-") as home:
        nss = pathlib.Path(home) / ".pki" / "nssdb"
        nss.mkdir(parents=True)
        subprocess.run(["certutil", "-N", "-d", "sql:" + str(nss), "--empty-password"], check=True, capture_output=True)
        subprocess.run(["certutil", "-A", "-d", "sql:" + str(nss), "-n", "psst-disposable-ci", "-t", "C,,", "-i", ca], check=True, capture_output=True)
        with sync_playwright() as p:
            options = {"headless": True, "env": {**os.environ, "HOME": home}}
            if os.environ.get("APPROVAL_TEST_CHROMIUM"):
                options["executable_path"] = os.environ["APPROVAL_TEST_CHROMIUM"]
            # Official Playwright defaults, only in the disposable synthetic CI job.
            # This does not assert Chromium sandbox enablement or alter host security.
            browser = p.chromium.launch(**options)
            try:
                context = browser.new_context(ignore_https_errors=False)
                page = context.new_page()
                response = initial_login_page(page, origin + "/admin")
                assert response and response.status == 200
                assert "www-authenticate" not in response.headers
                field = page.locator('input[name="password"]')
                assert field.get_attribute("type") == "password"
                page.screenshot(path=str(artifacts / "01-login-empty.png"), full_page=True)
                # Wrong password must not grant any session or reveal credentials.
                field.fill("synthetic-wrong-password")
                with page.expect_response(lambda r: r.url.endswith("/admin/login") and r.request.method == "POST") as invalid:
                    page.locator('form[action="/admin/login"]').locator('button, input[type="submit"]').first.click()
                assert invalid.value.request.headers.get("origin") == origin, "Browser form must retain the exact same-origin Origin header"
                assert invalid.value.status == 401, "Wrong password must reach password verification, not fail the Origin/CSRF guard"
                page.goto(origin + "/admin")
                field = page.locator('input[name="password"]')
                before_login = {c["name"]: c["value"] for c in context.cookies(origin + "/admin")}
                field.fill(password)
                with page.expect_response(lambda r: r.url.endswith("/admin/login") and r.request.method == "POST") as valid:
                    page.locator('form[action="/admin/login"]').locator('button, input[type="submit"]').first.click()
                assert valid.value.request.headers.get("origin") == origin
                assert valid.value.status == 303, "Valid login must redirect to the authenticated admin page"
                page.wait_for_url(origin + "/admin")
                page.locator('[data-request-id="' + ids[0] + '"]').wait_for()
                cookies = context.cookies(origin + "/admin")
                assert any(c["secure"] and c["httpOnly"] and c["sameSite"] == "Strict" for c in cookies)
                assert any(c["value"] != before_login.get(c["name"]) for c in cookies), "Login must rotate the prelogin session"
                assert password not in page.content()
                page.screenshot(path=str(artifacts / "02-pending-approval.png"), full_page=True)
                approval = "/admin/requests/" + ids[0] + "/approve"
                csrf = page.locator('form[action="' + approval + '"] input[name="csrf"]').get_attribute("value")
                # The browser session cookie alone must not authorize mutation.
                assert context.request.post(origin + approval, form={"csrf": "invalid"}, headers={"Origin": origin}).status == 403
                assert context.request.post(origin + approval, form={"csrf": csrf}, headers={"Origin": "https://untrusted.invalid"}).status == 403
                assert context.request.post(origin + approval, form={"csrf": csrf}).status == 403
                for request_id, action in [(ids[0], "approve"), (ids[1], "deny"), (ids[2], "approve"), (ids[2], "revoke")]:
                    form = page.locator('form[action="/admin/requests/' + request_id + '/' + action + '"]')
                    assert form.locator('input[name="csrf"]').get_attribute("value")
                    form.locator('button, input[type="submit"]').first.click()
                    page.wait_for_load_state("domcontentloaded")
                assert password not in page.content()
                for request_id, state in [(ids[0], "approved"), (ids[1], "denied"), (ids[2], "revoked")]:
                    assert_approval_state(page, request_id, state)
                page.screenshot(path=str(artifacts / "03-approved-denied-revoked.png"), full_page=True)
                # Only the separate private temp file carries a synthetic cookie.
                # Never upload this file or write it to the screenshot directory.
                session_file = os.environ["APPROVAL_TEST_SESSION_FILE"]
                with open(session_file, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                    json.dump(context.cookies(origin + "/admin"), output)
                print("Actual browser form login, approve, deny and explicit revoke passed; TLS verified.")
            finally:
                browser.close()


if __name__ == "__main__":
    main()
