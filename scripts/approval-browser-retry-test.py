"""Focused deterministic checks: only the initial GET network-change is retried."""
import importlib.util
import pathlib
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("approval_browser", pathlib.Path(__file__).with_name("approval-browser-smoke.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
URL = "https://127.0.0.1:12345/admin"


class ApprovalStateTests(unittest.TestCase):
    def test_scopes_assertion_to_exact_request_status_badge(self):
        page = Mock()
        with patch.object(module, "expect") as expect:
            module.assert_approval_state(page, "synthetic-request", "approved")
        page.locator.assert_called_once_with('[data-request-id="synthetic-request"]')
        page.locator.return_value.locator.assert_called_once_with('.badge')
        expect.assert_called_once_with(page.locator.return_value.locator.return_value)
        pattern = expect.return_value.to_have_text.call_args.args[0]
        for text in ["approved", "Approved", " APPROVED "]:
            self.assertIsNotNone(pattern.fullmatch(text))
        for text in ["pending", "denied", "unapproved", "approved-looking client"]:
            self.assertIsNone(pattern.fullmatch(text))

    def test_each_final_state_remains_distinct(self):
        for state in ["approved", "denied", "revoked"]:
            with self.subTest(state=state), patch.object(module, "expect") as expect:
                module.assert_approval_state(Mock(), "synthetic-request", state)
                pattern = expect.return_value.to_have_text.call_args.args[0]
                self.assertIsNotNone(pattern.fullmatch(state.capitalize()))
                for other in {"approved", "denied", "revoked", "pending"} - {state}:
                    self.assertIsNone(pattern.fullmatch(other))


class InitialNavigationTests(unittest.TestCase):
    def changed(self):
        return module.PlaywrightError("Page.goto: net::ERR_NETWORK_CHANGED at " + URL)

    def test_success_never_retried(self):
        page = Mock()
        self.assertIs(module.initial_login_page(page, URL), page.goto.return_value)
        page.goto.assert_called_once_with(URL)
        page.wait_for_timeout.assert_not_called()

    def test_transient_network_change_then_success(self):
        result = object()
        page = Mock()
        page.goto.side_effect = [self.changed(), self.changed(), result]
        self.assertIs(module.initial_login_page(page, URL), result)
        self.assertEqual(page.goto.call_count, 3)
        self.assertEqual(page.wait_for_timeout.call_args_list, [unittest.mock.call(250)] * 2)

    def test_three_attempts_exhausted_raises(self):
        page = Mock()
        page.goto.side_effect = self.changed()
        with self.assertRaises(module.PlaywrightError):
            module.initial_login_page(page, URL)
        self.assertEqual(page.goto.call_count, 3)
        self.assertEqual(page.wait_for_timeout.call_count, 2)

    def test_other_failures_never_retried(self):
        for error in [module.PlaywrightError("Page.goto: net::ERR_CERT_AUTHORITY_INVALID at " + URL),
                      module.PlaywrightError("Page.goto: Timeout 30000ms exceeded"),
                      module.PlaywrightError("Page.goto: net::ERR_NETWORK_CHANGED_OTHER at " + URL),
                      module.PlaywrightError("Page.click: net::ERR_NETWORK_CHANGED at " + URL),
                      AssertionError("authentication failed"), RuntimeError("net::ERR_NETWORK_CHANGED")]:
            with self.subTest(error=type(error).__name__ + str(error)):
                page = Mock()
                page.goto.side_effect = error
                with self.assertRaises(type(error)):
                    module.initial_login_page(page, URL)
                page.goto.assert_called_once_with(URL)
                page.wait_for_timeout.assert_not_called()

    def test_http_failure_not_retried_or_accepted(self):
        response = Mock(status=401)
        page = Mock()
        page.goto.return_value = response
        self.assertIs(module.initial_login_page(page, URL), response)
        page.goto.assert_called_once_with(URL)
        page.wait_for_timeout.assert_not_called()
        # Existing caller still requires HTTP200; this helper never overrides it.
        self.assertNotEqual(response.status, 200)


if __name__ == "__main__":
    unittest.main()
