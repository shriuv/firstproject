
import logging
import re
import os
import sys
import getpass
from typing import List, Optional, Dict, Tuple
from collections import defaultdict

# ── Soft imports (graceful failure) ──────────────────────────────────────────

try:
    import fitz  # PyMuPDF
    FITZ_OK = True
except ImportError:
    FITZ_OK = False

try:
    import pdfplumber
    PDFPLUMBER_OK = True
except ImportError:
    PDFPLUMBER_OK = False

try:
    from PyPDF2 import PdfReader
    PYPDF2_OK = True
except ImportError:
    PYPDF2_OK = False

logger = logging.getLogger("ledgerai.pdf_service")


# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

FOOTER_PHRASES = [
    'this is a computer generated',
    'does not require signature',
    'need not normally be signed',
    'contents of this statement will be',
    'no error is reported within',
    'treated that the entries',
    'please do not share your atm',
    'bank never asks for',
    'if you receive any alerts',
    'registered office address',
    'hdfcbanklimited',
    'closingbalanceincludes',
    'contentsofthisstatement',
    'stateaccountbranchgstn',
    'hdfcbankgstinnumber',
    'stateaccountbranch',
    'cin:',
    'customer care',
    'toll free',
    'end of statement',
    '*** end of',
    'powered by',
    'beware of cyber',
    'nevershare',
    'never share your',
    'scan for',
    'disclaimer',
    'deposit insurance',
    'yes bank gstin',
    'through sms',
    'w.e.f',
    'please refer to the notice',
    'please visit',
]

CID_PATTERN = re.compile(r'\(cid:\d+\)')
HYPHEN_WRAP = re.compile(r'-$')

# Date patterns used in scoring & narration-join detection
DATE_RE = re.compile(
    r'\b(\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4}|\d{4}[/\-]\d{1,2}[/\-]\d{1,2})\b'
)
AMOUNT_RE = re.compile(r'[\d,]+\.\d{2}')

_DATE_ZONE_COLS = 30   # Date occurs in left-most 30 chars of a grid line
_MIN_LEADING    = 1    # Lines with >= 1 leading space are continuation candidates


# ──────────────────────────────────────────────────────────────────────────────
# Continuation Merging Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _has_date_at_left(line: str) -> bool:
    """True when a date-like token appears in the leftmost _DATE_ZONE_COLS chars."""
    return bool(DATE_RE.search(line[:_DATE_ZONE_COLS]))


def _is_cont_line(line: str) -> bool:
    """
    True when *line* is a wrapped-cell continuation:
      - not blank
      - starts with >= _MIN_LEADING spaces  (content not in the date column)
      - no date pattern in the date zone
    """
    if not line.strip():
        return False
    leading = len(line) - len(line.lstrip(' '))
    return leading >= _MIN_LEADING and not _has_date_at_left(line)


def _overlay_lines(group: List[str]) -> str:
    """
    Merge a list of lines by character-grid overlay.
    Lines are processed in order; each grid column takes the *first*
    non-space character encountered across all lines.
    """
    if not group:
        return ''
    if len(group) == 1:
        return group[0]
    max_w = max(len(l) for l in group)
    grid = [' '] * max_w
    for line in group:
        for col, ch in enumerate(line):
            if col < max_w and ch != ' ' and grid[col] == ' ':
                grid[col] = ch
    return ''.join(grid).rstrip()


def _merge_continuation_rows(lines: List[str]) -> List[str]:
    """
    Bank-agnostic fix for wrapped table-cell rows and stacked headers.
    """
    if not lines:
        return lines

    result: List[str] = []
    i, n = 0, len(lines)

    while i < n:
        line = lines[i]

        # ── Stop merging at page breaks or summary blocks ──
        if 'PAGE' in line or 'Opening Balance' in line or 'TOTAL' in line:
            result.append(line)
            i += 1
            continue

        # ── pre-continuation block (continuation lines before any anchor) ──
        if _is_cont_line(line):
            pre: List[str] = []
            while i < n and _is_cont_line(lines[i]):
                pre.append(lines[i])
                i += 1

            if i < n and _has_date_at_left(lines[i]):
                anchor = lines[i]
                i += 1
                post: List[str] = []
                while i < n and _is_cont_line(lines[i]):
                    post.append(lines[i])
                    i += 1
                result.append(_overlay_lines([anchor] + pre + post))
            else:
                # Sparse header handling
                merged_pre = _overlay_lines(pre)
                if result and not _has_date_at_left(result[-1]):
                    result[-1] = _overlay_lines([result[-1], merged_pre])
                else:
                    result.append(merged_pre)

        # ── anchor line ──
        elif _has_date_at_left(line):
            anchor = line
            i += 1
            post = []
            while i < n and _is_cont_line(lines[i]):
                post.append(lines[i])
                i += 1
            if post:
                result.append(_overlay_lines([anchor] + post))
            else:
                result.append(anchor)

        # ── regular line (header / title / footer) ──
        else:
            if result and not _has_date_at_left(result[-1]) and line.strip() and not _has_date_at_left(line):
                result[-1] = _overlay_lines([result[-1], line])
            else:
                result.append(line)
            i += 1

    return [l for l in result if l.strip()]


