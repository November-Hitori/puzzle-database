#!/usr/bin/env python3
"""Safely prepare a private PuzArchive rules payload from the calendar workbook."""
import argparse
import concurrent.futures
import json
import os
import posixpath
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {
    'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'rel': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'pkg': 'http://schemas.openxmlformats.org/package/2006/relationships',
}
MAX_FILE = 64 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_XML = 48 * 1024 * 1024
PLACEHOLDERS = {'——', '—', '-', '–'}
CATEGORY_MAP = {'涂黑': '涂黑', '填数': '填数', '分区': '分区', '放置': '置物', '路径': '路径', '其他': '其它'}
TINY_HOST = 'tinyurl.com'
TRUSTED_HOSTS = {'penpa-edit.com', 'opt-pan.github.io', 'swaroopg92.github.io'}
MAX_EXAMPLE_URL = 4096


def safe_xml(data, label):
    if len(data) > MAX_XML:
        raise ValueError(f'{label} exceeds the XML size limit')
    if re.search(br'<!\s*(DOCTYPE|ENTITY)', data, re.I):
        raise ValueError(f'{label} contains a forbidden DTD/entity declaration')
    return ET.fromstring(data)


def col_number(reference):
    letters = re.match(r'([A-Z]+)', reference.upper())
    if not letters:
        return 0
    number = 0
    for char in letters.group(1):
        number = number * 26 + ord(char) - 64
    return number


def normalized_title(value):
    return ' '.join(unicodedata.normalize('NFKC', value).strip().split())


def safe_urlsplit(value):
    try:
        parsed = urllib.parse.urlsplit(value if '://' in value else 'https://' + value)
        _ = parsed.port
        return parsed
    except (TypeError, ValueError):
        return None


def cell_text(cell, strings):
    kind = cell.get('t')
    if kind == 'inlineStr':
        return ''.join(node.text or '' for node in cell.findall('.//main:t', NS))
    value = cell.find('main:v', NS)
    if value is None or value.text is None:
        return ''
    if kind == 's':
        try:
            return strings[int(value.text)]
        except (ValueError, IndexError):
            return ''
    if kind == 'b':
        return 'TRUE' if value.text == '1' else 'FALSE'
    return value.text


def get_sheet(archive, wanted):
    workbook = safe_xml(archive.read('xl/workbook.xml'), 'workbook.xml')
    rels_root = safe_xml(archive.read('xl/_rels/workbook.xml.rels'), 'workbook relationships')
    rels = {rel.get('Id'): rel.get('Target') for rel in rels_root.findall('pkg:Relationship', NS)}
    sheet_path = None
    for sheet in workbook.findall('main:sheets/main:sheet', NS):
        if sheet.get('name') == wanted:
            target = rels.get(sheet.get(f'{{{NS["rel"]}}}id'))
            if not target or '://' in target or target.startswith('\\'):
                break
            sheet_path = target.lstrip('/') if target.startswith('/') else (target if target.startswith('xl/') else posixpath.join('xl', target))
            normalized = posixpath.normpath(sheet_path)
            if not normalized.startswith('xl/') or normalized.startswith('/'):
                raise ValueError('worksheet relationship escapes workbook')
            sheet_path = normalized
            break
    if not sheet_path:
        raise ValueError(f'worksheet not found: {wanted}')
    return sheet_path


def read_workbook(path):
    file_path = Path(path)
    if file_path.stat().st_size > MAX_FILE:
        raise ValueError('workbook exceeds the compressed file size limit')
    with zipfile.ZipFile(file_path) as archive:
        entries = archive.infolist()
        if len(entries) > 5000 or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
            raise ValueError('workbook exceeds the expanded archive limits')
        if any(entry.file_size > MAX_XML for entry in entries if entry.filename.endswith('.xml')):
            raise ValueError('workbook XML part exceeds the size limit')
        bad = archive.testzip()
        if bad:
            raise ValueError('workbook ZIP integrity check failed')
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            root = safe_xml(archive.read('xl/sharedStrings.xml'), 'shared strings')
            strings = [''.join(node.text or '' for node in item.findall('.//main:t', NS)) for item in root.findall('main:si', NS)]
        sheet_path = get_sheet(archive, '题目录入表')
        root = safe_xml(archive.read(sheet_path), 'target worksheet')
        rows = {}
        for row in root.findall('.//main:sheetData/main:row', NS):
            row_number = int(row.get('r', '0'))
            if row_number < 3 or row_number > 384:
                continue
            values = {}
            for cell in row.findall('main:c', NS):
                col = col_number(cell.get('r', ''))
                if col:
                    values[col] = cell_text(cell, strings)
            rows[row_number] = values
        return rows


