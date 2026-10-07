import importlib.util
import io
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'tools' / 'prepare-rule-import.py'
SPEC = importlib.util.spec_from_file_location('rule_import_prepare', SCRIPT)
PREP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREP)


def cell(ref, value):
    return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'


class RuleImportPrepareTests(unittest.TestCase):
    def test_reads_selected_sheet_and_preserves_numeric_clause_gaps(self):
        parts = {
            'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="题目录入表" sheetId="1" r:id="rId1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>',
            'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="3">'
                + cell('A3', '安全测试') + cell('AB3', '放置') + cell('AD3', 'https://swaroopg92.github.io/penpa-edit/#m=edit&amp;p=encoded')
                + cell('AF3', '{&quot;0&quot;:&quot;第一条&quot;,&quot;2&quot;:&quot;第三条&quot;}') + cell('AI3', '作者')
                + '</row></sheetData></worksheet>'
        }
        with tempfile.TemporaryDirectory(prefix='puzarchive-xlsx-fixture-') as temp_dir:
            workbook = Path(temp_dir) / 'fixture.xlsx'
            with zipfile.ZipFile(workbook, 'w', zipfile.ZIP_DEFLATED) as archive:
                for name, content in parts.items():
                    archive.writestr(name, content)
            rows = PREP.read_workbook(workbook)
            self.assertEqual(rows[3][1], '安全测试')
            record, error = PREP.parse_row(3, rows[3], 'AD')
            self.assertIsNone(error)
            self.assertEqual(record['rulesZh'], ['第一条', '第三条'])
            self.assertEqual(record['category'], '置物')
            self.assertEqual(record['rulesEn'], [])
            self.assertFalse(record['isVariant'])
            self.assertEqual(record['exampleAuthor'], '作者')
            self.assertTrue(PREP.trusted_final_url(record['exampleUrl']))

    def test_rejects_dtd_entities_and_untrusted_short_redirect(self):
        with self.assertRaisesRegex(ValueError, 'DTD/entity'):
            PREP.safe_xml(b'<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>', 'fixture')

        class RedirectToPrivate:
            def open(self, request, timeout):
                raise urllib.error.HTTPError(request.full_url, 302, 'redirect', {'Location': 'https://untrusted.example/private?secret=hidden'}, io.BytesIO())

        previous = PREP.OPENER
        PREP.OPENER = RedirectToPrivate()
        try:
            result, reason = PREP.resolve_tiny_url('https://tinyurl.com/safe-code')
            self.assertIsNone(result)
            self.assertEqual(reason, 'redirect_untrusted:https://untrusted.example')
            self.assertNotIn('secret', reason)
        finally:
            PREP.OPENER = previous

    def test_fragment_payload_must_match_penpa_query_shape(self):
        self.assertTrue(PREP.trusted_final_url('https://swaroopg92.github.io/penpa-edit/#m=edit&p=encoded'))
        self.assertTrue(PREP.trusted_final_url('https://penpa-edit.com/#m=solve&p=encoded'))
        self.assertTrue(PREP.trusted_final_url('https://opt-pan.github.io/pedit-v2/?m=edit&p=encoded'))
        self.assertTrue(PREP.trusted_final_url('https://opt-pan.github.io/penpa-edit/#m=edit&p=encoded'))
        self.assertFalse(PREP.trusted_final_url('https://swaroopg92.github.io/penpa-edit/#section'))
        self.assertFalse(PREP.trusted_final_url('https://swaroopg92.github.io/penpa-edit/#m=edit&p=%20'))
        self.assertFalse(PREP.trusted_final_url('http://127.0.0.1:4173/#m=edit&p=secret'))

    def test_head_501_falls_back_to_get_and_upgrades_only_trusted_http_penpa(self):
        class Head501ThenRedirect:
            def __init__(self):
                self.requests = []

            def open(self, request, timeout):
                self.requests.append((request.full_url, request.get_method()))
                if len(self.requests) == 1:
                    raise urllib.error.HTTPError(request.full_url, 501, 'unsupported', {}, io.BytesIO())
                raise urllib.error.HTTPError(request.full_url, 302, 'redirect', {'Location': 'http://opt-pan.github.io/pedit-v2/#m=edit&p=encoded'}, io.BytesIO())

        fake = Head501ThenRedirect()
        previous = PREP.OPENER
        PREP.OPENER = fake
        try:
            result, reason = PREP.resolve_tiny_url('https://tinyurl.com/safe-code')
            self.assertEqual(result, 'https://opt-pan.github.io/pedit-v2/#m=edit&p=encoded')
            self.assertEqual(reason, 'http_penpa_upgraded')
            self.assertEqual([method for _, method in fake.requests], ['HEAD', 'GET'])
            self.assertTrue(all((urllib.parse.urlsplit(url).hostname or '') == 'tinyurl.com' for url, _ in fake.requests))
        finally:
            PREP.OPENER = previous

    def test_english_only_and_empty_fields_are_retained_as_drafts(self):
        record, error = PREP.parse_row(212, {2: 'English title', 28: '路径', 32: '', 30: '——', 35: ''}, 'AD')
        self.assertIsNone(error)
        self.assertEqual(record['titleZh'], '')
        self.assertEqual(record['rulesZh'], [])
        self.assertEqual(record['exampleUrl'], '')
        self.assertEqual(record['exampleAuthor'], '')
        self.assertEqual(PREP.parse_row(213, {28: '路径'}, 'AD')[1], 'missing_both_names')

    def test_network_layer_failure_is_not_an_invalid_link(self):
        class NetworkTimeout:
            def open(self, request, timeout):
                raise urllib.error.URLError(TimeoutError('network unavailable'))

        previous = PREP.OPENER
        PREP.OPENER = NetworkTimeout()
        try:
            result, reason = PREP.resolve_tiny_url('https://tinyurl.com/safe-code')
            self.assertIsNone(result)
            self.assertEqual(reason, 'network_unavailable')
        finally:
            PREP.OPENER = previous

    def test_malformed_url_syntax_is_a_row_level_invalidity(self):
        self.assertIsNone(PREP.safe_urlsplit('https://[broken-host/path'))
        self.assertIsNone(PREP.safe_urlsplit('https://example.com:invalid/p'))
        self.assertIsNotNone(PREP.safe_urlsplit('https://swaroopg92.github.io/penpa-edit/#m=edit&p=ok'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