# ──────────────────────────────────────────────────────────────────────────────
# Cleaning & Scoring helpers
# ──────────────────────────────────────────────────────────────────────────────

def _clean_cid(text: str) -> str:
    return CID_PATTERN.sub('', text)


def _join_hyphen_wraps(lines: List[str]) -> List[str]:
    out: List[str] = []
    for line in lines:
        if out and HYPHEN_WRAP.search(out[-1]):
            out[-1] = out[-1][:-1] + line.lstrip()
        else:
            out.append(line)
    return out


def _remove_footer_lines(lines: List[str]) -> List[str]:
    out = []
    for line in lines:
        ll = line.lower().strip()
        if any(phrase in ll for phrase in FOOTER_PHRASES):
            continue
        out.append(line)
    return out


def _collapse_blank_lines(lines: List[str]) -> List[str]:
    out: List[str] = []
    blanks = 0
    for line in lines:
        stripped = line.rstrip()
        if stripped.strip() == '':
            blanks += 1
            if blanks <= 1:
                out.append('')
        else:
            blanks = 0
            out.append(stripped)
    return out


def _score_text(text: str) -> float:
    if not text or not text.strip():
        return 0.0
    lines = [l for l in text.split('\n') if l.strip()]
    n = len(lines)
    if n == 0: return 0.0

    avg_len = sum(len(l) for l in lines) / n
    if n == 1 and avg_len > 200: return -1000.0
    if avg_len > 300: return -500.0

    date_count = sum(len(DATE_RE.findall(l)) for l in lines)
    amount_count = sum(len(AMOUNT_RE.findall(l)) for l in lines)
    multiword = sum(1 for l in lines if len(l.split()) >= 3)

    return date_count * 10 + amount_count * 5 + multiword * 2 + n * 0.5


# ──────────────────────────────────────────────────────────────────────────────
# Strategy A  — PyMuPDF (fitz)
# ──────────────────────────────────────────────────────────────────────────────

def _fitz_page_text(page_fitz) -> str:
    try:
        words = page_fitz.get_text("words", sort=True)
    except Exception:
        return ''
    if not words: return ''

    word_dicts = [{'x0': w[0], 'y0': w[1], 'x1': w[2], 'y1': w[3], 'text': w[4], 'yc': (w[1] + w[3]) / 2.0}
                  for w in words if w[4].strip()]
    if not word_dicts: return ''

    y_tol = _compute_y_tolerance(word_dicts)
    rows = _group_words_by_y(word_dicts, y_tol)
    page_width = page_fitz.rect.width
    char_w = _estimate_page_char_w(word_dicts)
    
    lines = []
    for row in rows:
        lines.append(_render_row_to_grid(row, page_width, char_w))

    lines = _merge_continuation_rows(lines)
    return '\n'.join(lines)


