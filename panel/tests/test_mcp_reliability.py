"""Offline MCP reliability regressions: isolated storage, fixture-only subprocesses."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


class MCPReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='mcp-reliability-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.data = self.root / 'data' / 'sessions'
        self.env = patch.dict(os.environ, {
            'OSINT_DATA_DIR': str(self.data),
            'OSINT_UPLOADS_DIR': str(self.root / 'data' / 'uploads'),
            'PANEL_WORKSPACE_DIR': str(self.workspace),
            'HERMES_HOME': str(self.root / 'hermes-home'),
        }, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        spec = importlib.util.spec_from_file_location('mcp_reliability_subject', ROOT / 'server' / 'mcp_osint.py')
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        for target in ('socket.socket.connect', 'socket.create_connection', 'socket.getaddrinfo',
                       'urllib.request.urlopen', 'urllib.request.OpenerDirector.open'):
            guard = patch(target, side_effect=AssertionError('network forbidden in reliability tests'))
            guard.start()
            self.addCleanup(guard.stop)
        self.sid = 'ses_reliability'
        self.session = self.data / (self.sid + '.json')
        self.session.write_text(json.dumps({'id': self.sid, 'title': 'Fixture', 'report': '', 'logs': []}))

    def saved(self):
        return json.loads(self.session.read_text())

    def seed_section(self, rows, evidence=None):
        section = {'name': 'Facts', 'columns': ['Fact'], 'rows': rows}
        if evidence is not None:
            section['rowEvidence'] = evidence
        doc = self.saved()
        doc['reportState'] = {'title': 'Fixture', 'sections': [section]}
        self.session.write_text(json.dumps(doc))

    def test_legacy_equal_length_shifted_source_is_not_cited_after_title_mutation(self):
        # Reachable legacy sequence: seed A/B without evidence, add C/source-C,
        # then remove B/C while the old helper leaves rowEvidence untouched.
        self.seed_section([['A'], ['B']])
        doc = self.saved()
        sec = doc['reportState']['sections'][0]
        sec['rows'].append(['C'])
        stale = [{'source': 'https://example.invalid/source-C', 'recordedAt': 123,
                  'status': 'source-provided-not-independently-verified', 'raw': {'fixture': 'keep'}}]
        sec['rowEvidence'] = stale
        sec['rows'] = [row for row in sec['rows'] if row[0] not in ('B', 'C')]
        self.assertEqual(len(sec['rows']), len(sec['rowEvidence']))
        self.session.write_text(json.dumps(doc))
        self.m.osint_report_set_title(self.sid, 'Legacy title mutation')
        saved = self.saved()
        self.assertIn('| A |', saved['report'])
        self.assertNotIn('https://example.invalid/source-C', saved['report'])
        self.assertNotIn('https://example.invalid/source-C', self.m.osint_report_get(self.sid))
        sec = saved['reportState']['sections'][0]
        self.assertEqual(sec['rowEvidence'][0]['source'], '')
        self.assertEqual(sec['rowEvidence'][0]['status'], 'missing-source')
        self.assertEqual(sec['unboundRowEvidence'][0]['rowEvidence'], stale)

    def assert_bound_section(self, sec):
        self.assertEqual(len(sec['rows']), len(sec['rowEvidence']))
        for row, evidence in zip(sec['rows'], sec['rowEvidence']):
            self.assertIn('binding', evidence)
            self.assertEqual(evidence['binding']['version'], 1)
            payload = json.dumps({'row': row, 'source': evidence['source']},
                                 ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            self.assertEqual(evidence['binding']['sha256'], hashlib.sha256(payload).hexdigest())

    def test_new_evidence_binds_row_and_source_atomically_across_mutations(self):
        snapshots = []
        real_save = self.m._save_session
        def save(sid, doc):
            sec = doc['reportState']['sections'][0]
            self.assert_bound_section(sec)
            snapshots.append([(row, evidence['source']) for row, evidence in zip(sec['rows'], sec['rowEvidence'])])
            return real_save(sid, doc)
        with patch.object(self.m, '_save_session', save):
            self.m.osint_report_add(self.sid, 'Facts', [['A'], ['B']], ['Fact'],
                                    ['https://example.invalid/A', 'user-provided'])
            self.m.osint_report_replace(self.sid, 'Facts', 'A', ['A-new'], sources=['https://example.invalid/A-new'])
            self.m.osint_report_remove(self.sid, 'Facts', 'B')
            self.m.osint_report_set_title(self.sid, 'Bound title')
        self.assertEqual(snapshots, [
            [(['A'], 'https://example.invalid/A'), (['B'], 'user-provided')],
            [(['A-new'], 'https://example.invalid/A-new'), (['B'], 'user-provided')],
            [(['A-new'], 'https://example.invalid/A-new')],
            [(['A-new'], 'https://example.invalid/A-new')],
        ])
        self.assertNotIn('unboundRowEvidence', self.saved()['reportState']['sections'][0])
        self.assertNotIn('https://example.invalid/A (', self.saved()['report'])
        self.assertIn('Источник строки 1: https://example.invalid/A-new', self.m.osint_report_get(self.sid))

    def test_bound_evidence_follows_reordered_rows_at_equal_count(self):
        self.m.osint_report_add(self.sid, 'Facts', [['A'], ['B']], ['Fact'],
                                ['https://example.invalid/A', 'https://example.invalid/B'])
        doc = self.saved()
        sec = doc['reportState']['sections'][0]
        original_evidence = sec['rowEvidence'][:]
        sec['rows'].reverse()
        self.assertEqual(len(sec['rows']), len(sec['rowEvidence']))
        self.session.write_text(json.dumps(doc))
        result = self.m.osint_report_get(self.sid)
        self.assertIn('Источник строки 1: https://example.invalid/B', result)
        self.assertIn('Источник строки 2: https://example.invalid/A', result)
        self.assertNotIn('Источник строки 1: https://example.invalid/A', result)
        self.m.osint_report_set_title(self.sid, 'Reordered')
        sec = self.saved()['reportState']['sections'][0]
        self.assert_bound_section(sec)
        self.assertEqual(sec['rowEvidence'], list(reversed(original_evidence)))
        self.assertNotIn('unboundRowEvidence', sec)
        self.m.osint_report_remove(self.sid, 'Facts', 'A')
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual(sec['rows'], [['B']])
        self.assertEqual(sec['rowEvidence'], [original_evidence[1]])

    def test_markdown_bound_sources_follow_rows_not_stale_footer_numbers(self):
        self.m.osint_report_add(self.sid, 'Facts', [['A'], ['B']], ['Fact'],
                                ['https://example.invalid/A', 'user-provided'])
        doc = self.saved()
        doc.pop('reportState')
        doc['report'] = doc['report'].replace('| A |\n| B |', '| B |\n| A |')
        self.session.write_text(json.dumps(doc))
        self.m.osint_report_set_title(self.sid, 'Markdown reordered')
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual(sec['rows'], [['B'], ['A']])
        self.assertEqual([e['source'] for e in sec['rowEvidence']], ['user-provided', 'https://example.invalid/A'])
        self.assert_bound_section(sec)
        self.assertIn('Источник строки 1: user-provided', self.saved()['report'])
        self.assertIn('Источник строки 2: https://example.invalid/A', self.m.osint_report_get(self.sid))

    def test_markdown_roundtrip_preserves_escaped_cells_and_source_bindings(self):
        self.m.osint_report_add(self.sid, 'Facts', [['А | Б\nстрока', r'C:\fixture'], ['suffix|', '']],
                                ['Fact', 'Value'], ['https://example.invalid/source|A', 'user-provided'])
        doc = self.saved()
        expected_rows = doc['reportState']['sections'][0]['rows']
        expected_sources = [e['source'] for e in doc['reportState']['sections'][0]['rowEvidence']]
        doc.pop('reportState')
        self.session.write_text(json.dumps(doc))
        self.m.osint_report_set_title(self.sid, 'Escaped roundtrip')
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual(sec['rows'], expected_rows)
        self.assertEqual([e['source'] for e in sec['rowEvidence']], expected_sources)
        self.assert_bound_section(sec)
        self.assertNotIn('unboundRowEvidence', sec)
        self.m.osint_report_replace(self.sid, 'Facts', 'suffix', ['replacement|', ''], sources=['user-provided'])
        self.m.osint_report_remove(self.sid, 'Facts', 'replacement')
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual(sec['rows'], expected_rows[:1])
        self.assertEqual([e['source'] for e in sec['rowEvidence']], expected_sources[:1])
        self.assert_bound_section(sec)

    def test_bound_evidence_rejects_row_source_hash_or_version_mutations(self):
        self.m.osint_report_add(self.sid, 'Facts', [['A'], ['B']], ['Fact'],
                                ['https://example.invalid/A', 'https://example.invalid/B'])
        original = self.saved()
        for mutation in ('row', 'source', 'hash', 'version', 'bool-version', 'unversioned'):
            with self.subTest(mutation=mutation):
                doc = json.loads(json.dumps(original))
                sec = doc['reportState']['sections'][0]
                item = sec['rowEvidence'][0]
                if mutation == 'row':
                    sec['rows'][0] = ['Unrelated fact']
                elif mutation == 'source':
                    item['source'] = 'https://example.invalid/unrelated'
                elif mutation == 'hash':
                    item['binding']['sha256'] = '0' * 64
                elif mutation == 'version':
                    item['binding']['version'] = 2
                elif mutation == 'bool-version':
                    item['binding']['version'] = True
                else:
                    item.pop('binding')
                rejected = json.loads(json.dumps(sec['rowEvidence']))
                self.session.write_text(json.dumps(doc))
                before = self.session.read_bytes()
                result = self.m.osint_report_get(self.sid)
                self.assertEqual(self.session.read_bytes(), before, 'get must not write migration state')
                self.assertNotIn('Источник строки 1:', result)
                self.assertIn('Источник строки 2: https://example.invalid/B', result)
                self.m.osint_report_set_title(self.sid, 'Changed binding')
                sec = self.saved()['reportState']['sections'][0]
                self.assertEqual([e['source'] for e in sec['rowEvidence']], ['', 'https://example.invalid/B'])
                self.assertEqual(sec['rowEvidence'][0]['status'], 'missing-source')
                self.assert_bound_section(sec)
                self.assertEqual(sec['unboundRowEvidence'][0]['rowEvidence'], rejected)
                quarantine = sec['unboundRowEvidence']
                self.m.osint_report_set_title(self.sid, 'Second migration is idempotent')
                self.assertEqual(self.saved()['reportState']['sections'][0]['unboundRowEvidence'], quarantine)
                self.assertNotIn('https://example.invalid/unrelated', self.saved()['report'])

    def test_unversioned_reordered_equal_count_recovers_only_actual_inline_source(self):
        stale = [{'source': 'https://example.invalid/A-other'}, {'source': 'https://example.invalid/B'}]
        self.seed_section([['B'], ['A https://example.invalid/A']], stale)
        before = self.session.read_bytes()
        result = self.m.osint_report_get(self.sid)
        self.assertNotIn('Источник строки 1:', result)
        self.assertIn('Источник строки 2: https://example.invalid/A (', result)
        self.assertNotIn('https://example.invalid/A-other', result)
        self.assertNotIn('https://example.invalid/B', result)
        self.assertEqual(self.session.read_bytes(), before)
        self.m.osint_report_set_title(self.sid, 'Safe inline recovery')
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual([e['source'] for e in sec['rowEvidence']], ['', 'https://example.invalid/A'])
        self.assert_bound_section(sec)
        self.assertEqual(sec['unboundRowEvidence'][0]['rowEvidence'], stale)
        quarantine = sec['unboundRowEvidence']
        self.m.osint_report_add(self.sid, 'Facts', [['C']], sources=['user-provided'])
        self.m.osint_report_remove(self.sid, 'Facts', 'B')
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual([e['source'] for e in sec['rowEvidence']], ['https://example.invalid/A', 'user-provided'])
        self.assertEqual(sec['unboundRowEvidence'], quarantine)
        self.assert_bound_section(sec)

    def test_markdown_rejects_unversioned_or_modified_source_bindings(self):
        self.m.osint_report_add(self.sid, 'Facts', [['A'], ['B']], ['Fact'],
                                ['https://example.invalid/A', 'https://example.invalid/B'])
        original = self.saved()
        digest = original['reportState']['sections'][0]['rowEvidence'][0]['binding']['sha256']
        marker = '<!-- osint-evidence:v1:' + digest + ' -->'
        for mutation in ('unversioned', 'row', 'source', 'hash', 'version', 'malformed'):
            with self.subTest(mutation=mutation):
                doc = json.loads(json.dumps(original))
                doc.pop('reportState')
                md = doc['report']
                if mutation == 'unversioned':
                    md = md.replace(' ' + marker, '')
                elif mutation == 'row':
                    md = md.replace('| A |', '| Unrelated fact |')
                elif mutation == 'source':
                    md = md.replace('https://example.invalid/A', 'https://example.invalid/unrelated')
                elif mutation == 'hash':
                    md = md.replace(digest, '0' * 64)
                elif mutation == 'version':
                    md = md.replace(marker, marker.replace(':v1:', ':v2:'))
                else:
                    md = md.replace(marker, '<!-- osint-evidence:broken -->')
                doc['report'] = md
                self.session.write_text(json.dumps(doc))
                self.m.osint_report_set_title(self.sid, 'Safe markdown import')
                saved = self.saved()
                sec = saved['reportState']['sections'][0]
                self.assertEqual([e['source'] for e in sec['rowEvidence']], ['', 'https://example.invalid/B'])
                self.assert_bound_section(sec)
                self.assertIn('unboundRowEvidence', sec)
                self.assertNotIn('Источник строки 1:', saved['report'])
                self.assertNotIn('https://example.invalid/unrelated', saved['report'])
                self.assertIn('Источник строки 2: https://example.invalid/B', self.m.osint_report_get(self.sid))

    def test_markdown_roundtrip_keeps_separator_shaped_facts_bound(self):
        self.m.osint_report_add(self.sid, 'Facts', [['---', ':::'], ['A', '']], ['Fact', 'Value'],
                                ['https://example.invalid/dashes', 'user-provided'])
        doc = self.saved()
        expected = doc.pop('reportState')['sections'][0]
        self.session.write_text(json.dumps(doc))
        self.m.osint_report_set_title(self.sid, 'Separator-shaped fact')
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual(sec['rows'], expected['rows'])
        self.assertEqual([e['source'] for e in sec['rowEvidence']], [e['source'] for e in expected['rowEvidence']])
        self.assert_bound_section(sec)
        self.assertNotIn('unboundRowEvidence', sec)

    def test_sources_visible_in_saved_markdown_and_get(self):
        self.m.osint_report_add(self.sid, 'Facts', [['A']], ['Fact'], ['https://example.invalid/source-A'])
        self.assertIn('https://example.invalid/source-A', self.saved()['report'])
        self.assertIn('https://example.invalid/source-A', self.m.osint_report_get(self.sid))
        self.assertIn('не проверен независимо', self.saved()['report'])

    def test_add_aligns_legacy_and_malformed_evidence_without_guessing_sources(self):
        for evidence in (None, [], [{'source': 'https://example.invalid/possibly-stale'}],
                         [{'source': 'https://example.invalid/stale'}] * 3, [None, None]):
            with self.subTest(evidence=evidence):
                self.seed_section([['legacy'], ['https://example.invalid/inline']], evidence)
                result = self.m.osint_report_add(self.sid, 'Facts', [['new']], sources=['user-provided'])
                self.assertTrue(result.startswith('Добавлено строк: 1.'), result)
                sec = self.saved()['reportState']['sections'][0]
                self.assertEqual(len(sec['rows']), len(sec['rowEvidence']))
                self.assertTrue(all(isinstance(e, dict) for e in sec['rowEvidence']))
                self.assertEqual([e['source'] for e in sec['rowEvidence']],
                                 ['', 'https://example.invalid/inline', 'user-provided'])
                self.assertEqual(sec['rowEvidence'][0]['status'], 'missing-source')
                self.assertNotIn('possibly-stale', self.saved()['report'])

    def test_replace_rejects_unsourced_row_without_reusing_old_evidence(self):
        self.seed_section([['old']], [{'source': 'https://example.invalid/old', 'recordedAt': 1}])
        before = self.session.read_bytes()
        result = self.m.osint_report_replace(self.sid, 'Facts', 'old', ['new'])
        self.assertNotIn('Заменено:', result)
        self.assertIn('источник', result)
        self.assertEqual(self.session.read_bytes(), before)

    def test_replace_updates_optional_sources_and_aligns_legacy_evidence(self):
        import inspect
        self.assertIn('sources', inspect.signature(self.m.osint_report_replace).parameters)
        for evidence in (None, [], [{'source': 'https://example.invalid/old', 'recordedAt': 1}, {}]):
            with self.subTest(evidence=evidence):
                self.seed_section([['old'], ['legacy']], evidence)
                result = self.m.osint_report_replace(self.sid, 'Facts', 'old', ['new'],
                                                    sources=['https://example.invalid/new'])
                self.assertIn('Заменено:', result)
                sec = self.saved()['reportState']['sections'][0]
                self.assertEqual(len(sec['rows']), len(sec['rowEvidence']))
                self.assertEqual(sec['rowEvidence'][0]['source'], 'https://example.invalid/new')
                self.assertGreater(sec['rowEvidence'][0]['recordedAt'], 1)
                self.assertEqual(sec['rowEvidence'][1]['source'], '')
                self.assertNotIn('https://example.invalid/old', self.saved()['report'])
                self.assertIn('https://example.invalid/new', self.m.osint_report_get(self.sid))
        before = self.session.read_bytes()
        for sources in ([], ['ftp://example.invalid/x'], ['one', 'two'], 'https://example.invalid/x'):
            result = self.m.osint_report_replace(self.sid, 'Facts', 'new', ['no'], sources=sources)
            self.assertNotIn('Заменено:', result)
            self.assertEqual(self.session.read_bytes(), before)

    def test_replace_uses_new_inline_source_not_old_source(self):
        self.seed_section([['old']], [{'source': 'https://example.invalid/old'}])
        self.m.osint_report_replace(self.sid, 'Facts', 'old', ['https://example.invalid/new'])
        evidence = self.saved()['reportState']['sections'][0]['rowEvidence']
        self.assertEqual(evidence[0]['source'], 'https://example.invalid/new')

    def test_remove_keeps_only_evidence_for_surviving_rows_in_one_write(self):
        for evidence in (None, [], [{'source': 'https://example.invalid/A'},
                                    {'source': 'https://example.invalid/B'},
                                    {'source': 'https://example.invalid/C'}]):
            with self.subTest(evidence=evidence):
                self.seed_section([['A'], ['B'], ['C']], evidence)
                before = self.saved()
                seen = []
                real_save = self.m._save_session
                def save(sid, doc):
                    self.assertEqual(self.saved(), before)
                    sec = doc['reportState']['sections'][0]
                    self.assertIn('rowEvidence', sec)
                    self.assertEqual(len(sec['rows']), len(sec['rowEvidence']))
                    seen.append(doc)
                    return real_save(sid, doc)
                with patch.object(self.m, '_save_session', save):
                    self.m.osint_report_remove(self.sid, 'Facts', 'B')
                sec = self.saved()['reportState']['sections'][0]
                self.assertEqual(len(seen), 1)
                self.assertEqual(sec['rows'], [['A'], ['C']])
                # These unversioned external URLs do not prove any row binding.
                self.assertEqual([e['source'] for e in sec['rowEvidence']], ['', ''])
                self.assert_bound_section(sec)
                if evidence:
                    self.assertEqual(sec['unboundRowEvidence'][0]['rowEvidence'], evidence)
                    self.assertNotIn('https://example.invalid/', self.saved()['report'])
                self.m.osint_report_remove(self.sid, 'Facts', 'A')
                self.m.osint_report_remove(self.sid, 'Facts', 'C')
                self.assertEqual(self.saved()['reportState']['sections'][0]['rowEvidence'], [])

    def test_rendered_sources_survive_markdown_only_legacy_roundtrip(self):
        self.m.osint_report_add(self.sid, 'Facts', [['A']], ['Fact'], ['user-provided'])
        doc = self.saved()
        doc.pop('reportState')
        self.session.write_text(json.dumps(doc))
        self.m.osint_report_add(self.sid, 'Facts', [['B']], sources=['https://example.invalid/B'])
        sec = self.saved()['reportState']['sections'][0]
        self.assertEqual([e['source'] for e in sec['rowEvidence']], ['user-provided', 'https://example.invalid/B'])

    def test_get_does_not_render_ambiguous_stale_evidence(self):
        self.seed_section([['survivor']], [{'source': 'https://example.invalid/removed'}, {'source': 'https://example.invalid/survivor'}])
        self.assertNotIn('https://example.invalid/removed', self.m.osint_report_get(self.sid))

    def test_workspace_image_alias_and_host_path_share_canonical_confinement(self):
        payload = b'\x89PNG\r\n\x1a\nfixture'
        image = self.workspace / 'nested' / 'image.png'
        image.parent.mkdir()
        image.write_bytes(payload)
        for name in (str(image), '/workspace/nested/image.png'):
            with self.subTest(path=name):
                try:
                    actual = self.m._fetch_image_bytes(name)
                except ValueError as exc:
                    self.fail(f'configured workspace image rejected: {exc}')
                self.assertEqual(actual, (payload, 'png'))
        outside = self.root / 'outside.png'
        outside.write_bytes(payload)
        (self.workspace / 'escape.png').symlink_to(outside)
        (self.workspace / 'safe.png').symlink_to(image)
        self.assertEqual(self.m._fetch_image_bytes('/workspace/safe.png'), (payload, 'png'))
        for name in ('/workspace/../outside.png', '/workspace/escape.png', str(self.workspace / 'escape.png'),
                     str(outside), '/workspace-other/outside.png', '/workspace/nested/../../outside.png'):
            with self.subTest(blocked=name), self.assertRaises(ValueError):
                self.m._fetch_image_bytes(name)

    def test_hermes_upload_images_use_only_known_mounted_directories(self):
        home = Path(os.environ['HERMES_HOME'])
        payload = b'GIF89afixture'
        for relative in ('attachments', 'images', 'cache/images'):
            root = home / relative
            root.mkdir(parents=True)
            (root / 'upload.gif').write_bytes(payload)
            try:
                actual = self.m._fetch_image_bytes('/root/.hermes/' + relative + '/upload.gif')
            except ValueError as exc:
                self.fail(f'known mounted upload rejected: {exc}')
            self.assertEqual(actual, (payload, 'gif'))
            (root / 'escape.gif').symlink_to(self.session)
            with self.assertRaises(ValueError):
                self.m._fetch_image_bytes('/root/.hermes/' + relative + '/escape.gif')
            with self.assertRaises(ValueError):
                self.m._fetch_image_bytes('/root/.hermes/' + relative + '/../upload.gif')
        unmounted = home / 'uploads'
        unmounted.mkdir()
        (unmounted / 'upload.gif').write_bytes(payload)
        for name in ('/root/.hermes/uploads/upload.gif', '/root/.hermes/skills/private.gif',
                     '/root/.hermes/attachments-evil/upload.gif'):
            with self.assertRaises(ValueError):
                self.m._fetch_image_bytes(name)

    def test_remote_image_fetch_does_not_hold_session_mutation_lock(self):
        observations = []
        real_save = self.m._save_session
        def fetch(image):
            self.assertFalse((self.data / '.locks' / (self.sid + '.lock')).exists())
            self.m.osint_report_set_title(self.sid, 'updated-during-fetch')
            observations.append('fetched')
            return b'GIF89afixture', 'gif'
        def save(sid, doc):
            self.assertTrue((self.data / '.locks' / (self.sid + '.lock')).is_dir())
            return real_save(sid, doc)
        with patch.object(self.m, '_fetch_image_bytes', fetch), patch.object(self.m, '_save_session', save):
            result = self.m.osint_report_attach_image(self.sid, 'https://example.invalid/photo.gif', 'fixture')
        self.assertIn('Изображение добавлено', result)
        self.assertEqual(observations, ['fetched'])
        self.assertEqual(self.saved()['reportState']['title'], 'updated-during-fetch')
        self.assertEqual(len(self.saved()['reportState']['sections'][0]['items']), 1)
        self.assertFalse((self.data / '.locks' / (self.sid + '.lock')).exists())

    def engine_fixture(self, body):
        script = self.root / 'fixture_engine.py'
        script.write_text('import json, os, sys, time\n' + body)
        self.m.ENGINE_SCRIPT = str(script)

    def test_engine_nonzero_exit_is_error_with_bounded_scrubbed_stderr(self):
        self.engine_fixture('print(json.dumps({"results": []}))\n'
                            'print("fixture failure api_key=FIXTURE_TOKEN Authorization: Bearer FIXTURE_BEARER " + "x" * 9000, file=sys.stderr)\n'
                            'sys.exit(17)\n')
        with patch.dict(os.environ, {'OSINT_VISION_KEY': 'FIXTURE_TOKEN'}):
            result = json.loads(self.m._run_engine('fail', 'fixture'))
        self.assertIn('error', result)
        self.assertEqual(result['returncode'], 17)
        self.assertIn('fixture failure', result['stderr'])
        self.assertLessEqual(len(result['stderr']), 1600)
        self.assertNotIn('FIXTURE_TOKEN', result['stderr'])
        self.assertNotIn('FIXTURE_BEARER', result['stderr'])
        self.assertNotIn('results', result)

    def test_engine_empty_and_malformed_output_are_explicit_json_errors(self):
        for body, error in (('print(" ")\n', 'empty engine output'),
                            ('print("fixture noise, not JSON")\n', 'malformed engine JSON')):
            with self.subTest(case=error):
                self.engine_fixture(body + 'print("fixture diagnostic token=FIXTURE_SECRET", file=sys.stderr)\n')
                raw = self.m._run_engine('fixture', 'fixture')
                try:
                    result = json.loads(raw)
                except json.JSONDecodeError:
                    self.fail('engine wrapper returned non-JSON output')
                self.assertEqual(result.get('error'), error)
                self.assertIn('fixture diagnostic', result.get('stderr', ''))
                self.assertNotIn('FIXTURE_SECRET', raw)

    def test_engine_timeout_is_explicit_and_does_not_echo_query(self):
        self.engine_fixture('print("fixture timeout api_key=FIXTURE_TIMEOUT", file=sys.stderr, flush=True)\ntime.sleep(.4)\nprint("{}")\n')
        with patch.object(self.m, '_ENGINE_TIMEOUT_SECONDS', .08, create=True):
            result = json.loads(self.m._run_engine('slow', 'FIXTURE_PRIVATE_QUERY'))
        self.assertEqual(result.get('error'), 'engine process timeout')
        self.assertEqual(result.get('timeout_seconds'), .08)
        self.assertIn('fixture timeout', result.get('stderr', ''))
        self.assertNotIn('FIXTURE_TIMEOUT', json.dumps(result))
        self.assertNotIn('FIXTURE_PRIVATE_QUERY', json.dumps(result))

    def test_long_engine_json_is_structurally_trimmed_with_accessible_full_result(self):
        import hashlib
        fixtures = ({'results': [{'text': 'ф' * 18000}]},
                    {'results': [{'name': str(i), 'nested': [{'text': 'x' * 3000}] * 5} for i in range(35)]},
                    ['x' * 16000], 'x' * 16000)
        for fixture in fixtures:
            with self.subTest(kind=type(fixture).__name__):
                self.engine_fixture('print(json.dumps(' + repr(fixture) + ', ensure_ascii=False))\n')
                raw = self.m._run_engine('long', 'fixture')
                try:
                    result = json.loads(raw)
                except json.JSONDecodeError:
                    self.fail('long engine JSON was corrupted by wrapper truncation')
                self.assertTrue(result.get('truncated'))
                self.assertIn('result', result)
                self.assertLessEqual(len(raw), 15000)
                meta = result['full_result']
                saved = Path(meta['path'])
                self.assertTrue(saved.resolve().is_relative_to(self.workspace.resolve()))
                self.assertEqual(json.loads(saved.read_text()), fixture)
                self.assertEqual(meta['bytes'], len(saved.read_bytes()))
                self.assertEqual(meta['sha256'], hashlib.sha256(saved.read_bytes()).hexdigest())
                self.assertEqual(meta['sandbox_path'], '/workspace/' + str(saved.relative_to(self.workspace)))
                self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
                self.assertGreater(meta['chars'], 15000)

    def test_long_result_storage_cannot_escape_project_via_symlink(self):
        outside = self.root / 'outside-results'
        outside.mkdir()
        (self.workspace / 'reports').symlink_to(outside, target_is_directory=True)
        self.engine_fixture('print(json.dumps({"text": "x" * 16000}))\n')
        result = json.loads(self.m._run_engine('long', 'fixture'))
        self.assertIn('error', result)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertNotIn('full_result', result)

    def test_engine_optional_session_identity_is_forwarded_and_cleared(self):
        import inspect
        self.assertIn('session_id', inspect.signature(self.m._run_engine).parameters)
        self.engine_fixture('print(json.dumps({"sid": os.environ.get("OSINT_SESSION_ID"), "argv": sys.argv[1:]}))\n')
        with patch.dict(os.environ, {'OSINT_SESSION_ID': 'ses_wrong_parent'}):
            result = json.loads(self.m._run_engine('lazyapi', 'fixture', session_id=self.sid))
            self.assertEqual(result['sid'], self.sid)
            self.assertEqual(json.loads(self.m._run_engine('phone', 'fixture'))['sid'], '')
            self.assertEqual(os.environ['OSINT_SESSION_ID'], 'ses_wrong_parent')
        result = json.loads(self.m._run_engine('lazyapi', 'fixture', session_id='../unsafe'))
        self.assertIn('error', result)

    def test_engine_positional_compatibility_preserves_zero_and_engine_slot(self):
        self.engine_fixture('print(json.dumps({"argv": sys.argv[1:]}))\n')
        self.assertEqual(json.loads(self.m._run_engine('search', 'fixture', 0, 'bing'))['argv'],
                         ['search', 'fixture', '0', 'bing'])
        self.assertEqual(json.loads(self.m._run_engine('search', 'fixture', '', 'bing'))['argv'],
                         ['search', 'fixture', '', 'bing'])

    def test_all_engine_backed_tools_forward_their_explicit_session(self):
        self.engine_fixture('print(json.dumps({"status": 200, "text": "ip=203.0.113.1\\nloc=ZZ"}))\n')
        calls = [lambda: self.m.osint_search('fixture', session_id=self.sid),
                 lambda: self.m.osint_search('fixture', session_id=self.sid, engines='bing'),
                 lambda: self.m.osint_fetch_page('https://example.invalid', self.sid),
                 lambda: self.m.osint_residential_status(self.sid),
                 lambda: self.m.osint_check_phone('fixture', self.sid),
                 lambda: self.m.osint_check_username('fixture', self.sid),
                 lambda: self.m.osint_check_email('fixture', self.sid),
                 lambda: self.m.osint_check_domain('fixture', self.sid),
                 lambda: self.m.osint_check_ip('fixture', self.sid),
                 lambda: self.m.osint_lazyapi_query('fixture', self.sid)]
        real_run = self.m.subprocess.run
        sessions = []
        def run(*args, **kwargs):
            sessions.append(kwargs.get('env', {}).get('OSINT_SESSION_ID'))
            return real_run(*args, **kwargs)
        with patch.object(self.m.subprocess, 'run', run):
            for call in calls:
                call()
        self.assertEqual(sessions, [self.sid] * len(calls))

    def test_lazyapi_schema_describes_project_pool_and_serialization(self):
        description = self.m.osint_lazyapi_query.__doc__
        self.assertIn('10', description)
        self.assertIn('per-account', description)
        self.assertIn('cross-process', description)
        self.assertNotIn('single account', description)
        self.assertNotRegex(description, r'\d{6,}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