def supported_penpa_origin(host, path):
    host = (host or '').lower().rstrip('.')
    pathname = (path or '/').lower()
    if host == 'penpa-edit.com' or host.endswith('.penpa-edit.com'):
        return True
    if host == 'opt-pan.github.io':
        return pathname == '/pedit-v2' or pathname.startswith('/pedit-v2/') or pathname == '/penpa-edit' or pathname.startswith('/penpa-edit/')
    return host == 'swaroopg92.github.io' and (pathname == '/penpa-edit' or pathname.startswith('/penpa-edit/'))


def trusted_final_url(value):
    try:
        url = urllib.parse.urlsplit(value.strip())
        host = (url.hostname or '').lower().rstrip('.')
        if url.scheme != 'https' or url.username or url.password or url.port not in (None, 443):
            return False
        if not supported_penpa_origin(host, url.path):
            return False
        fragment = urllib.parse.parse_qs(url.fragment, keep_blank_values=True)
        has_hash_payload = fragment.get('m', [''])[0] in ('edit', 'solve') and bool(fragment.get('p', [''])[0].strip())
        return bool(url.query or has_hash_payload or url.path not in ('/', '/penpa-edit/', '/pedit-v2/'))
    except ValueError:
        return False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


OPENER = urllib.request.build_opener(NoRedirect())


def resolve_tiny_url(value):
    candidate = value.strip()
    try:
        parsed = urllib.parse.urlsplit(candidate)
        if parsed.scheme == 'http' and (parsed.hostname or '').lower() == TINY_HOST:
            candidate = urllib.parse.urlunsplit(('https', parsed.netloc, parsed.path, parsed.query, parsed.fragment))
            parsed = urllib.parse.urlsplit(candidate)
        if parsed.scheme != 'https' or (parsed.hostname or '').lower() != TINY_HOST or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None, 'unsupported_url_host'
    except ValueError:
        return None, 'invalid_url'

    current = candidate
    for attempt in range(6):
        request = urllib.request.Request(current, method='HEAD', headers={'User-Agent': 'PuzArchiveRuleImport/1.0'})
        try:
            response = OPENER.open(request, timeout=5)
            response.close()
            return None, 'short_url_no_redirect'
        except urllib.error.HTTPError as error:
            location = error.headers.get('Location')
            code = error.code
            error.close()
            if code in (405, 501):
                request = urllib.request.Request(current, method='GET', headers={'User-Agent': 'PuzArchiveRuleImport/1.0', 'Range': 'bytes=0-0'})
                try:
                    response = OPENER.open(request, timeout=5)
                    response.close()
                    return None, 'short_url_no_redirect'
                except urllib.error.HTTPError as get_error:
                    location, code = get_error.headers.get('Location'), get_error.code
                    get_error.close()
                    if code in (408, 425, 429) or 500 <= code <= 599:
                        return None, 'network_unavailable'
                    if code in (405, 501):
                        return None, 'short_url_unresolved'
            elif code in (408, 425, 429) or 500 <= code <= 599:
                return None, 'network_unavailable'
            if code not in (301, 302, 303, 307, 308) or not location:
                return None, 'short_url_unresolved'
            next_url = urllib.parse.urljoin(current, location)
            if trusted_final_url(next_url):
                return next_url, None
            try:
                next_parts = urllib.parse.urlsplit(next_url)
                next_port = next_parts.port
            except ValueError:
                return None, 'redirect_untrusted'
            next_host = (next_parts.hostname or '').lower().rstrip('.')
            if next_parts.scheme == 'http' and (next_host in TRUSTED_HOSTS or next_host == 'penpa-edit.com' or next_host.endswith('.penpa-edit.com')) and next_port in (None, 80) and not next_parts.username and not next_parts.password:
                upgraded = urllib.parse.urlunsplit(('https', next_host, next_parts.path, next_parts.query, next_parts.fragment))
                if trusted_final_url(upgraded):
                    return upgraded, 'http_penpa_upgraded'
            # Redirect hops are permitted only while still on the one approved shortener.
            if next_parts.scheme != 'https' or (next_parts.hostname or '').lower() != TINY_HOST or next_parts.username or next_parts.password or next_port not in (None, 443):
                host = next_host if re.fullmatch(r'[a-z0-9.-]{1,253}', next_host) else 'invalid-host'
                scheme = next_parts.scheme if next_parts.scheme in ('http', 'https') else 'unknown'
                return None, f'redirect_untrusted:{scheme}://{host}'
            current = next_url
        except (urllib.error.URLError, TimeoutError, OSError):
            return None, 'network_unavailable'
        except ValueError:
            return None, 'short_url_unresolved'
    return None, 'redirect_limit'