def _compute_y_tolerance(word_dicts: list) -> float:
    if not word_dicts: return 3.0
    heights = sorted(w['y1'] - w['y0'] for w in word_dicts)
    median_h = heights[len(heights) // 2]
    # 0.85x height captures vertically-offset components (SBI/YesBank fix)
    return max(2.5, min(median_h * 0.85, 10.0))


def _group_words_by_y(word_dicts: list, y_tol: float) -> List[List[dict]]:
    sorted_words = sorted(word_dicts, key=lambda w: (w['yc'], w['x0']))
    rows: List[List[dict]] = []
    if not sorted_words: return []
    cur = [sorted_words[0]]
    cur_y = sorted_words[0]['yc']
    
    def is_main_date(w):
        return w['x0'] < 150 and bool(DATE_RE.search(w['text']))
        
    has_date = is_main_date(sorted_words[0])

    for w in sorted_words[1:]:
        y = w['yc']
        this_date = is_main_date(w)
        force_break = this_date and has_date # Start new row on second date found
        
        if abs(y - cur_y) <= y_tol and not force_break:
            cur.append(w)
            if this_date: has_date = True
        else:
            rows.append(sorted(cur, key=lambda x: x['x0']))
            cur = [w]; cur_y = y; has_date = this_date

    if cur: rows.append(sorted(cur, key=lambda x: x['x0']))
    return rows


# ──────────────────────────────────────────────────────────────────────────────
# Grid Rendering Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _estimate_page_char_w(word_dicts: list) -> float:
    if not word_dicts: return 4.0
    heights = sorted(w['y1'] - w['y0'] for w in word_dicts if 'y1' in w)
    if not heights: return 4.0
    median_h = heights[len(heights) // 2]
    
    sample_widths = []
    for w in word_dicts:
        txt_len = len(w['text'])
        if txt_len > 2:
            sw = (w['x1'] - w['x0']) / txt_len
            if 2.0 < sw < 15.0: sample_widths.append(sw)
    if sample_widths:
        return sorted(sample_widths)[len(sample_widths) // 2]
    return max(3.0, median_h * 0.52) # 0.52x height for financial fonts


def _render_row_to_grid(row: List[dict], page_width: float, char_w: float) -> str:
    max_cols = int(page_width / char_w) + 20
    grid = [' '] * max_cols
    for w in row:
        col = int(round(w['x0'] / char_w))
        txt = w['text']
        for i, char in enumerate(txt):
            if col + i < max_cols: grid[col + i] = char
    return "".join(grid).rstrip()


# ──────────────────────────────────────────────────────────────────────────────
# Strategy B — pdfplumber table extraction
# ──────────────────────────────────────────────────────────────────────────────

def _plumber_table_text(page_plumber) -> str:
    try:
        tables = page_plumber.extract_tables()
        if not tables: return ''
        def table_density(t):
            return sum(1 for row in t for c in (row or []) if c and str(c).strip())
        tbl = max(tables, key=table_density)
        if table_density(tbl) < 6: return ''
        return _render_table(tbl)
    except Exception:
        return ''


def _render_table(table: list) -> str:
    if not table: return ''
    col_count = max((len(r) for r in table if r), default=0)
    widths = [0] * col_count
    for row in table:
        if not row: continue
        for ci in range(min(len(row), col_count)):
            cell = str(row[ci] or '').replace('\n', ' ').strip()
            widths[ci] = max(widths[ci], len(cell) + 2)
    output = []
    for row in table:
        if not row: continue
        parts = []
        for ci in range(col_count):
            cell = str(row[ci] or '').replace('\n', ' ').strip() if ci < len(row) else ''
            w = widths[ci]
            if re.fullmatch(r'[\d,.\-+₹$()Cr Dr]+', cell) and cell:
                parts.append(cell.rjust(w))
            else:
                parts.append(cell.ljust(w))
        output.append(''.join(parts).rstrip())
    return '\n'.join(output)


# ──────────────────────────────────────────────────────────────────────────────
# Strategy D — pdfplumber word-row
# ──────────────────────────────────────────────────────────────────────────────

def _plumber_word_row_text(page_plumber) -> str:
    try:
        words = page_plumber.extract_words(x_tolerance=3, y_tolerance=3)
        if not words: return ''
        words = _filter_sidebar_words(words, page_plumber.width)
        if not words: return ''
        
        standard_words = [{'x0':w['x0'],'x1':w['x1'],'y0':w['top'],'y1':w['bottom'],'text':w['text']} for w in words]
        y_tol = _compute_y_tolerance(standard_words)
        
        # Simple grouping by Y-center
        sorted_w = sorted(standard_words, key=lambda w: ((w['y0']+w['y1'])/2.0, w['x0']))
        rows = []
        cur = [sorted_w[0]]; cur_y = (sorted_w[0]['y0']+sorted_w[0]['y1'])/2.0
        for w in sorted_w[1:]:
            yc = (w['y0']+w['y1'])/2.0
            if abs(yc - cur_y) <= y_tol: cur.append(w)
            else:
                rows.append(sorted(cur, key=lambda x: x['x0']))
                cur = [w]; cur_y = yc
        if cur: rows.append(sorted(cur, key=lambda x: x['x0']))
        
        char_w = _estimate_page_char_w(standard_words)
        lines = [_render_row_to_grid(r, page_plumber.width, char_w) for r in rows]
        lines = _merge_continuation_rows(lines)
        return '\n'.join(lines)
    except Exception:
        return ''


def _filter_sidebar_words(words: list, page_width: float) -> list:
    if not words or page_width <= 0: return words
    strip_w = page_width / 10.0
    counts = defaultdict(int)
    for w in words: counts[int(w['x0'] / strip_w)] += 1
    if not counts: return words
    max_c = max(counts.values())
    main = [b for b, c in counts.items() if c >= max_c * 0.15]
    if not main: return words
    min_m, max_m = min(main)*strip_w, (max(main)+1)*strip_w
    if (max_m - min_m) / page_width >= 0.9: return words
    buf = strip_w * 1.5
    f = [w for w in words if w['x0'] >= min_m - buf and w['x1'] <= max_m + buf]
    return f if len(f) > len(words) * 0.4 else words


# ──────────────────────────────────────────────────────────────────────────────
# Main Class
# ──────────────────────────────────────────────────────────────────────────────

class EnhancedFinancialPDFExtractor:
    def __init__(self, pdf_path: str):
        self.pdf_path = pdf_path
        self.password: Optional[str] = None

    def extract_all_text(self) -> str:
        pdf_path = self.pdf_path
        pages_text: List[str] = []
        fitz_doc, plumber_pdf = None, None
        try:
            if FITZ_OK:
                fitz_doc = fitz.open(pdf_path)
                if fitz_doc.is_encrypted:
                    if not fitz_doc.authenticate(self.password or ""):
                        raise ValueError("Incorrect PDF password")

            if PDFPLUMBER_OK:
                try:
                    plumber_pdf = pdfplumber.open(pdf_path, password=self.password or '')
                except Exception as e:
                    if "Password" in str(e) or "password" in str(e):
                        raise ValueError("Incorrect PDF password")
                    else:
                        raise

            n_fitz = len(fitz_doc) if fitz_doc else 0
            n_plum = len(plumber_pdf.pages) if plumber_pdf else 0
            total = max(n_fitz, n_plum)

            for page_num in range(total):
                pg_fitz = fitz_doc[page_num] if fitz_doc and page_num < n_fitz else None
                pg_plum = plumber_pdf.pages[page_num] if plumber_pdf and page_num < n_plum else None

                candidates = []
                if pg_fitz:
                    t = _fitz_page_text(pg_fitz)
                    if t.strip(): candidates.append(('fitz', _clean_cid(t)))
                if pg_plum:
                    t = _plumber_table_text(pg_plum)
                    if t.strip(): candidates.append(('table', _clean_cid(t)))
                    t = _plumber_word_row_text(pg_plum)
                    if t.strip(): candidates.append(('words', _clean_cid(t)))
                    t = pg_plum.extract_text(layout=True)
                    if t and t.strip(): candidates.append(('layout', _clean_cid(t)))

                if not candidates: continue
                scored = sorted([(c[1], _score_text(c[1])) for c in candidates], key=lambda x: x[1], reverse=True)
                best_txt = scored[0][0]

                lines = best_txt.split('\n')
                lines = _join_hyphen_wraps(lines)
                lines = _remove_footer_lines(lines)
                lines = _collapse_blank_lines(lines)

                sep = ('' if page_num == 0 else '\n') + '=' * 80 + f'\nPAGE {page_num+1}\n' + '=' * 80 + '\n'
                pages_text.append(sep + '\n'.join(lines))

        except ValueError as exc:
            if "Incorrect PDF password" in str(exc):
                raise
            logger.error("Error extracting %s: %s", pdf_path, exc, exc_info=True)
        except Exception as exc:
            logger.error("Error extracting %s: %s", pdf_path, exc, exc_info=True)
        finally:
            if fitz_doc: fitz_doc.close()
            if plumber_pdf: plumber_pdf.close()

        return '\n'.join(pages_text)


def _is_encrypted(pdf_path: str) -> bool:
    if FITZ_OK:
        try:
            doc = fitz.open(pdf_path)
            if not doc.is_encrypted:
                doc.close()
                return False
            is_authenticated = doc.authenticate("")
            doc.close()
            return not bool(is_authenticated)
        except Exception: pass
    if PYPDF2_OK:
        try:
            with open(pdf_path, 'rb') as f:
                reader = PdfReader(f)
                if not reader.is_encrypted:
                    return False
                # Try decrypting with empty string (many bank PDFs use this for metadata-only encryption)
                # returns 0 if fails (requires password), 1 or 2 if succeeds (no password needed)
                return reader.decrypt("") == 0
        except Exception: pass
    return False


def extract_pdf_text(pdf_path: str, password: str = None) -> str:
    logger.info("extract_pdf_text: %s (password provided=%s)", pdf_path, bool(password))
    extractor = EnhancedFinancialPDFExtractor(pdf_path)
    if password:
        extractor.password = password
    elif _is_encrypted(pdf_path):
        logger.warning("PDF appears encrypted but no password provided: %s", pdf_path)
    return extractor.extract_all_text()