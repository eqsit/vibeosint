"""Offline auxiliary engine regressions: synthetic data, no real network."""
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("reliability_engine", ROOT / "workspace/osint_engine.py")
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


def denied(*args, **kwargs):
    raise AssertionError("Network forbidden in engine reliability tests")


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.stack = self.enterContext(__import__('contextlib').ExitStack())
        for obj, name in ((socket.socket, 'connect'), (socket, 'getaddrinfo'),
                          (e.urllib.request, 'urlopen'),
                          (e.requests.sessions.Session, 'request'),
                          (e.dns.resolver, 'resolve'), (e.whois, 'whois'),
                          (e.subprocess, 'run')):
            self.stack.enter_context(patch.object(obj, name, denied))
        self.stack.enter_context(patch.object(e, '_serper_key', return_value='FIXTURE-KEY'))

    def test_phone_propagates_search_errors_and_unavailable_status(self):
        failures = [['serper-google', 'fixture timeout'], ['searxng', 'fixture offline']]
        with patch.object(e, 'search_web', return_value={'results': [], 'errors': failures}):
            result = e.lookup_phone('+12025550123')
        self.assertEqual(result['web_footprint'], [])
        self.assertEqual(result.get('search_errors'), failures * 2)
        self.assertEqual(result['checks']['search']['status'], 'unavailable')
        self.assertTrue(result['errors'])

    def test_email_dependency_failures_are_unavailable_not_negative(self):
        failures = [['serper-google', 'fixture timeout']]
        cases = [FileNotFoundError('fixture missing'),
                 subprocess.TimeoutExpired('holehe', 25),
                 types.SimpleNamespace(returncode=7, stdout='[+] untrusted.invalid', stderr='fixture')]
        for case in cases:
            with self.subTest(case=type(case).__name__):
                run = {'side_effect': case} if isinstance(case, Exception) else {'return_value': case}
                with patch.object(e.subprocess, 'run', **run), \
                     patch.object(e.dns.resolver, 'resolve', side_effect=e.dns.resolver.LifetimeTimeout()), \
                     patch.object(e, 'search_web', return_value={'results': [], 'errors': failures}):
                    result = e.lookup_email('nobody@example.invalid')
                self.assertEqual(result['registered_services'], [])
                self.assertEqual(result['mx_records'], [])
                self.assertEqual(result.get('search_errors'), failures)
                for component in ('holehe', 'mx', 'search'):
                    self.assertEqual(result['checks'][component]['status'], 'unavailable')
                self.assertTrue(result['checks']['holehe']['error'])
                self.assertTrue(result['checks']['mx']['error'])
                self.assertGreaterEqual(len(result['errors']), 3)

    def test_domain_propagates_dns_whois_and_search_failures(self):
        failures = [['searxng', 'fixture offline']]
        with patch.object(e.whois, 'whois', side_effect=TimeoutError('fixture whois timeout')), \
             patch.object(e.dns.resolver, 'resolve', side_effect=e.dns.resolver.LifetimeTimeout()), \
             patch.object(e, 'search_web', return_value={'results': [], 'errors': failures}):
            result = e.lookup_domain('example.invalid')
        self.assertEqual(result.get('search_errors'), failures)
        self.assertEqual(result['dns'], {})
        for component in ('whois', 'dns', 'search'):
            self.assertEqual(result['checks'][component]['status'], 'unavailable')
        self.assertEqual(set(result['dns_checks']), {'A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA'})
        for check in result['dns_checks'].values():
            self.assertEqual(check['status'], 'unavailable')
            self.assertIn('LifetimeTimeout', check['error'])
        self.assertEqual(len(result['errors']), 9)

    def test_dns_negative_answers_differ_from_unavailable_and_not_checked(self):
        completed = types.SimpleNamespace(returncode=0, stdout='120 websites checked in 1 seconds', stderr='')
        empty_whois = types.SimpleNamespace(registrar=None, creation_date=None, expiration_date=None,
                                            name_servers=[], org=None, country=None)
        with patch.object(e.subprocess, 'run', return_value=completed), \
             patch.object(e, 'search_web', return_value={'results': [], 'errors': []}), \
             patch.object(e.dns.resolver, 'resolve', side_effect=e.dns.resolver.NoAnswer()), \
             patch.object(e.whois, 'whois', return_value=empty_whois):
            email = e.lookup_email('nobody@example.invalid')
            domain = e.lookup_domain('example.invalid')
            missing_domain = e.lookup_email('synthetic-invalid-email')
        self.assertEqual(email['checks']['mx']['status'], 'not-found')
        self.assertEqual(email['checks']['holehe']['status'], 'not-found')
        self.assertEqual(email['checks']['search']['status'], 'not-found')
        self.assertEqual(email['errors'], [])
        self.assertEqual(missing_domain['checks']['mx']['status'], 'not-checked')
        self.assertEqual(domain['checks']['whois']['status'], 'not-found')
        self.assertEqual(domain['checks']['dns']['status'], 'not-found')
        self.assertTrue(all(c['status'] == 'not-found' for c in domain['dns_checks'].values()))
        self.assertEqual(domain['errors'], [])

    def test_ddg_http200_challenge_is_unavailable(self):
        for html in ('<form id="challenge-form">Unfortunately, bots use DuckDuckGo too.</form>',
                     '<form action="/anomaly.js"><input name="captcha"></form>'):
            with self.subTest(html=html), patch.object(e.urllib.request, 'urlopen', return_value=io.BytesIO(html.encode())):
                result = e.search_web('site:example.invalid "точная фраза"', engines='duckduckgo')
            self.assertEqual(result['results'], [])
            self.assertTrue(result['errors'])
            self.assertEqual(result['errors'][0][0], 'duckduckgo')
            self.assertEqual(result['status'], 'unavailable')

    def response(self, url, text='', status=200, headers=None):
        response = e.requests.Response()
        response.status_code = status
        response.url = url
        response.headers.update({'Content-Type': 'text/html; charset=utf-8', **(headers or {})})
        response.encoding = 'utf-8'
        response._content = text.encode('utf-8')
        response._content_consumed = True
        return response

    def test_fetch_preserves_redirect_provenance_and_explicit_text_limit(self):
        start, final = 'https://example.invalid/start', 'https://example.invalid/landing'
        html = '<title>Landing</title><body>' + 'Ж' * 9000 + ' END-MARKER</body>'
        replies = [self.response(start, status=302, headers={'Location': final}), self.response(final, html)]
        with patch.object(e.requests.Session, 'get', side_effect=replies):
            result = e.fetch_page(start)
        self.assertEqual(result['url'], final)
        self.assertEqual(result['requested_url'], start)
        self.assertEqual(result['status'], 200)
        self.assertEqual(result['title'], 'Landing')
        self.assertEqual(len(result['text']), 8000)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['original_length'], len('Landing\n' + 'Ж' * 9000 + ' END-MARKER'))
        self.assertFalse(result['full_text_available'])
        self.assertTrue(result['limited'])
        self.assertIn('max_chars', result['limitation'])

    def test_fetch_bounds_decoded_response_even_without_content_length(self):
        url = 'https://example.invalid/large'
        response = self.response(url, 'X' * 1000)
        consumed = []
        def chunks(chunk_size):
            for offset in range(0, 1000, chunk_size):
                chunk = b'X' * min(chunk_size, 1000 - offset)
                consumed.append(len(chunk))
                yield chunk
        response.iter_content = chunks
        with patch.object(e, 'MAX_FETCH_BYTES', 64, create=True), \
             patch.object(e.requests.Session, 'get', return_value=response) as get:
            result = e.fetch_page(url)
        self.assertTrue(get.call_args.kwargs.get('stream'))
        self.assertTrue(result['response_truncated'])
        self.assertTrue(result['truncated'])
        self.assertTrue(result['limited'])
        self.assertIsNone(result['original_length'])
        self.assertEqual(result['bytes_read'], 64)
        self.assertEqual(result['max_response_bytes'], 64)
        self.assertLessEqual(sum(consumed), 65)
        self.assertEqual(result['text'], 'X' * 64)
        self.assertFalse(result['full_text_available'])
        self.assertIn('response', result['limitation'].lower())

    def test_fetch_http_errors_keep_final_status_and_are_not_documents(self):
        start, final = 'https://example.invalid/start', 'https://example.invalid/denied'
        for status in (403, 404, 429, 500, 503):
            with self.subTest(status=status):
                response = self.response(final, '<title>Error</title>NOT SOURCE CONTENT', status=status)
                with patch.object(e.requests.Session, 'get', side_effect=[
                        self.response(start, status=302, headers={'Location': final}), response]), \
                     patch.object(response, 'iter_content', side_effect=AssertionError('must not read error page')):
                    result = e.fetch_page(start)
                self.assertEqual(result['url'], final)
                self.assertEqual(result['requested_url'], start)
                self.assertEqual(result.get('status'), status)
                self.assertIn('HTTP ' + str(status), result.get('error', ''))
                self.assertFalse(result.get('text'))

    def test_search_rejects_zero_and_shifted_cli_limit_with_json_error(self):
        import contextlib
        import runpy
        for limit in (0, -1, True, 1.5, 'bing', ''):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                e.search_web('fixture', limit=limit, engines='bing')
        for args in (['search', 'fixture', '0', 'bing'], ['search', 'fixture', 'bing']):
            output = io.StringIO()
            with self.subTest(args=args), patch.object(sys, 'argv', [str(ROOT / 'workspace/osint_engine.py'), *args]), \
                 contextlib.redirect_stdout(output):
                runpy.run_path(str(ROOT / 'workspace/osint_engine.py'), run_name='__main__')
            result = json.loads(output.getvalue())
            self.assertIn('limit', result.get('error', ''))
            self.assertEqual(result['status'], 'unavailable')
            self.assertEqual(result['results'], [])

    def test_holehe_empty_or_rate_limited_output_is_not_a_clean_negative(self):
        for stdout, status, services in [('', 'unavailable', []),
                ('[x] fixture.invalid\n1 websites checked in 1 seconds', 'unavailable', []),
                ('[+] service.invalid\n[x] fixture.invalid\n2 websites checked in 1 seconds', 'partial', ['service.invalid'])]:
            completed = types.SimpleNamespace(returncode=0, stdout=stdout, stderr='')
            with self.subTest(status=status, stdout=stdout), \
                 patch.object(e.subprocess, 'run', return_value=completed), \
                 patch.object(e.dns.resolver, 'resolve', side_effect=e.dns.resolver.NXDOMAIN()), \
                 patch.object(e, 'search_web', return_value={'results': [], 'errors': []}):
                result = e.lookup_email('nobody@example.invalid')
            self.assertEqual(result['checks']['holehe']['status'], status)
            self.assertEqual(result['registered_services'], services)
            self.assertTrue(result['errors'])

    def test_serper_error_payload_is_unavailable_not_a_clean_zero(self):
        for payload in ({'error': 'fixture failure', 'statusCode': 500}, {'organic': 'malformed'}):
            with self.subTest(payload=payload), patch.object(e.urllib.request, 'urlopen',
                    return_value=io.BytesIO(json.dumps(payload).encode())):
                result = e.search_web('fixture', engines='serper')
            self.assertEqual(result['status'], 'unavailable')
            self.assertTrue(result['errors'])
            self.assertEqual(result['results'], [])

    def test_unparseable_phone_marks_search_not_checked(self):
        with patch.object(e, 'search_web') as search:
            result = e.lookup_phone('synthetic-invalid-phone')
        self.assertTrue(result['error'])
        self.assertEqual(result.get('checks', {}).get('search', {}).get('status'), 'not-checked')
        search.assert_not_called()

    def test_residential_redirect_cannot_escape_to_private_destination(self):
        url, private = 'https://example.invalid/start', 'http://127.0.0.1/private'
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        private_addr = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 80))]
        def addresses(host, *args, **kwargs):
            return private_addr if host == '127.0.0.1' else public
        with patch.object(socket, 'getaddrinfo', side_effect=addresses), \
             patch.object(e.requests.Session, 'get', return_value=self.response(url, status=302,
                       headers={'Location': private})) as get:
            result = e.fetch_page(url, network='residential')
        self.assertEqual(get.call_count, 1)
        self.assertIn('private', result['error'])
        self.assertEqual(result['requested_url'], url)
        self.assertEqual(result['url'], private)
        self.assertIsNone(result['status'])  # No HTTP response was received from the blocked target.
        self.assertEqual(get.call_args.kwargs['proxies'], {'http': e.RESIDENTIAL_PROXY, 'https': e.RESIDENTIAL_PROXY})

    def test_query_operators_and_unicode_are_forwarded_literally(self):
        query = 'site:example.invalid "точная фраза" OR inurl:a -b filetype:pdf #x & y + z'
        for engine in ('serper', 'bing', 'duckduckgo'):
            captured = []
            def open_fixture(req, **kwargs):
                if engine == 'serper':
                    captured.append(json.loads(req.data)['q'])
                    payload = json.dumps({'organic': [{'link': 'https://example.invalid/result'}]}).encode()
                elif engine == 'bing':
                    captured.append(e.urllib.parse.parse_qs(e.urllib.parse.urlsplit(req.full_url).query)['q'][0])
                    payload = json.dumps({'results': [{'url': 'https://example.invalid/result', 'engine': 'bing'}]}).encode()
                else:
                    captured.append(e.urllib.parse.parse_qs(req.data.decode())['q'][0])
                    payload = b'<a class="result-link" href="https://example.invalid/result">Fixture</a>'
                return io.BytesIO(payload)
            with self.subTest(engine=engine), patch.object(e.urllib.request, 'urlopen', side_effect=open_fixture):
                result = e.search_web(query, limit=1, engines=engine)
            self.assertEqual(captured, [query])
            self.assertEqual(result['query'], query)
            self.assertEqual(result['count'], 1)
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(result['errors'], [])

    def test_ddg_clean_empty_results_are_not_found(self):
        with patch.object(e.urllib.request, 'urlopen', return_value=io.BytesIO(b'<html>No results found</html>')):
            result = e.search_web('fixture', engines='duckduckgo')
        self.assertEqual(result['status'], 'not-found')
        self.assertEqual(result['errors'], [])

    def test_phone_search_partial_results_keep_errors_and_deduplicate(self):
        hit = {'url': 'https://example.invalid/fact', 'source': 'fixture'}
        error = ['fixture', 'rate limited']
        with patch.object(e, 'search_web', return_value={'results': [hit], 'errors': [error]}):
            result = e.lookup_phone('+12025550123')
        self.assertEqual(result['checks']['search']['status'], 'partial')
        self.assertEqual(result['web_footprint'], [hit])
        self.assertEqual(result['search_errors'], [error, error])

    def test_lookup_raised_search_errors_do_not_erase_other_components(self):
        completed = types.SimpleNamespace(returncode=0, stdout='[+] service.invalid', stderr='')
        w = types.SimpleNamespace(registrar='Fixture', creation_date=None, expiration_date=None,
                                  name_servers=[], org=None, country=None)
        def dns_fixture(domain, rtype, **kwargs):
            if rtype == 'A':
                return ['203.0.113.9']
            raise e.dns.resolver.LifetimeTimeout()
        with patch.object(e.subprocess, 'run', return_value=completed), \
             patch.object(e, 'search_web', side_effect=TimeoutError('fixture search failure')), \
             patch.object(e.dns.resolver, 'resolve', side_effect=dns_fixture), \
             patch.object(e.whois, 'whois', return_value=w):
            phone = e.lookup_phone('+12025550123')
            email = e.lookup_email('nobody@example.invalid')
            domain = e.lookup_domain('example.invalid')
        for result in (phone, email, domain):
            self.assertEqual(result['checks']['search']['status'], 'unavailable')
            self.assertTrue(result['search_errors'])
        self.assertIn('e164', phone)
        self.assertEqual(email['registered_services'], ['service.invalid'])
        self.assertEqual(email['checks']['holehe']['status'], 'ok')
        self.assertEqual(domain['dns']['A'], ['203.0.113.9'])
        self.assertEqual(domain['checks']['dns']['status'], 'partial')
        self.assertEqual(domain['checks']['whois']['status'], 'ok')

    def test_residential_proxy_failure_never_retries_direct(self):
        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))]
        def offline(session, url, **kwargs):
            self.assertFalse(session.trust_env)
            raise e.requests.exceptions.ProxyError('fixture proxy offline')
        with patch.object(socket, 'getaddrinfo', return_value=public), \
             patch.object(e.requests.Session, 'get', autospec=True, side_effect=offline) as get:
            result = e.fetch_page('https://example.invalid/', network='residential')
        self.assertEqual(get.call_count, 1)
        self.assertIn('no direct fallback', result['error'])
        self.assertIsNone(result['status'])
        self.assertEqual(get.call_args.kwargs['proxies'], {'http': e.RESIDENTIAL_PROXY, 'https': e.RESIDENTIAL_PROXY})

    def test_residential_private_addresses_are_rejected_before_http(self):
        for address in ('127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1'):
            with self.subTest(address=address), \
                 patch.object(socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 443))]), \
                 patch.object(e.requests.Session, 'get') as get:
                result = e.fetch_page('https://example.invalid/', network='residential')
            self.assertIn('private', result['error'])
            get.assert_not_called()

    def test_fetch_short_document_is_complete(self):
        url = 'https://example.invalid/short'
        with patch.object(e.requests.Session, 'get', return_value=self.response(url, '<title>Коротко</title><body>Текст</body>')):
            result = e.fetch_page(url)
        self.assertEqual(result['text'], 'Коротко\nТекст')
        self.assertFalse(result['truncated'])
        self.assertFalse(result['response_truncated'])
        self.assertFalse(result['limited'])
        self.assertTrue(result['full_text_available'])
        self.assertEqual(result['original_length'], len(result['text']))

    def test_ddg_captcha_title_is_unavailable_without_false_positive_snippets(self):
        captcha = b'<html><title>CAPTCHA verification</title><body>Verify you are human</body></html>'
        with patch.object(e.urllib.request, 'urlopen', return_value=io.BytesIO(captcha)):
            result = e.search_web('fixture', engines='duckduckgo')
        self.assertEqual(result['status'], 'unavailable')
        html = b'<a class="result-link" href="https://example.invalid/captcha">CAPTCHA research</a>'
        with patch.object(e.urllib.request, 'urlopen', return_value=io.BytesIO(html)):
            result = e.search_web('captcha', engines='duckduckgo')
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['count'], 1)

    def test_fetch_final_url_uses_response_url_not_prepared_request_spelling(self):
        requested = 'https://EXAMPLE.INVALID/page'
        final = 'https://example.invalid/page'
        with patch.object(e.requests.Session, 'get', return_value=self.response(final, 'Fixture')):
            result = e.fetch_page(requested)
        self.assertEqual(result['requested_url'], requested)
        self.assertEqual(result['url'], final)


if __name__ == '__main__':
    unittest.main(verbosity=2)