def parse_af(value):
    if not value.strip():
        return []
    try:
        decoded = json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(decoded, dict) or not decoded:
        return None
    keys = list(decoded)
    if any(not isinstance(key, str) or not re.fullmatch(r'\d+', key) for key in keys):
        return None
    try:
        keys.sort(key=int)
    except ValueError:
        return None
    if len({int(key) for key in keys}) != len(keys):
        return None
    clauses = [decoded[key] for key in keys]
    if len(clauses) > 30 or any(not isinstance(item, str) or len(item.strip()) > 1000 for item in clauses):
        return None
    normalized = [item.strip() for item in clauses if item.strip()]
    return normalized or None


def parse_row(row_number, values, link_column):
    zh = values.get(1, '').strip()
    en = values.get(2, '').strip()
    category = values.get(28, '').strip()
    rules = parse_af(values.get(32, '').strip())
    example_author = values.get(35, '').strip()
    link_col = 30 if link_column == 'AD' else 31
    raw_url = values.get(link_col, '').strip()
    if not zh and not en:
        return None, 'missing_both_names'
    if len(zh) > 160 or len(en) > 160 or len(example_author) > 200:
        return None, 'field_too_long'
    if category not in CATEGORY_MAP:
        return None, 'invalid_category'
    if rules is None:
        return None, 'invalid_rules_json'
    if not raw_url or raw_url in PLACEHOLDERS:
        raw_url = ''
    return {
        'sourceRow': row_number,
        'titleZh': zh,
        'titleEn': en,
        'rulesZh': rules,
        'rulesEn': [],
        'category': CATEGORY_MAP[category],
        'isVariant': False,
        'baseRuleId': None,
        'exampleUrl': raw_url,
        'exampleAuthor': example_author,
    }, None


def conflict_keys(records):
    keys = ('rulesZh', 'rulesEn', 'category', 'titleEn', 'exampleUrl', 'exampleAuthor')
    result = {name: False for name in keys}
    for name in keys:
        result[name] = len({json.dumps(record.get(name), ensure_ascii=False, sort_keys=True) for record in records}) > 1
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workbook', required=True, help='path to the private .xlsx workbook')
    parser.add_argument('--link-column', required=True, choices=('AD', 'AE'), help='explicit workbook column to use for the Penpa example URL')
    parser.add_argument('--payload', required=True, help='new private JSON payload path; must not already exist')
    parser.add_argument('--report', required=True, help='new private JSON report path; must not already exist')
    args = parser.parse_args()
    payload_path, report_path = Path(args.payload), Path(args.report)
    if payload_path.exists() or report_path.exists() or payload_path.resolve() == report_path.resolve():
        raise ValueError('payload/report paths must be distinct and must not already exist')
    rows = read_workbook(args.workbook)
    prepared = []
    skipped = {}
    skipped_rows = []
    def note_skip(row_number, reason):
        skipped[reason] = skipped.get(reason, 0) + 1
        skipped_rows.append({'row': row_number, 'reason': reason})

    raw_urls = {}
    for row_number in range(3, 385):
        record, reason = parse_row(row_number, rows.get(row_number, {}), args.link_column)
        if reason:
            note_skip(row_number, reason)
            continue
        prepared.append(record)
        if record['exampleUrl']:
            raw_urls[record['exampleUrl']] = raw_urls.get(record['exampleUrl'], []) + [record]

    resolved = {}
    targets = []
    for raw in raw_urls:
        parsed = safe_urlsplit(raw)
        if parsed is not None and (parsed.hostname or '').lower() == TINY_HOST:
            targets.append(raw)
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(resolve_tiny_url, url): url for url in targets}
        for future in concurrent.futures.as_completed(futures):
            resolved[futures[future]] = future.result()
    network_errors = sum(1 for _, reason in resolved.values() if reason == 'network_unavailable')
    if network_errors:
        raise RuntimeError(f'{network_errors} TinyURL lookups failed at the network layer; no payload was written. Check connectivity and retry.')
    link_failures = {}
    oversized_urls = 0
    max_resolved_url_chars = 0
    http_upgraded_rows = []
    valid = []
    for record in prepared:
        raw = record['exampleUrl']
        if not raw:
            valid.append(record)
            continue
        parsed = safe_urlsplit(raw)
        if parsed is None:
            note_skip(record['sourceRow'], 'invalid_url_syntax')
            continue
        if (parsed.hostname or '').lower() == TINY_HOST:
            final, reason = resolved.get(raw, (None, 'short_url_unresolved'))
            if not final:
                key = reason or 'short_url_unresolved'
                link_failures[key] = link_failures.get(key, 0) + 1
                note_skip(record['sourceRow'], key)
                continue
            if reason == 'http_penpa_upgraded':
                http_upgraded_rows.append(record['sourceRow'])
            max_resolved_url_chars = max(max_resolved_url_chars, len(final))
            if len(final) > MAX_EXAMPLE_URL:
                oversized_urls += 1
                note_skip(record['sourceRow'], 'example_url_too_long')
                continue
            record = {**record, 'exampleUrl': final}
        elif not trusted_final_url(raw):
            note_skip(record['sourceRow'], 'invalid_or_untrusted_example_url')
            continue
        else:
            max_resolved_url_chars = max(max_resolved_url_chars, len(raw))
            if len(raw) > MAX_EXAMPLE_URL:
                oversized_urls += 1
                note_skip(record['sourceRow'], 'example_url_too_long')
                continue
        valid.append(record)

    by_title = {}
    for record in valid:
        if record['titleZh'].strip():
            key = 'zh:' + normalized_title(record['titleZh'])
        else:
            key = 'en:' + normalized_title(record['titleEn'])
        by_title.setdefault(key, []).append(record)
    chosen, conflict_report = [], []
    for key, group in by_title.items():
        group.sort(key=lambda item: item['sourceRow'])
        winner = group[0]
        chosen.append(winner)
        if len(group) > 1:
            conflicts = conflict_keys(group)
            if any(conflicts.values()):
                conflict_report.append({'dedupeKey': key, 'chosenRow': winner['sourceRow'], 'discardedRows': [item['sourceRow'] for item in group[1:]], 'conflicts': conflicts})
            for discarded in group[1:]:
                note_skip(discarded['sourceRow'], 'duplicate_rule_title')
    chosen.sort(key=lambda item: item['sourceRow'])
    report = {
        'workbookSheet': '题目录入表', 'linkColumn': args.link_column,
        'rowRange': [3, 384], 'rowsScanned': 382,
        'parsedRows': len(prepared), 'resolvedRows': len(valid), 'selectedUniqueRows': len(chosen),
        'skippedByReason': skipped, 'duplicateConflictGroups': len(conflict_report),
        'duplicateConflictFields': {key: sum(1 for item in conflict_report if item['conflicts'][key]) for key in ('rulesZh', 'rulesEn', 'category', 'titleEn', 'exampleUrl', 'exampleAuthor')},
        'duplicateConflicts': conflict_report,
        'skippedRows': sorted(skipped_rows, key=lambda item: (item['row'], item['reason'])),
        'tinyUrlCount': len(targets), 'tinyUrlResolutionFailures': link_failures,
        'tinyUrlNetworkRequestCount': len(targets),
        'httpPenpaUpgradeRows': sorted(http_upgraded_rows),
        'overlongResolvedExampleUrls': oversized_urls, 'maxResolvedExampleUrlChars': max_resolved_url_chars,
        'tinyUrlResolutionSeconds': round(time.monotonic() - started, 2),
        'sourceFieldMaxChars': {
            'titleZh': max((len(values.get(1, '').strip()) for values in rows.values()), default=0),
            'titleEn': max((len(values.get(2, '').strip()) for values in rows.values()), default=0),
            'exampleAuthor': max((len(values.get(35, '').strip()) for values in rows.values()), default=0),
            'exampleUrl': max((len(values.get(30 if args.link_column == 'AD' else 31, '').strip()) for values in rows.values()), default=0),
            'rulesZhClause': max((len(clause) for values in rows.values() for clause in (parse_af(values.get(32, '').strip()) or [])), default=0),
        },
    }
    payload = {'format': 'puzarchive-rule-import-v1', 'records': chosen}
    for path, content in ((payload_path, payload), (report_path, report)):
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(content, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.chmod(path, 0o600)
    print(json.dumps({key: value for key, value in report.items() if key != 'duplicateConflicts'}, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
