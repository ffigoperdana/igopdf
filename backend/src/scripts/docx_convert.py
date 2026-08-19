#!/usr/bin/env python3
import argparse
from copy import deepcopy
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import fitz
import pytesseract
from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches
from docx.table import Table, _Cell
from pdf2docx import Converter
from PIL import Image


def emit(payload):
    print(json.dumps(payload), flush=True)


def fail(code):
    emit({"type": "error", "code": code})
    raise RuntimeError(code)


def normalize_with_qpdf(source, directory):
    target = os.path.join(directory, "qpdf-repaired.pdf")
    result = subprocess.run(
        ["qpdf", "--warning-exit-0", "--object-streams=generate", source, target],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return target if result.returncode == 0 and os.path.exists(target) else source


def normalize_with_ghostscript(source, directory):
    target = os.path.join(directory, "ghostscript-normalized.pdf")
    result = subprocess.run(
        [
            "gs", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.6", "-dPDFSETTINGS=/prepress",
            "-sOutputFile=" + target, source,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return target if result.returncode == 0 and os.path.exists(target) else None


def extract_reference_pages(document):
    """Return full-page and block-level source text in reading order.

    Table columns can interleave in a full-page extraction. Text blocks keep
    each cell's tokens consecutive, which lets the repair remain exact rather
    than guessing word boundaries.
    """
    page_texts = [page.get_text("text", sort=True) or "" for page in document]
    block_texts = []
    for page in document:
        block_texts.extend(
            block[4]
            for block in page.get_text("blocks", sort=True)
            if len(block) > 4 and isinstance(block[4], str) and block[4].strip()
        )
    return page_texts + block_texts


def is_nota_dinas(reference_pages):
    first_page = reference_pages[0] if reference_pages else ""
    normalized = re.sub(r"\s+", " ", first_page).upper()
    return (
        "NOTA DINAS" in normalized
        and re.search(r"\bNOMOR\s+ND\s*[-/]", normalized) is not None
    )


def is_nota_riil(reference_pages):
    """Identify the BPDP expense-statement form with an editable expense grid."""
    normalized = " ".join(reference_pages).upper()
    return (
        "DAFTAR PENGELUARAN RIIL" in normalized
        and all(label in normalized for label in ("NO", "URAIAN", "JUMLAH"))
    )


def is_rincian_biaya_perjalanan_dinas(reference_pages):
    """Identify the BPDP SPJ form that pdf2docx can turn black by mistake."""
    normalized = re.sub(r"\s+", "", " ".join(reference_pages)).upper()
    return (
        "RINCIANBIAYAPERJALANANDINAS" in normalized
        and all(
            label in normalized
            for label in ("PERINCIANBIAYA", "JUMLAH", "KETERANGAN")
        )
    )


def is_kak(reference_pages):
    """Identify office KAK documents that use structured activity tables.

    This intentionally requires both the KAK title and one of its usual
    programme sections.  A generic document that merely mentions a KAK is
    therefore left on the normal editable-conversion path.
    """
    normalized = re.sub(r"\s+", " ", " ".join(reference_pages)).upper()
    return (
        "KERANGKA ACUAN KERJA" in normalized
        and any(
            marker in normalized
            for marker in (
                "LINGKUP KEGIATAN",
                "MATERI DAN ACARA",
                "TAHAPAN PELAKSANAAN",
            )
        )
    )


def _non_whitespace_positions(text):
    return [index for index, char in enumerate(text) if not char.isspace()]


def _casefold_with_position_map(text, positions):
    """Casefold selected characters while retaining source-position mapping.

    Unicode casefolding may expand one character into several code points
    (for example, ``ß`` becomes ``ss``). A folded-string offset therefore
    cannot safely index the original position list directly.
    """
    folded_parts = []
    folded_positions = []
    character_starts = []
    boundaries = {0}
    for position in positions:
        character_starts.append(len(folded_positions))
        folded = text[position].casefold()
        # Casefold currently preserves all ordinary PDF text characters, but
        # retaining the original character is a safe fallback for an empty
        # mapping and keeps the index usable for unusual Unicode input.
        if not folded:
            folded = text[position]
        folded_parts.append(folded)
        folded_positions.extend([position] * len(folded))
        boundaries.add(len(folded_positions))
    return (
        "".join(folded_parts),
        folded_positions,
        character_starts,
        boundaries,
    )


def _build_reference_index(reference_pages):
    index = []
    for reference in reference_pages:
        positions = _non_whitespace_positions(reference)
        compact, folded_positions, _, boundaries = (
            _casefold_with_position_map(reference, positions)
        )
        if compact:
            index.append(
                (reference, compact, folded_positions, boundaries)
            )
    return index


def _protected_spacing_ranges(text):
    patterns = (
        (r"(?:https?://|www\.)\S+", re.IGNORECASE),
        (r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b", re.IGNORECASE),
        (
            r"\b(?:"
            r"(?=[A-Z0-9./-]*\d)[A-Z0-9]+(?:[./-][A-Z0-9]+)+"
            r"|"
            r"(?=[a-z0-9./-]*\d)[a-z0-9]+(?:[./-][a-z0-9]+)+"
            r")\b",
            0,
        ),
        (
            r"\b(?:[A-Z]{2,}\d[A-Z0-9]*|[a-z]{2,}\d[a-z0-9]*)\b",
            0,
        ),
        (r"\b\d+(?:[.,:/-]\d+)*\b", re.IGNORECASE),
    )
    return [
        match.span()
        for pattern, flags in patterns
        for match in re.finditer(pattern, text, flags=flags)
    ]


def _missing_space_positions(
    text,
    reference_pages,
    min_compact_chars=10,
    reference_index=None,
    prefer_richest_spacing=False,
):
    """Find source-backed spaces that pdf2docx dropped inside a paragraph.

    Matching ignores existing whitespace, then only restores a gap when the
    source PDF has whitespace between the same two characters. This avoids
    dictionary/language guesses and works for Indonesian names and acronyms.
    """
    positions = _non_whitespace_positions(text)
    if len(positions) < min_compact_chars:
        return set()

    (
        compact_folded,
        _,
        text_character_starts,
        _,
    ) = _casefold_with_position_map(text, positions)
    matched_insertions = []
    protected_ranges = _protected_spacing_ranges(text)

    if reference_index is None:
        reference_index = _build_reference_index(reference_pages)

    for (
        reference,
        reference_folded,
        reference_folded_positions,
        reference_boundaries,
    ) in reference_index:
        start = reference_folded.find(compact_folded)
        while start >= 0:
            match_end = start + len(compact_folded)
            if (
                start not in reference_boundaries
                or match_end not in reference_boundaries
            ):
                start = reference_folded.find(compact_folded, start + 1)
                continue

            insertions = set()
            aligned = True
            for offset in range(len(positions) - 1):
                left = positions[offset]
                right = positions[offset + 1]
                if any(char.isspace() for char in text[left + 1:right]):
                    continue

                reference_left_offset = (
                    start + text_character_starts[offset]
                )
                reference_right_offset = (
                    start + text_character_starts[offset + 1]
                )
                if (
                    reference_left_offset not in reference_boundaries
                    or reference_right_offset not in reference_boundaries
                    or reference_left_offset
                    >= len(reference_folded_positions)
                    or reference_right_offset
                    >= len(reference_folded_positions)
                ):
                    # A match crossing the middle of an expanded casefold
                    # character (for example ``ss`` against ``ß``) cannot be
                    # mapped to source gaps without guessing.
                    aligned = False
                    break

                reference_left = reference_folded_positions[
                    reference_left_offset
                ]
                reference_right = reference_folded_positions[
                    reference_right_offset
                ]
                reference_gap = reference[reference_left + 1:reference_right]
                if not any(char.isspace() for char in reference_gap):
                    continue

                # A wrapped compound ending in a literal hyphen must remain
                # one word, while punctuation should stay attached.
                if text[left] == "-" or text[right] in ".,;:!?)]}":
                    continue
                if any(start < right < end for start, end in protected_ranges):
                    continue
                insertions.add(right)

            if aligned:
                matched_insertions.append(frozenset(insertions))
            start = reference_folded.find(compact_folded, start + 1)

    if not matched_insertions:
        return set()
    unique_patterns = set(matched_insertions)
    if len(unique_patterns) != 1:
        if prefer_richest_spacing:
            most_spaces = max(len(pattern) for pattern in unique_patterns)
            richest_patterns = [
                pattern
                for pattern in unique_patterns
                if len(pattern) == most_spaces
            ]
            if len(richest_patterns) == 1:
                return set(richest_patterns[0])
        # The same compact text has conflicting spacing in the source. Leave
        # identifiers/ambiguous short forms untouched instead of guessing.
        return set()
    return set(next(iter(unique_patterns)))


def restore_missing_spaces(
    text,
    reference_pages,
    min_compact_chars=10,
    prefer_richest_spacing=False,
):
    insertions = _missing_space_positions(
        text,
        reference_pages,
        min_compact_chars=min_compact_chars,
        prefer_richest_spacing=prefer_richest_spacing,
    )
    if not insertions:
        return text
    return "".join(
        (" " if index in insertions else "") + char
        for index, char in enumerate(text)
    )


def _iter_table_paragraphs(table, seen):
    for row in table.rows:
        for cell in row.cells:
            # Keep the XML element itself. Using id() here is unsafe because
            # python-docx creates short-lived cell wrappers and CPython can
            # reuse their integer ids while traversing a large table.
            cell_key = cell._tc
            if cell_key in seen:
                continue
            seen.add(cell_key)
            yield from cell.paragraphs
            for nested_table in cell.tables:
                yield from _iter_table_paragraphs(nested_table, seen)


def iter_document_paragraphs(document):
    yield from document.paragraphs
    seen = set()
    for table in document.tables:
        yield from _iter_table_paragraphs(table, seen)


def _iter_nested_tables(table, seen):
    table_key = table._tbl
    if table_key in seen:
        return
    seen.add(table_key)
    yield table
    for row in table.rows:
        cell_seen = set()
        for cell in row.cells:
            cell_key = cell._tc
            if cell_key in cell_seen:
                continue
            cell_seen.add(cell_key)
            for nested_table in cell.tables:
                yield from _iter_nested_tables(nested_table, seen)


def iter_document_tables(document):
    seen = set()
    for table in document.tables:
        yield from _iter_nested_tables(table, seen)


def _normalized_table_text(table):
    return " ".join(
        cell.text
        for row in table.rows
        for cell in row.cells
    ).upper()


def _normalized_label(text):
    return re.sub(r"[^a-z]", "", text.casefold())


def _expense_header_index(table):
    """Find a No / Uraian / Jumlah header even when Word cells are merged."""
    for index, row in enumerate(table.rows):
        labels = [_normalized_label(cell.text) for cell in _logical_row_cells(row)]
        if len(labels) >= 3 and labels[0] == "no" and labels[-1] == "jumlah":
            if any(label == "uraian" for label in labels[1:-1]):
                return index
    return None


def _is_nota_riil_expense_table(table):
    return (
        len(table.rows) >= 2
        and len(table.columns) >= 3
        and _expense_header_index(table) is not None
    )


def _set_border(border, edge):
    border.set(qn("w:val"), "single")
    border.set(qn("w:sz"), "6")
    border.set(qn("w:space"), "0")
    # "auto" adapts to Word's dark page canvas while remaining a normal
    # black border on paper/light mode. Hard-coded dark gray disappeared in
    # Office dark mode on the affected form.
    border.set(qn("w:color"), "auto")


def _set_table_grid_borders(table):
    """Restore editable grid borders dropped by pdf2docx on thin-lined forms."""
    table_properties = table._tbl.tblPr
    borders = table_properties.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        table_properties.append(borders)
    for edge in ("top", "start", "bottom", "end", "insideH", "insideV"):
        border = borders.find(qn(f"w:{edge}"))
        if border is None:
            border = OxmlElement(f"w:{edge}")
            borders.append(border)
        _set_border(border, edge)

    # pdf2docx emits empty tcBorders for this PDF. Explicit cell borders keep
    # the grid visible even in Word builds that do not inherit tblBorders from
    # a nested fixed-layout table.
    seen_cells = set()
    for row in table.rows:
        for cell in row.cells:
            cell_key = cell._tc
            if cell_key in seen_cells:
                continue
            seen_cells.add(cell_key)
            cell_properties = cell._tc.get_or_add_tcPr()
            cell_borders = cell_properties.first_child_found_in("w:tcBorders")
            if cell_borders is None:
                cell_borders = OxmlElement("w:tcBorders")
                cell_properties.append(cell_borders)
            for edge in ("top", "start", "bottom", "end"):
                border = cell_borders.find(qn(f"w:{edge}"))
                if border is None:
                    border = OxmlElement(f"w:{edge}")
                    cell_borders.append(border)
                _set_border(border, edge)


def _set_cell_width(cell, width):
    cell_properties = cell._tc.get_or_add_tcPr()
    cell_width = cell_properties.find(qn("w:tcW"))
    if cell_width is None:
        cell_width = OxmlElement("w:tcW")
        cell_properties.append(cell_width)
    cell_width.set(qn("w:type"), "dxa")
    cell_width.set(qn("w:w"), str(width))


def _set_table_geometry(table, widths):
    """Give reconstructed tables deterministic Word widths, not autofit."""
    total_width = sum(widths)
    table_properties = table._tbl.tblPr
    table_width = table_properties.first_child_found_in("w:tblW")
    if table_width is None:
        table_width = OxmlElement("w:tblW")
        table_properties.insert(0, table_width)
    table_width.set(qn("w:type"), "dxa")
    table_width.set(qn("w:w"), str(total_width))

    layout = table_properties.first_child_found_in("w:tblLayout")
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        table_properties.append(layout)
    layout.set(qn("w:type"), "fixed")

    grid = table._tbl.tblGrid
    for column in list(grid):
        grid.remove(column)
    for width in widths:
        column = OxmlElement("w:gridCol")
        column.set(qn("w:w"), str(width))
        grid.append(column)

    for row in table.rows:
        seen = set()
        column_index = 0
        for cell in row.cells:
            cell_key = cell._tc
            if cell_key in seen:
                continue
            seen.add(cell_key)
            cell_width = widths[min(column_index, len(widths) - 1)]
            grid_span = cell._tc.tcPr.find(qn("w:gridSpan"))
            if grid_span is not None:
                cell_width = sum(
                    widths[column_index:column_index + int(grid_span.get(qn("w:val"), "1"))]
                )
            _set_cell_width(cell, cell_width)
            column_index += 1 if grid_span is None else int(
                grid_span.get(qn("w:val"), "1")
            )


def _split_collapsed_cells(line):
    return [part.strip() for part in re.split(r"\t+", line) if part.strip()]


def _parse_collapsed_nota_riil_table(text):
    """Parse a pdf2docx one-cell table whose rows survived as tabbed text."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    header_index = next(
        (
            index
            for index, line in enumerate(lines)
            if re.search(r"\bNo\s*\t+Uraian\s*\t+Jumlah\b", line, re.IGNORECASE)
        ),
        None,
    )
    if header_index is None:
        return None

    items = []
    total = None
    active_item = None
    for line in lines[header_index + 1:]:
        cells = _split_collapsed_cells(line)
        if not cells:
            continue
        if _is_total_label(cells[0]):
            if len(cells) < 2:
                return None
            total = (cells[0], cells[-1])
            break

        item_match = re.match(r"^(\d+[.)])\s+(.+)$", cells[0])
        if item_match and len(cells) >= 2:
            active_item = {
                "number": item_match.group(1),
                "description": item_match.group(2).strip(),
                "amount": cells[-1],
            }
            items.append(active_item)
            continue

        continuation = " ".join(cells).strip()
        if active_item is None or not continuation:
            return None
        active_item["description"] += "\n" + continuation

    if not items or total is None:
        return None
    return {"items": items, "total": total}


def _replace_collapsed_nota_riil_table(table, parsed):
    """Replace a collapsed one-cell nested table with a real editable grid."""
    parent_cell = table._parent
    template_cell = table.cell(0, 0)
    row_count = len(parsed["items"]) + 2
    rebuilt = parent_cell.add_table(rows=row_count, cols=3)
    # The source form's No / Uraian / Jumlah proportions. The collapsed
    # table's own one-column grid supplies the containing width.
    source_width = sum(
        int(column.get(qn("w:w"), "0")) for column in table._tbl.tblGrid
    ) or 9840
    widths = [
        round(source_width * 0.08),
        round(source_width * 0.55),
        source_width - round(source_width * 0.08) - round(source_width * 0.55),
    ]
    _set_table_geometry(rebuilt, widths)

    header = ("No", "Uraian", "Jumlah")
    for column, value in enumerate(header):
        cell = rebuilt.cell(0, column)
        _set_cell_text_like(cell, value, template_cell)
        cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    _set_row_height(rebuilt.rows[0], 420)

    for offset, item in enumerate(parsed["items"], start=1):
        row = rebuilt.rows[offset]
        _set_cell_text_like(row.cells[0], item["number"], template_cell)
        _set_cell_text_like(row.cells[1], item["description"], template_cell)
        _set_cell_text_like(row.cells[2], item["amount"], template_cell)
        row.cells[0].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        row.cells[2].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
        _set_row_height(row, _minimum_expense_row_height(row))

    total_row = rebuilt.rows[-1]
    merged_total = total_row.cells[0].merge(total_row.cells[1])
    _set_cell_text_like(merged_total, parsed["total"][0], template_cell)
    _set_cell_text_like(total_row.cells[2], parsed["total"][1], template_cell)
    total_row.cells[2].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
    _set_row_height(total_row, 420)
    _set_table_grid_borders(rebuilt)

    # add_table appends at the end of the parent cell. Move it into the exact
    # original position, then remove the collapsed source table.
    table._tbl.addprevious(rebuilt._tbl)
    table._tbl.getparent().remove(table._tbl)
    return rebuilt


def _recover_collapsed_nota_riil_tables(document):
    recovered = 0
    for table in list(iter_document_tables(document)):
        if len(table.rows) != 1 or len(table.columns) != 1:
            continue
        parsed = _parse_collapsed_nota_riil_table(table.cell(0, 0).text)
        if parsed is None:
            continue
        _replace_collapsed_nota_riil_table(table, parsed)
        recovered += 1
    return recovered


def _as_dxa(value):
    try:
        return round(float(value))
    except (TypeError, ValueError):
        return 0


def _table_indent(table):
    indent = table._tbl.tblPr.find(qn("w:tblInd"))
    if indent is None or indent.get(qn("w:type")) != "dxa":
        return 0
    return _as_dxa(indent.get(qn("w:w")))


def _table_ancestors(table):
    """Return immediate-to-outer table ancestors for a nested Word table."""
    ancestors = []
    current = table
    while isinstance(current._parent, _Cell):
        parent = current._parent._parent
        if not isinstance(parent, Table):
            break
        ancestors.append(parent)
        current = parent
    return ancestors


def _has_exact_row_height(table):
    for row in table.rows:
        properties = row._tr.trPr
        height = (
            properties.find(qn("w:trHeight"))
            if properties is not None
            else None
        )
        if height is not None and height.get(qn("w:hRule")) == "exact":
            return True
    return False


def _is_disposable_expense_wrapper(ancestors):
    """Recognize the empty fixed-height table stack emitted by pdf2docx.

    Those wrapper tables do not represent visible source content. Leaving the
    expense grid inside them makes Word clip the entire editable table even
    though its XML text is present.
    """
    if not ancestors or not any(_has_exact_row_height(table) for table in ancestors):
        return False
    for table in ancestors:
        if len(table.rows) != 1 or len(table.columns) != 1:
            return False
        if any(paragraph.text.strip() for paragraph in table.cell(0, 0).paragraphs):
            return False
    return True


def _cell_dxa_width(cell):
    properties = cell._tc.tcPr
    width = properties.find(qn("w:tcW")) if properties is not None else None
    if width is None or width.get(qn("w:type")) != "dxa":
        return 0
    return _as_dxa(width.get(qn("w:w")))


def _expense_table_widths(table, header_index):
    header_cells = _logical_row_cells(table.rows[header_index])
    widths = [_cell_dxa_width(cell) for cell in header_cells]
    if len(widths) >= 3 and all(width > 0 for width in widths[:3]):
        return widths[:3]

    grid_widths = [
        _as_dxa(column.get(qn("w:w")))
        for column in table._tbl.tblGrid
    ]
    if len(grid_widths) >= 3 and all(grid_widths):
        total = sum(grid_widths)
        return [
            max(520, round(total * 0.08)),
            max(3200, round(total * 0.55)),
            max(1800, total - round(total * 0.08) - round(total * 0.55)),
        ]
    return [760, 5180, 3440]


def _expense_table_data(table):
    """Extract the useful three-column content before discarding bad wrappers."""
    header_index = _expense_header_index(table)
    if header_index is None:
        return None
    total_index = _find_total_row_index(table, header_index)
    if total_index is None or total_index <= header_index + 1:
        return None

    header_cells = _logical_row_cells(table.rows[header_index])
    item_rows = []
    for index in range(header_index + 1, total_index):
        cells = _logical_row_cells(table.rows[index])
        if len(cells) < 3 or not _is_item_number(cells[0].text):
            continue
        item_rows.append(
            {
                "number": cells[0].text.strip(),
                "description": cells[1].text.strip(),
                "amount": cells[-1].text.strip(),
                "template": cells[1],
            }
        )
    if not item_rows:
        return None

    total_cells = _logical_row_cells(table.rows[total_index])
    if len(total_cells) < 2:
        return None

    # Some PDFs put the final item's calculation in the surplus cells of the
    # total row. Keep it attached to that item's description in the rebuilt
    # editable grid, where it appears in the source PDF.
    middle_cells = total_cells[1:-1]
    calculation = " ".join(
        cell.text.strip() for cell in middle_cells if cell.text.strip()
    )
    if calculation and _looks_like_calculation(calculation):
        description = item_rows[-1]["description"]
        if calculation not in re.sub(r"\s+", " ", description):
            item_rows[-1]["description"] = (
                description + "\n" + calculation
            ).strip()

    headers = [cell.text.strip() for cell in header_cells]
    if len(headers) < 3:
        headers = ["No", "Uraian", "Jumlah"]
    return {
        "headers": headers[:3],
        "items": item_rows,
        "total": {
            "label": total_cells[0].text.strip() or "Jumlah",
            "amount": total_cells[-1].text.strip(),
            "template": total_cells[-1],
        },
        "header_template": header_cells[0],
        "widths": _expense_table_widths(table, header_index),
    }


def _set_table_indent(table, width):
    properties = table._tbl.tblPr
    indent = properties.find(qn("w:tblInd"))
    if indent is None:
        indent = OxmlElement("w:tblInd")
        properties.append(indent)
    indent.set(qn("w:type"), "dxa")
    indent.set(qn("w:w"), str(max(0, width)))


def _set_cell_shading(cell, fill):
    properties = cell._tc.get_or_add_tcPr()
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:color"), "auto")
    shading.set(qn("w:fill"), fill)


def _set_cell_margins(cell, top=70, start=100, bottom=70, end=100):
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.find(qn("w:tcMar"))
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for edge, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        margin = margins.find(qn(f"w:{edge}"))
        if margin is None:
            margin = OxmlElement(f"w:{edge}")
            margins.append(margin)
        margin.set(qn("w:w"), str(value))
        margin.set(qn("w:type"), "dxa")


def _set_cell_run_color(cell, color):
    for paragraph in cell.paragraphs:
        for run in paragraph.runs:
            properties = run._r.get_or_add_rPr()
            color_element = properties.find(qn("w:color"))
            if color_element is None:
                color_element = OxmlElement("w:color")
                properties.append(color_element)
            color_element.set(qn("w:val"), color)


def _is_near_black_color(value):
    value = (value or "").strip().lstrip("#").casefold()
    if value in {"black", "000", "000000"}:
        return True
    if not re.fullmatch(r"[0-9a-f]{6}", value):
        return False
    return all(int(value[index:index + 2], 16) <= 0x20 for index in (0, 2, 4))


def _is_black_cell_shading(cell):
    properties = cell._tc.tcPr
    shading = properties.find(qn("w:shd")) if properties is not None else None
    fill = shading.get(qn("w:fill")) if shading is not None else None
    return _is_near_black_color(fill)


def _repair_black_placeholder_borders(cell):
    """Restore empty light-gray separator cells emitted as thick black borders."""
    if cell.text.strip() or "<w:drawing" in cell._tc.xml:
        return 0

    properties = cell._tc.tcPr
    borders = properties.find(qn("w:tcBorders")) if properties is not None else None
    if borders is None:
        return 0

    repaired = 0
    for edge in ("top", "start", "left", "bottom", "end", "right"):
        border = borders.find(qn(f"w:{edge}"))
        if border is None or not _is_near_black_color(border.get(qn("w:color"))):
            continue
        try:
            size = float(border.get(qn("w:sz"), "0"))
        except (TypeError, ValueError):
            size = 0
        if size < 24:
            continue
        border.set(qn("w:color"), "#E7E6E6")
        repaired += 1
    return repaired


def _repair_rincian_biaya_shading(document):
    """Restore the light-gray totals that pdf2docx emits as black cells.

    This is limited to the recognized BPDP Rincian Biaya form. We deliberately
    only touch text-bearing table cells, keeping drawings such as a scanned
    signature or an embedded image intact.
    """
    repaired = 0
    seen_cells = set()
    for table in iter_document_tables(document):
        for row in table.rows:
            for cell in row.cells:
                cell_key = cell._tc
                if cell_key in seen_cells:
                    continue
                seen_cells.add(cell_key)
                if cell.text.strip() and _is_black_cell_shading(cell):
                    _set_cell_shading(cell, "E7E6E6")
                    _set_cell_run_color(cell, "000000")
                    repaired += 1
                repaired += _repair_black_placeholder_borders(cell)
    return repaired


def _restore_bpdp_header_rule(
    document,
    title,
    anchor_markers=("TELP", "SITUS"),
):
    """Restore the full-width rule between the BPDP masthead and form title.

    pdf2docx keeps the masthead text but drops its separator rule on some BPDP
    forms. The masthead itself is often centered with paragraph indents, so a
    border on that paragraph would only make a short line. Instead, insert a
    dedicated, unindented paragraph directly after the final TELP/SITUS line.
    """
    title_upper = title.upper()
    paragraphs = document.paragraphs
    title_index = next(
        (
            index
            for index, paragraph in enumerate(paragraphs)
            if title_upper in paragraph.text.upper()
        ),
        None,
    )
    if title_index is None:
        return 0

    anchor = next(
        (
            paragraph
            for paragraph in reversed(paragraphs[:title_index])
            if any(marker in paragraph.text.upper() for marker in anchor_markers)
        ),
        None,
    )
    if anchor is None:
        return 0

    next_element = anchor._p.getnext()
    if next_element is not None and next_element.tag == qn("w:p"):
        next_properties = next_element.find(qn("w:pPr"))
        next_borders = (
            next_properties.find(qn("w:pBdr"))
            if next_properties is not None
            else None
        )
        if next_borders is not None and next_borders.find(qn("w:bottom")) is not None:
            return 0

    rule = document.add_paragraph()
    properties = rule._p.get_or_add_pPr()

    spacing = properties.find(qn("w:spacing"))
    if spacing is None:
        spacing = OxmlElement("w:spacing")
        properties.append(spacing)
    spacing.set(qn("w:before"), "0")
    spacing.set(qn("w:after"), "80")
    spacing.set(qn("w:line"), "20")
    spacing.set(qn("w:lineRule"), "exact")

    indent = properties.find(qn("w:ind"))
    if indent is None:
        indent = OxmlElement("w:ind")
        properties.append(indent)
    indent.set(qn("w:left"), "0")
    indent.set(qn("w:right"), "0")

    borders = properties.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        properties.append(borders)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "0")
    bottom.set(qn("w:color"), "000000")
    borders.append(bottom)

    # document.add_paragraph() appends to the body; move it next to the
    # masthead so all existing form geometry remains untouched.
    anchor._p.addnext(rule._p)
    return 1


def _repair_rincian_biaya_payment_band(document):
    """Make the SPJ payment total's light-gray band span both columns.

    Some conversions retain the gray fill only inside the left nested amount
    table. The source form uses one continuous band behind both payment
    amounts, so repair the parent cells only for this very specific signature
    block rather than touching generic two-column tables.
    """
    repaired = 0
    for table in iter_document_tables(document):
        if len(table.rows) < 2:
            continue
        total_cells = _logical_row_cells(table.rows[0])
        signature_cells = _logical_row_cells(table.rows[1])
        if len(total_cells) != 2 or len(signature_cells) != 2:
            continue

        signature_text = " ".join(cell.text.upper() for cell in signature_cells)
        if (
            "BENDAHARA PENGELUARAN" not in signature_text
            or "YANG MENERIMA" not in signature_text
            or not any("RP" in cell.text.upper() for cell in total_cells)
        ):
            continue

        for cell in total_cells:
            _set_cell_shading(cell, "E7E6E6")
            _set_cell_run_color(cell, "000000")
            for nested_table in cell.tables:
                for nested_row in nested_table.rows:
                    for nested_cell in _logical_row_cells(nested_row):
                        _set_cell_shading(nested_cell, "E7E6E6")
                        _set_cell_run_color(nested_cell, "000000")
            repaired += 1
    return repaired


def _repair_rincian_biaya_payment_caption_flow(document):
    """Keep the left payment caption from flowing onto the date line.

    pdf2docx sometimes places the date, both payment captions, and a trailing
    ``sebesar`` in one tabbed paragraph. Word then fits the first word
    (``Telah``) after the date and wraps the rest to the left. A line break
    before the left caption restores the intended two-column flow while
    keeping the original tabs, font, and spacing intact.
    """
    repaired = 0
    for paragraph in document.paragraphs:
        paragraph_upper = paragraph.text.upper()
        if not all(
            marker in paragraph_upper
            for marker in (
                "TELAH DIBAYAR SEJUMLAH",
                "TELAH MENERIMA JUMLAH UANG",
                "SEBESAR",
            )
        ):
            continue

        for run in paragraph.runs:
            match = re.match(
                r"^(\s*)(Telah\s+dibayar\s+sejumlah\b.*)$",
                run.text,
                re.IGNORECASE,
            )
            if match is None or "\n" in match.group(1):
                continue
            run.text = f"{match.group(1)}\n{match.group(2)}"
            repaired += 1
            break
    return repaired


def _restore_form_title_underline(document, title):
    """Restore a short title underline that pdf2docx drops from BPDP forms."""
    repairs = 0
    title_upper = title.upper()
    for paragraph in iter_document_paragraphs(document):
        start = paragraph.text.upper().find(title_upper)
        if start < 0:
            continue
        end = start + len(title)
        offset = 0
        for run in paragraph.runs:
            run_end = offset + len(run.text)
            if offset < end and run_end > start and not run.font.underline:
                # The standard forms keep the title in its own run. On older
                # variants it can contain a trailing space, which is harmless
                # and preserves the original title width in Word.
                run.font.underline = True
                repairs += 1
            offset = run_end
    return repairs


def _remove_rincian_title_placeholder_border(document):
    """Remove the title underline that pdf2docx incorrectly assigns to a table."""
    repairs = 0
    for table in iter_document_tables(document):
        if not table.rows or "LAMPIRAN SPD NO." not in table.rows[0].cells[0].text.upper():
            continue
        seen_cells = set()
        for cell in table.rows[0].cells:
            if cell._tc in seen_cells:
                continue
            seen_cells.add(cell._tc)
            properties = cell._tc.tcPr
            borders = (
                properties.find(qn("w:tcBorders")) if properties is not None else None
            )
            if borders is None:
                continue
            top_border = borders.find(qn("w:top"))
            if top_border is not None:
                borders.remove(top_border)
                repairs += 1
    return repairs


def _replace_clipped_expense_table(document, table, ancestors, data):
    """Promote a deeply nested grid to the document body so Word can render it."""
    outer_table = ancestors[-1]
    effective_indent = sum(_table_indent(candidate) for candidate in ancestors)
    effective_indent += _table_indent(table)

    rebuilt = document.add_table(rows=len(data["items"]) + 2, cols=3)
    _set_table_geometry(rebuilt, data["widths"])
    _set_table_indent(rebuilt, effective_indent)

    for column, value in enumerate(data["headers"]):
        cell = rebuilt.cell(0, column)
        _set_cell_text_like(cell, value, data["header_template"])
        _set_cell_shading(cell, "808080")
        _set_cell_margins(cell)
        _set_cell_run_color(cell, "FFFFFF")
        for run in cell.paragraphs[0].runs:
            run.bold = True
        cell.paragraphs[0].alignment = (
            WD_ALIGN_PARAGRAPH.LEFT
            if column == 0
            else WD_ALIGN_PARAGRAPH.CENTER
        )
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    _set_row_height(rebuilt.rows[0], 420)

    for offset, item in enumerate(data["items"], start=1):
        row = rebuilt.rows[offset]
        _set_cell_text_like(row.cells[0], item["number"], item["template"])
        _set_cell_text_like(row.cells[1], item["description"], item["template"])
        _set_cell_text_like(row.cells[2], item["amount"], item["template"])
        for cell in row.cells:
            _set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        row.cells[0].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.LEFT
        row.cells[1].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.LEFT
        row.cells[2].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
        _set_row_height(row, _minimum_expense_row_height(row))

    total_row = rebuilt.rows[-1]
    total_cell = total_row.cells[0].merge(total_row.cells[1])
    _set_cell_text_like(total_cell, data["total"]["label"], data["total"]["template"])
    _set_cell_text_like(
        total_row.cells[2], data["total"]["amount"], data["total"]["template"]
    )
    for cell in (total_cell, total_row.cells[2]):
        _set_cell_margins(cell)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    total_cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.LEFT
    total_row.cells[2].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
    _set_row_height(total_row, 420)
    _set_table_grid_borders(rebuilt)

    # add_table appends to the body. Put the clean table exactly where the
    # clipping wrapper lived, then delete the entire wrapper stack with it.
    outer_table._tbl.addprevious(rebuilt._tbl)
    outer_table._tbl.getparent().remove(outer_table._tbl)


def _promote_clipped_nota_riil_tables(document):
    promoted = 0
    for table in list(iter_document_tables(document)):
        if not _is_nota_riil_expense_table(table):
            continue
        ancestors = _table_ancestors(table)
        if not _is_disposable_expense_wrapper(ancestors):
            continue
        data = _expense_table_data(table)
        if data is None:
            continue
        _replace_clipped_expense_table(document, table, ancestors, data)
        promoted += 1
    return promoted


def _logical_row_cells(row):
    cells = []
    seen = set()
    for cell in row.cells:
        cell_key = cell._tc
        if cell_key in seen:
            continue
        seen.add(cell_key)
        cells.append(cell)
    return cells


def _set_row_height(row, twips):
    row_properties = row._tr.get_or_add_trPr()
    height = row_properties.find(qn("w:trHeight"))
    if height is None:
        height = OxmlElement("w:trHeight")
        row_properties.append(height)
    height.set(qn("w:val"), str(twips))
    # Keep the source proportions but never clip editable text if Word uses a
    # substituted font.
    height.set(qn("w:hRule"), "atLeast")


def _cell_grid_span(cell):
    properties = cell._tc.tcPr
    grid_span = (
        properties.find(qn("w:gridSpan")) if properties is not None else None
    )
    if grid_span is None:
        return 1
    try:
        return max(1, int(grid_span.get(qn("w:val"), "1")))
    except (TypeError, ValueError):
        return 1


def _table_cell_grid_widths(table):
    """Recover physical grid widths from the source cells' declared widths.

    pdf2docx often retains correct ``tcW`` values but writes an equal-width
    ``tblGrid``.  Word follows the grid for fixed tables, which is why a
    readable PDF table can overflow or split in the converted DOCX.
    """
    column_count = len(table.columns)
    if column_count <= 0:
        return []

    candidates = [[] for _ in range(column_count)]
    for row in table.rows:
        column_index = 0
        seen = set()
        for cell in row.cells:
            cell_key = cell._tc
            if cell_key in seen:
                continue
            seen.add(cell_key)
            span = _cell_grid_span(cell)
            width = _cell_dxa_width(cell)
            if width > 0:
                per_column_width = max(1, round(width / span))
                for index in range(
                    column_index,
                    min(column_count, column_index + span),
                ):
                    candidates[index].append((span, per_column_width))
            column_index += span

    fallback_widths = [
        _as_dxa(column.get(qn("w:w"))) for column in table._tbl.tblGrid
    ]
    widths = []
    for index in range(column_count):
        values = candidates[index]
        if values:
            # A value from a narrower merged range is more precise.  For
            # example, a one-cell "c." column is more reliable than a
            # neighbouring label merged across three grid columns.
            minimum_span = min(span for span, _ in values)
            options = sorted(
                width for span, width in values if span == minimum_span
            )
            widths.append(options[len(options) // 2])
            continue
        fallback = (
            fallback_widths[index]
            if index < len(fallback_widths)
            else 0
        )
        widths.append(fallback)

    if not all(width > 0 for width in widths):
        return []
    return widths


def _fit_table_widths(widths, maximum):
    total = sum(widths)
    if not widths or total <= maximum:
        return widths

    scale = maximum / total
    fitted = [max(180, round(width * scale)) for width in widths]
    difference = maximum - sum(fitted)
    # Keep the total deterministic so ``tblW`` and ``tblGrid`` agree exactly.
    fitted[-1] = max(180, fitted[-1] + difference)
    return fitted


def _scaled_kak_reference_widths(reference_widths, maximum):
    """Scale physical PDF column widths into a safe editable Word grid.

    pdf2docx can preserve the row/cell content of wide KAK tables while
    losing the source ``tblGrid`` proportions (the fallback is often equal
    columns).  Keeping the proportions from the PDF is important for tables
    whose first/description columns are intentionally much wider or narrower
    than the activity columns.  The result is always fitted to the printable
    area so it cannot clip on the right edge of an A4 page.
    """
    if not reference_widths or any(width <= 0 for width in reference_widths):
        return []
    total = sum(reference_widths)
    if total <= 0:
        return []
    scaled = [max(180, round(width * maximum / total)) for width in reference_widths]
    difference = maximum - sum(scaled)
    scaled[-1] = max(180, scaled[-1] + difference)
    return scaled


def _is_kak_university_header(table):
    if len(table.rows) != 1 or len(table.columns) != 3:
        return False
    labels = [
        _normalized_label(cell.text)
        for cell in _logical_row_cells(table.rows[0])
    ]
    return (
        len(labels) == 3
        and labels[0] == "no"
        and labels[1] == "namaperguruantinggi"
        and labels[2] == "jumlahkelompok"
    )


def _is_kak_university_body(table):
    if not table.rows or len(table.columns) != 3:
        return False
    cells = _logical_row_cells(table.rows[0])
    if len(cells) != 3:
        return False
    return re.fullmatch(r"(?:\d+[A-Z]?|[A-Z])", cells[0].text.strip()) is not None


def _merge_kak_university_tables(document):
    """Join a detached table header and body into one editable grid."""
    tables = list(document.tables)
    for header, body in zip(tables, tables[1:]):
        if not _is_kak_university_header(header) or not _is_kak_university_body(body):
            continue
        for row in list(body._tbl.tr_lst):
            header._tbl.append(deepcopy(row))
        body._tbl.getparent().remove(body._tbl)
        return 1
    return 0


def _agenda_half_table(table, labels):
    if len(table.rows) < 2 or len(table.columns) != 2:
        return False
    row_cells = _logical_row_cells(table.rows[0])
    return [
        _normalized_label(cell.text) for cell in row_cells
    ] == list(labels)


def _copy_kak_table_cell(source, target):
    """Clone editable cell contents and visual attributes without rasterising."""
    _copy_cell_format(source, target)
    for child in list(target._tc):
        if child.tag != qn("w:tcPr"):
            target._tc.remove(child)
    for child in source._tc:
        if child.tag != qn("w:tcPr"):
            target._tc.append(deepcopy(child))


def _copy_kak_row_properties(source, target):
    source_properties = source._tr.trPr
    target_properties = target._tr.trPr
    if target_properties is not None:
        target._tr.remove(target_properties)
    if source_properties is not None:
        target._tr.insert(0, deepcopy(source_properties))


def _merge_kak_agenda_halves(document):
    """Restore 4-column agenda tables parsed as separate left/right halves."""
    left_tables = [
        table
        for table in document.tables
        if _agenda_half_table(table, ("no", "waktu"))
    ]
    right_tables = [
        table
        for table in document.tables
        if _agenda_half_table(table, ("agenda", "keterangan"))
    ]
    repaired = 0
    used_right_tables = set()
    for left in left_tables:
        right = next(
            (
                candidate
                for candidate in right_tables
                if candidate._tbl not in used_right_tables
                and len(candidate.rows) == len(left.rows)
            ),
            None,
        )
        if right is None:
            continue

        rebuilt = document.add_table(rows=len(left.rows), cols=4)
        if left._tbl.tblPr is not None:
            current_properties = rebuilt._tbl.tblPr
            if current_properties is not None:
                rebuilt._tbl.remove(current_properties)
            rebuilt._tbl.insert(0, deepcopy(left._tbl.tblPr))

        for row_index, (left_row, right_row) in enumerate(
            zip(left.rows, right.rows)
        ):
            target_row = rebuilt.rows[row_index]
            _copy_kak_row_properties(right_row, target_row)
            for column_index, source_cell in enumerate(
                _logical_row_cells(left_row) + _logical_row_cells(right_row)
            ):
                _copy_kak_table_cell(
                    source_cell,
                    target_row.cells[column_index],
                )

        _set_table_geometry(rebuilt, [716, 1704, 3696, 2614])
        _set_table_indent(rebuilt, _table_indent(left))
        left._tbl.addprevious(rebuilt._tbl)
        left._tbl.getparent().remove(left._tbl)
        right._tbl.getparent().remove(right._tbl)
        used_right_tables.add(right._tbl)
        repaired += 1
    return repaired


def _normalize_kak_tabs(document):
    """Use natural Word wrapping instead of PDF-positioning tab stops."""
    repaired = 0
    for paragraph in iter_document_paragraphs(document):
        text = paragraph.text
        if "\t" not in text or "KERANGKA ACUAN KEGIATAN (KAK)" in text.upper():
            continue

        previous = ""
        pending_space = False
        for run in paragraph.runs:
            rewritten = []
            for character in run.text:
                if character == "\t":
                    if previous and not previous.isspace():
                        pending_space = True
                    repaired += 1
                    continue
                if pending_space and not character.isspace():
                    rewritten.append(" ")
                    previous = " "
                pending_space = False
                rewritten.append(character)
                previous = character
            rewritten_text = "".join(rewritten)
            if rewritten_text != run.text:
                run.text = rewritten_text
    return repaired


def _kak_umum_table_widths(table):
    """Keep the KAK summary labels and values on their original columns."""
    total_width = 0
    label_width = 0
    value_width = 0
    prefix_widths = []
    for row in table.rows:
        cells = _logical_row_cells(row)
        if any("DASAR HUKUM" in cell.text.upper() for cell in cells):
            break
        if len(cells) < 2:
            continue
        row_width = sum(_cell_dxa_width(cell) for cell in cells)
        total_width = max(total_width, row_width)
        if len(cells) < 3:
            continue
        label_width = max(label_width, _cell_dxa_width(cells[1]))
        value_width = max(value_width, _cell_dxa_width(cells[-1]))
        for cell in cells[1:-1]:
            if _cell_grid_span(cell) == 1:
                width = _cell_dxa_width(cell)
                if width > 0:
                    prefix_widths.append(width)

    if not all((total_width, label_width, value_width)):
        return []
    first_column = max(1, total_width - label_width - value_width)
    prefix = min(prefix_widths, default=round(label_width / 3))
    if prefix >= label_width:
        prefix = round(label_width / 3)
    remaining = max(2, label_width - prefix)
    middle_left = round(remaining / 2)
    return [
        first_column,
        prefix,
        middle_left,
        remaining - middle_left,
        value_width,
    ]


def _normalize_kak_agenda_sections(document):
    """Undo the temporary two-column section used for split agenda halves."""
    repaired = 0
    for section in document.sections:
        properties = section._sectPr
        columns = properties.find(qn("w:cols"))
        if columns is None or columns.get(qn("w:num"), "1") == "1":
            continue
        properties.remove(columns)
        section_type = properties.find(qn("w:type"))
        if (
            section_type is not None
            and section_type.get(qn("w:val")) == "nextColumn"
        ):
            section_type.set(qn("w:val"), "continuous")
        repaired += 1
    return repaired


def _kak_body_section_blocks(document):
    """Return body blocks grouped by the source page section breaks.

    pdf2docx represents each source PDF page with a ``sectPr`` paragraph.
    Looking at the original block order before tables are merged lets us
    distinguish a real page break from a paragraph/table that merely spilled
    one line onto the next page.
    """
    sections = []
    current = []
    body = document.element.body
    for block in body.iterchildren():
        current.append(block)
        if (
            block.tag == qn("w:p")
            and block.find("./" + qn("w:pPr") + "/" + qn("w:sectPr"))
            is not None
        ):
            sections.append(current)
            current = []
    if current:
        sections.append(current)
    return sections


def _kak_xml_block_kind(block):
    tag = block.tag.rsplit("}", 1)[-1]
    if tag == "tbl":
        rows = block.findall("./" + qn("w:tr"))
        return "tbl", max(
            (len(row.findall("./" + qn("w:tc"))) for row in rows),
            default=0,
        )
    if tag == "p":
        text = re.sub(r"\s+", " ", "".join(block.itertext())).strip()
        return "p", text
    return tag, ""


def _kak_is_body_header_text(text):
    normalized = re.sub(r"\s+", " ", text).strip().upper()
    return (
        "KERANGKA ACUAN KEGIATAN (KAK)" in normalized
        and "LOMBA RISET TINGKAT MAHASISWA" in normalized
    )


def _kak_section_content(blocks):
    """Yield non-empty blocks, excluding repeated positioned page headers."""
    for block in blocks:
        kind, value = _kak_xml_block_kind(block)
        if kind == "p":
            if not value or _kak_is_body_header_text(value):
                continue
        elif kind == "tbl":
            if value <= 0:
                continue
        else:
            continue
        yield block, kind, value


def _kak_section_has_signature(blocks):
    text = " ".join(
        value
        for _, kind, value in _kak_section_content(blocks)
        if kind == "p"
    ).casefold()
    return "ditandatangani" in text or "alfansyah" in text


def _normalize_kak_page_sections(document):
    """Allow genuine cross-page overflow to continue without blank pages.

    A source PDF page break is normally retained as ``NEW_PAGE``.  When a
    long paragraph or a split table has already consumed the following page,
    however, retaining that break creates a mostly blank page and pushes the
    next section one page too far.  We only relax breaks that are recognisable
    continuations (lower-case prose, an agenda continuation heading/row, or an
    RAB appendix after the electronic-signature block), leaving ordinary
    section starts untouched.
    """
    sections = _kak_body_section_blocks(document)
    if len(sections) < 2 or len(document.sections) < 2:
        return 0

    continuous_indices = set()
    header_removal_indices = set()
    for index in range(1, min(len(sections), len(document.sections))):
        previous = list(_kak_section_content(sections[index - 1]))
        current = list(_kak_section_content(sections[index]))
        if not previous or not current:
            continue
        previous_block, previous_kind, previous_value = previous[-1]
        first_block, first_kind, first_value = current[0]

        if previous_kind == "p" and first_kind == "p":
            first_text = first_value.lstrip()
            # A lower-case continuation after a non-terminal paragraph is a
            # reliable signal that the preceding source page overflowed.
            if (
                first_text[:1].islower()
                and not re.search(r"[.!?:;]\s*$", previous_value)
            ):
                continuous_indices.add(index)
                header_removal_indices.add(index)

        if previous_kind == "tbl" and first_kind == "p":
            first_text = first_value.lstrip()
            if (
                re.match(r"[a-z]\s*\.\s*", first_text)
                or re.match(
                    r"(?:Ruang\s+Presentasi|Hari\s+\d+|Ballroom(?:\s+Utama)?)",
                    first_text,
                    re.IGNORECASE,
                )
            ):
                continuous_indices.add(index)
                header_removal_indices.add(index)

        if previous_kind == "tbl" and first_kind == "tbl":
            # Continuation tables start with a row number/blank cell instead
            # of a column heading.  Do not merge the compact 10-column
            # schedule's page break; its continuation naturally starts at the
            # top of the next page and should keep its page header.
            first_row = first_block.find("./" + qn("w:tr"))
            first_cell = ""
            if first_row is not None:
                first_cell_element = first_row.find("./" + qn("w:tc"))
                if first_cell_element is not None:
                    first_cell = re.sub(
                        r"\s+", " ", "".join(first_cell_element.itertext())
                    ).strip()
            if first_value in {3, 4, 8} and (
                not first_cell or re.match(r"(?:\d+[A-Z]?|[A-Z])$", first_cell)
            ):
                continuous_indices.add(index)
                header_removal_indices.add(index)

        # The RAB appendix follows the signed estimate on the preceding page;
        # it may be forced onto a new page by Word, but keeping the section
        # continuous avoids an otherwise empty intermediate page.
        if (
            first_kind == "tbl"
            and first_value == 8
            and _kak_section_has_signature(sections[index - 1])
        ):
            continuous_indices.add(index)

    repaired = 0
    for index in sorted(continuous_indices):
        if index >= len(document.sections):
            continue
        section = document.sections[index]
        if section.start_type != WD_SECTION_START.CONTINUOUS:
            section.start_type = WD_SECTION_START.CONTINUOUS
            repaired += 1

    # Positioned header text is a body paragraph in pdf2docx, not a real
    # Word header.  If a continuation section shares a page with its
    # predecessor, retaining that paragraph would place the header in the
    # middle of the page.  Remove it only for the continuation patterns above;
    # normal page-start headers remain available.
    for index in sorted(header_removal_indices):
        if index >= len(sections):
            continue
        for block in sections[index]:
            kind, value = _kak_xml_block_kind(block)
            if kind == "p" and _kak_is_body_header_text(value):
                parent = block.getparent()
                if parent is not None:
                    parent.remove(block)
                    repaired += 1
    return repaired


def _collapse_kak_signature_spacing(text):
    """Collapse character-positioned signature text into editable words."""
    if not text or not re.search(r"\s", text):
        return text
    tokens = text.split()
    if not tokens:
        return text

    output = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if len(token) != 1 or not token.isalnum():
            output.append(token)
            index += 1
            continue
        sequence = []
        while (
            index < len(tokens)
            and len(tokens[index]) == 1
            and tokens[index].isalnum()
        ):
            sequence.append(tokens[index])
            index += 1
        joined = "".join(sequence)
        joined = re.sub(r"(?<=\d)(?=[A-Za-z])", " ", joined)
        joined = re.sub(r"(?<=[A-Za-z])(?=\d)", " ", joined)
        joined = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", joined)
        output.append(joined)
    return " ".join(output)


def _normalize_kak_signature_paragraphs(document):
    """Make positioned electronic-signature blocks readable and editable."""
    repaired = 0
    for paragraph in document.paragraphs:
        raw = re.sub(r"\s+", " ", paragraph.text).strip()
        spaced_signature = bool(
            re.search(r"J\s*a\s*k\s*a\s*r\s*t\s*a", raw, re.IGNORECASE)
            or re.search(r"D\s*i\s*r\s*e\s*k\s*t\s*u\s*r", raw, re.IGNORECASE)
        )
        if not (
            spaced_signature
            or "ditandatangani secara elektronik" in raw.casefold()
        ):
            continue

        for run in paragraph.runs:
            collapsed = _collapse_kak_signature_spacing(run.text)
            if collapsed != run.text:
                run.text = collapsed
                repaired += 1

        formatting = paragraph.paragraph_format
        # pdf2docx uses absolute PDF coordinates as a huge left/right indent.
        # Keep the signature on the right half of the page, but give each line
        # enough width for an ordinary editable phrase.
        if formatting.left_indent is not None and formatting.left_indent > Inches(2.5):
            formatting.left_indent = Inches(3.6)
            formatting.right_indent = 0
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
            repaired += 1
    return repaired


def _normalize_kak_prose_spacing(document):
    """Keep long 12pt KAK prose on its intended PDF page.

    pdf2docx represents the source's compact Arial lines as 245-twip Word
    lines.  On a full A4 narrative page that is enough to push only one or
    two lines to an otherwise empty page.  Restrict the correction to long
    document-body prose, never tables, headings, or the cover.
    """
    repaired = 0
    for paragraph in document.paragraphs:
        text = re.sub(r"\s+", " ", paragraph.text).strip()
        if len(text) < 180 or "KERANGKA ACUAN" in text.upper():
            continue
        sizes = [
            run.font.size.pt
            for run in paragraph.runs
            if run.font.size is not None
        ]
        if not sizes or max(sizes) < 11.5:
            continue
        if paragraph.paragraph_format.line_spacing == 0.98:
            continue
        paragraph.paragraph_format.line_spacing = 0.98
        repaired += 1
    return repaired


def _align_kak_agenda_headings(document):
    repaired = 0
    for paragraph in document.paragraphs:
        if not re.fullmatch(r"\s*BALLROOM(?:\s+UTAMA)?\s*", paragraph.text):
            continue
        paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
        paragraph.paragraph_format.left_indent = Inches(0.44)
        paragraph.paragraph_format.right_indent = 0
        paragraph.paragraph_format.first_line_indent = 0
        repaired += 1
    return repaired


def _restore_kak_subheading_breaks(document):
    """Restore a source line break lost when a positioned KAK tab is removed."""
    repaired = 0
    anchor = "MAKSUD, TUJUAN DAN PENERIMA MANFAAT"
    subheading = "a. Maksud dan Tujuan Kegiatan"
    for paragraph in document.paragraphs:
        if anchor not in paragraph.text.upper():
            continue
        for run in paragraph.runs:
            if subheading not in run.text or "\n" + subheading in run.text:
                continue
            run.text = run.text.replace(subheading, "\n" + subheading, 1)
            repaired += 1
            break
    return repaired


def _repair_kak_table_geometry(document):
    """Apply the original physical column proportions to KAK activity grids."""
    repaired = 0
    for table in document.tables:
        column_count = len(table.columns)
        if column_count not in {3, 4, 5, 8, 9, 10}:
            continue
        table_text = _normalized_table_text(table)
        if column_count == 10:
            # The schedule grid has a compact number column, a wide activity
            # column, and eight narrow week columns.  These are the measured
            # physical proportions of the source PDF (page 5/6), rather than
            # the equal-width grid emitted by pdf2docx.
            widths = _scaled_kak_reference_widths(
                [25.65, 154.54, 31.70, 30.58, 31.03,
                 35.05, 35.05, 35.05, 31.15, 35.35],
                8800,
            )
        elif column_count == 8:
            # RAB attachment tables use eight physical columns.  The second
            # (Uraian) column is intentionally wide while NO, Hari/Unit and
            # the monetary columns retain their compact source widths.
            widths = _scaled_kak_reference_widths(
                [32.17, 123.50, 33.22, 58.46,
                 21.90, 48.70, 74.04, 80.46],
                9200,
            )
        else:
            widths = (
                _kak_umum_table_widths(table)
                if column_count == 5 and "UMUM" in table_text
                else _table_cell_grid_widths(table)
            )
        if not widths:
            continue

        if column_count == 10:
            maximum_width = 8800
        elif column_count == 8:
            maximum_width = 9200
        elif column_count == 9:
            maximum_width = 8300
        elif column_count == 4:
            maximum_width = 9000
        elif column_count == 5:
            maximum_width = 9900
        else:
            maximum_width = 8500
        widths = _fit_table_widths(widths, maximum_width)
        _set_table_geometry(table, widths)

        # The source spacing is retained where it fits, but never allows a
        # fixed-layout grid to leave the printable A4 area.
        available_indent = max(0, 10000 - sum(widths))
        _set_table_indent(table, min(_table_indent(table), available_indent))
        repaired += 1
    return repaired


def _repair_kak_layout(document):
    repaired = _normalize_kak_page_sections(document)
    repaired += _normalize_kak_signature_paragraphs(document)
    repaired += _merge_kak_university_tables(document)
    agenda_repairs = _merge_kak_agenda_halves(document)
    repaired += agenda_repairs
    if agenda_repairs:
        repaired += _normalize_kak_agenda_sections(document)
    repaired += _normalize_kak_tabs(document)
    repaired += _restore_kak_subheading_breaks(document)
    repaired += _normalize_kak_prose_spacing(document)
    repaired += _align_kak_agenda_headings(document)
    repaired += _repair_kak_table_geometry(document)
    repaired += _restore_bpdp_header_rule(
        document,
        "KERANGKA ACUAN KERJA",
        anchor_markers=("BADAN PENGELOLA DANA PERKEBUNAN",),
    )
    return repaired


def _append_cell_text_like(cell, text):
    template_paragraph = cell.paragraphs[-1]
    template_run = next(
        (run for run in template_paragraph.runs if run.text),
        None,
    )
    paragraph = cell.add_paragraph()
    if template_paragraph._p.pPr is not None:
        if paragraph._p.pPr is not None:
            paragraph._p.remove(paragraph._p.pPr)
        paragraph._p.insert(0, deepcopy(template_paragraph._p.pPr))
    run = paragraph.add_run(text)
    if template_run is not None and template_run._r.rPr is not None:
        run._r.insert(0, deepcopy(template_run._r.rPr))


def _is_item_number(text):
    return re.fullmatch(r"\s*\d+[.)]\s*", text) is not None


def _is_total_label(text):
    return _normalized_label(text) in {"jumlah", "total"}


def _looks_like_calculation(text):
    return re.search(r"\d+\s*[x\u00d7]\s*\d", text, re.IGNORECASE) is not None


def _find_total_row_index(table, header_index):
    for index in range(header_index + 1, len(table.rows)):
        cells = _logical_row_cells(table.rows[index])
        if cells and _is_total_label(cells[0].text):
            return index
    return None


def _set_row_minimum_height(row, twips):
    row_properties = row._tr.get_or_add_trPr()
    height = row_properties.find(qn("w:trHeight"))
    existing = 0
    if height is not None:
        try:
            existing = int(height.get(qn("w:val"), "0"))
        except ValueError:
            existing = 0
    _set_row_height(row, max(existing, twips))


def _minimum_expense_row_height(row, default=360):
    line_count = max(
        (cell.text.count("\n") + 1 for cell in _logical_row_cells(row)),
        default=1,
    )
    return max(default, 360 * line_count)


def _repair_nota_riil_row_layout(table):
    """Repair any-length Nota Riil tables without assuming one expense row."""
    header_index = _expense_header_index(table)
    if header_index is None:
        return 0
    total_index = _find_total_row_index(table, header_index)
    if total_index is None or total_index <= header_index + 1:
        return 0

    item_rows = []
    for index in range(header_index + 1, total_index):
        cells = _logical_row_cells(table.rows[index])
        if len(cells) >= 3 and _is_item_number(cells[0].text):
            item_rows.append((index, cells))
    if not item_rows:
        return 0

    changes = 0
    total_row = table.rows[total_index]
    total_cells = _logical_row_cells(total_row)
    total_label = total_cells[0].text.strip()
    middle_cells = total_cells[1:-1]
    calculation = " ".join(
        cell.text.strip() for cell in middle_cells if cell.text.strip()
    )
    moved_calculation = False
    if len(total_cells) >= 4 and _looks_like_calculation(calculation):
        # pdf2docx may split the final item's calculation across surplus grid
        # columns in the total row. The source keeps it under Uraian.
        description = item_rows[-1][1][1]
        existing_description = re.sub(r"\s+", " ", description.text).strip()
        if calculation not in existing_description:
            _append_cell_text_like(description, calculation)
            changes += 1
        moved_calculation = True

    middle_has_content = any(cell.text.strip() for cell in middle_cells)
    if (
        len(total_cells) >= 3
        and (moved_calculation or not middle_has_content)
        and total_row.cells[0]._tc is not total_row.cells[-2]._tc
    ):
        # The source's final label spans the number and description columns.
        merged_total = total_row.cells[0].merge(total_row.cells[-2])
        _set_cell_text_like(merged_total, total_label, merged_total)
        changes += 1

    # pdf2docx exports exact short rows. Make them source-sized minimums so
    # added lines and future multi-item forms can expand instead of clipping.
    if moved_calculation:
        _set_row_height(table.rows[header_index], 420)
    else:
        _set_row_minimum_height(table.rows[header_index], 420)
    for index, _ in item_rows:
        target_height = _minimum_expense_row_height(table.rows[index])
        if moved_calculation:
            _set_row_height(table.rows[index], target_height)
        else:
            _set_row_minimum_height(table.rows[index], target_height)
    if moved_calculation:
        _set_row_height(table.rows[total_index], 420)
    else:
        _set_row_minimum_height(table.rows[total_index], 420)
    return changes


def _repair_nota_riil_expense_tables(document):
    repaired = _recover_collapsed_nota_riil_tables(document)
    # pdf2docx occasionally places a perfectly valid nested grid inside an
    # exact-height stack of empty one-cell tables. Word clips that stack, so
    # promote the grid before applying ordinary border/row repairs.
    repaired += _promote_clipped_nota_riil_tables(document)
    for table in iter_document_tables(document):
        if not _is_nota_riil_expense_table(table):
            continue
        _set_table_grid_borders(table)
        repaired += 1 + _repair_nota_riil_row_layout(table)
    return repaired


def _repair_paragraph_runs(
    paragraph,
    reference_pages,
    min_compact_chars,
    reference_index,
    prefer_richest_spacing,
):
    runs = paragraph.runs
    if not runs:
        return 0
    text = "".join(run.text for run in runs)
    insertions = _missing_space_positions(
        text,
        reference_pages,
        min_compact_chars=min_compact_chars,
        reference_index=reference_index,
        prefer_richest_spacing=prefer_richest_spacing,
    )
    if not insertions:
        return 0

    cursor = 0
    for run in runs:
        run_text = run.text
        start = cursor
        end = start + len(run_text)
        local_insertions = {
            position - start for position in insertions if start <= position < end
        }
        if local_insertions:
            run.text = "".join(
                (" " if index in local_insertions else "") + char
                for index, char in enumerate(run_text)
            )
        cursor = end
    return len(insertions)


def _ensure_nd_numbered_heading_space(paragraph, reference_pages):
    runs = paragraph.runs
    if not runs:
        return 0
    text = "".join(run.text for run in runs)
    match = re.match(r"^(\s*\d+\.)(\S)", text)
    if not match:
        return 0

    number = match.group(1).strip()
    heading_start = match.start(2)
    heading_sample = text[heading_start:heading_start + 24]
    source_pattern = re.compile(
        rf"(?im)^\s*{re.escape(number)}\s+{re.escape(heading_sample)}"
    )
    if not any(source_pattern.search(reference) for reference in reference_pages):
        return 0

    cursor = 0
    for run in runs:
        end = cursor + len(run.text)
        if cursor <= heading_start < end:
            local_position = heading_start - cursor
            run.text = (
                run.text[:local_position]
                + " "
                + run.text[local_position:]
            )
            return 1
        cursor = end
    return 0


def _normalize_nd_layout_runs(paragraph, reference_pages):
    """Remove pdf2docx continuation tabs and portable-symbol font artifacts.

    pdf2docx represents every wrapped line in some numbered ND paragraphs with
    a tab. Once missing spaces are restored, those tabs may land in the middle
    of a reflowed line and create large browser/device-dependent gaps. Keep the
    first list-marker tab, but let Word naturally wrap every continuation.
    """
    runs = paragraph.runs
    if not runs:
        return 0

    original_text = "".join(run.text for run in runs)
    tab_count = original_text.count("\t")
    keep_first_tab = (
        tab_count > 1
        and re.match(r"^\s*(?:\d+[.)]|[A-Za-z][.)])\s*\t", original_text)
        is not None
    )

    changes = _ensure_nd_numbered_heading_space(paragraph, reference_pages)
    seen_tabs = 0
    output_tail = ""
    for run in runs:
        rewritten = []
        for character in run.text:
            if character != "\t":
                rewritten.append(character)
                output_tail = character
                continue

            seen_tabs += 1
            if tab_count <= 1 or (keep_first_tab and seen_tabs == 1):
                rewritten.append(character)
                output_tail = character
                continue

            # Converted line fragments normally end with a space. If they do
            # not, preserve the word boundary while removing the tab stop.
            if not output_tail.isspace():
                rewritten.append(" ")
                output_tail = " "
            changes += 1

        rewritten_text = "".join(rewritten)
        if "\uf0b7" in rewritten_text:
            rewritten_text = rewritten_text.replace("\uf0b7", "• ")
            run.font.name = next(
                (
                    candidate.font.name
                    for candidate in runs
                    if candidate is not run and candidate.font.name
                ),
                "Arial",
            )
            changes += 1
        if rewritten_text != run.text:
            run.text = rewritten_text

    if keep_first_tab and seen_tabs > 1:
        paragraph_format = paragraph.paragraph_format
        current_left = paragraph_format.left_indent or 0
        tab_positions = [
            tab_stop.position
            for tab_stop in paragraph_format.tab_stops
            if tab_stop.position > current_left
        ]
        if tab_positions:
            continuation_left = min(tab_positions)
            paragraph_format.left_indent = continuation_left
            paragraph_format.first_line_indent = (
                current_left - continuation_left
            )

    return changes


def _extract_tembusan_entries(reference_pages):
    candidates = []
    entry_pattern = re.compile(
        r"(?ms)^\s*(\d+)\.\s+(.+?)(?=^\s*\d+\.\s+|\Z)"
    )
    for reference in reference_pages:
        match = re.search(r"(?i)\bTembusan\s*:", reference)
        if not match:
            continue

        tail = reference[match.end():]
        entries = []
        for number_text, content in entry_pattern.findall(tail):
            number = int(number_text)
            if number != len(entries) + 1:
                break
            content = re.split(
                r"(?im)^\s*(?:Dokumen ini telah|Ditandatangani secara|https?://)",
                content,
                maxsplit=1,
            )[0]
            normalized = re.sub(r"\s+", " ", content).strip()
            if not normalized:
                break
            entries.append(normalized)

        if 2 <= len(entries) <= 25:
            candidates.append(entries)

    if not candidates:
        return []
    # Block-level extraction usually isolates the list while a full-page
    # extraction may also include the electronic-signature footer.
    return max(candidates, key=lambda items: (len(items), -sum(map(len, items))))


def _copy_cell_format(source_cell, target_cell):
    source_properties = source_cell._tc.tcPr
    target_properties = target_cell._tc.tcPr
    if target_properties is not None:
        target_cell._tc.remove(target_properties)
    if source_properties is not None:
        target_cell._tc.insert(0, deepcopy(source_properties))


def _set_cell_text_like(cell, text, template_cell):
    template_paragraph = template_cell.paragraphs[0]
    template_run = next(
        (run for run in template_paragraph.runs if run.text),
        None,
    )

    cell.text = ""
    paragraph = cell.paragraphs[0]
    if template_paragraph._p.pPr is not None:
        if paragraph._p.pPr is not None:
            paragraph._p.remove(paragraph._p.pPr)
        paragraph._p.insert(0, deepcopy(template_paragraph._p.pPr))
    run = paragraph.add_run(text)
    if template_run is not None and template_run._r.rPr is not None:
        run._r.insert(0, deepcopy(template_run._r.rPr))


def _repair_nd_tembusan_tables(document, reference_pages):
    if not any("tembusan:" in paragraph.text.casefold() for paragraph in document.paragraphs):
        return 0

    entries = _extract_tembusan_entries(reference_pages)
    if not entries:
        return 0

    expected_numbers = list(range(1, len(entries) + 1))
    for table in document.tables:
        if len(table.rows) != 1 or len(table.columns) < 2:
            continue
        detected_numbers = [
            int(number)
            for number in re.findall(r"\b(\d+)\.", table.cell(0, 0).text)
        ]
        if detected_numbers != expected_numbers:
            continue

        number_template = table.cell(0, 0)
        text_template = table.cell(0, 1)
        for index, entry in enumerate(entries):
            row = table.rows[0] if index == 0 else table.add_row()
            row.height = None
            row.height_rule = None
            _copy_cell_format(number_template, row.cells[0])
            _copy_cell_format(text_template, row.cells[1])
            _set_cell_text_like(row.cells[0], f"{index + 1}.", number_template)
            _set_cell_text_like(row.cells[1], entry, text_template)
            number_paragraph = row.cells[0].paragraphs[0]
            number_paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            number_paragraph.paragraph_format.left_indent = 0
            number_paragraph.paragraph_format.right_indent = 0
            number_paragraph.paragraph_format.first_line_indent = 0
        return len(entries)
    return 0


def repair_editable_docx(
    output,
    reference_pages,
    nota_dinas=False,
    nota_riil=False,
    rincian_biaya_perjalanan_dinas=False,
    kak=False,
):
    if not reference_pages or not any(page.strip() for page in reference_pages):
        return 0

    document = Document(output)
    reference_index = _build_reference_index(reference_pages)
    # ND fields contain many short labels/values. Other document types use a
    # higher threshold so generic conversion stays conservative.
    min_compact_chars = 6 if nota_dinas else 12
    paragraphs = list(iter_document_paragraphs(document))
    restored = sum(
        _repair_paragraph_runs(
            paragraph,
            reference_pages,
            min_compact_chars,
            reference_index,
            nota_dinas or kak,
        )
        for paragraph in paragraphs
    )
    normalized = (
        sum(
            _normalize_nd_layout_runs(paragraph, reference_pages)
            for paragraph in paragraphs
        )
        if nota_dinas
        else 0
    )
    if nota_dinas:
        normalized += _repair_nd_tembusan_tables(document, reference_pages)
    table_repairs = (
        _repair_nota_riil_expense_tables(document)
        if nota_riil
        else 0
    )
    if nota_riil:
        table_repairs += _restore_bpdp_header_rule(
            document, "DAFTAR PENGELUARAN RIIL"
        )
        table_repairs += _restore_form_title_underline(
            document, "DAFTAR PENGELUARAN RIIL"
        )
    table_repairs += (
        _repair_rincian_biaya_shading(document)
        if rincian_biaya_perjalanan_dinas
        else 0
    )
    if rincian_biaya_perjalanan_dinas:
        table_repairs += _restore_bpdp_header_rule(
            document, "RINCIAN BIAYA PERJALANAN DINAS"
        )
        table_repairs += _restore_form_title_underline(
            document, "RINCIAN BIAYA PERJALANAN DINAS"
        )
        table_repairs += _repair_rincian_biaya_payment_band(document)
        table_repairs += _repair_rincian_biaya_payment_caption_flow(document)
        table_repairs += _remove_rincian_title_placeholder_border(document)
    if kak:
        table_repairs += _repair_kak_layout(document)
    if restored or normalized or table_repairs:
        document.save(output)
    # Keep the public count compatible with the existing text-repair metric;
    # grid restoration is a layout-only correction.
    return restored


def _editable_conversion_settings(nota_dinas):
    if not nota_dinas:
        return {}
    return {
        # ND body copy is line-oriented. Slightly lower break thresholds keep
        # wrapped sentences together without disabling lattice-table parsing.
        "line_break_width_ratio": 0.45,
        "line_break_free_space_ratio": 0.08,
        "new_paragraph_free_space_ratio": 0.9,
    }


def convert_editable(
    source,
    output,
    workspace,
    reference_pages=None,
    nota_dinas=False,
    nota_riil=False,
    rincian_biaya_perjalanan_dinas=False,
    kak=False,
):
    emit({"type": "progress", "stage": "repairing", "progress": 12})
    repaired = normalize_with_qpdf(source, workspace)
    emit({"type": "progress", "stage": "converting", "progress": 32})
    settings = _editable_conversion_settings(nota_dinas)
    try:
        converter = Converter(repaired)
        try:
            converter.convert(output, **settings)
        finally:
            converter.close()
    except Exception:
        # Invalid embedded-font/xref references are common in PDFs exported by
        # third-party office systems. Rewriting the visual PDF removes those
        # broken objects, then pdf2docx gets one clean retry.
        emit({"type": "progress", "stage": "repairing", "progress": 50})
        normalized = normalize_with_ghostscript(repaired, workspace)
        if not normalized:
            fail("INVALID_PDF_STRUCTURE")
        try:
            converter = Converter(normalized)
            try:
                converter.convert(output, **settings)
            finally:
                converter.close()
        except Exception:
            fail("FONT_OR_LAYOUT_UNSUPPORTED")
    emit({"type": "progress", "stage": "optimizing", "progress": 88})
    repair_editable_docx(
        output,
        reference_pages or [],
        nota_dinas=nota_dinas,
        nota_riil=nota_riil,
        rincian_biaya_perjalanan_dinas=rincian_biaya_perjalanan_dinas,
        kak=kak,
    )


def page_size_inches(page):
    return page.rect.width / 72.0, page.rect.height / 72.0


def convert_visual(document, output):
    docx = Document()
    total = len(document)
    for index, page in enumerate(document):
        width, height = page_size_inches(page)
        section = docx.sections[0] if index == 0 else docx.add_section()
        section.page_width = Inches(width)
        section.page_height = Inches(height)
        section.left_margin = Inches(0.18)
        section.right_margin = Inches(0.18)
        section.top_margin = Inches(0.18)
        section.bottom_margin = Inches(0.18)
        pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        image = io.BytesIO(pix.tobytes("png"))
        docx.add_picture(image, width=Inches(max(0.1, width - 0.36)))
        emit({"type": "progress", "stage": "rendering", "progress": 18 + 75 * (index + 1) / total, "currentPage": index + 1, "totalPages": total})
    docx.save(output)


def convert_ocr(document, output):
    docx = Document()
    total = len(document)
    for index, page in enumerate(document):
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        image = Image.open(io.BytesIO(pix.tobytes("png")))
        text = pytesseract.image_to_string(image, lang="ind+eng")
        if text.strip():
            for paragraph in text.splitlines():
                docx.add_paragraph(paragraph)
        else:
            docx.add_paragraph("")
        if index < total - 1:
            docx.add_page_break()
        emit({"type": "progress", "stage": "ocr", "progress": 18 + 75 * (index + 1) / total, "currentPage": index + 1, "totalPages": total})
    docx.save(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--mode", choices=["editable", "ocr", "visual"], required=True)
    parser.add_argument("--max-pages", type=int, required=True)
    args = parser.parse_args()
    workspace = tempfile.mkdtemp(prefix="igo-docx-")
    try:
        emit({"type": "progress", "stage": "validating", "progress": 5})
        try:
            document = fitz.open(args.input)
        except Exception:
            fail("INVALID_PDF_STRUCTURE")
        try:
            if document.needs_pass:
                fail("ENCRYPTED_PDF")
            total = len(document)
            if total <= 0:
                fail("INVALID_PDF_STRUCTURE")
            if total > args.max_pages:
                fail("PAGE_LIMIT")
            emit({"type": "progress", "stage": "analyzing", "progress": 10, "currentPage": 0, "totalPages": total})
            if args.mode == "editable":
                reference_pages = extract_reference_pages(document)
                nota_dinas = is_nota_dinas(reference_pages)
                nota_riil = is_nota_riil(reference_pages)
                rincian_biaya_perjalanan_dinas = (
                    is_rincian_biaya_perjalanan_dinas(reference_pages)
                )
                kak = is_kak(reference_pages)
                document.close()
                convert_editable(
                    args.input,
                    args.output,
                    workspace,
                    reference_pages=reference_pages,
                    nota_dinas=nota_dinas,
                    nota_riil=nota_riil,
                    rincian_biaya_perjalanan_dinas=(
                        rincian_biaya_perjalanan_dinas
                    ),
                    kak=kak,
                )
            elif args.mode == "ocr":
                convert_ocr(document, args.output)
            else:
                convert_visual(document, args.output)
            emit({"type": "progress", "stage": "packaging", "progress": 95, "currentPage": total, "totalPages": total})
        finally:
            if not document.is_closed:
                document.close()
    except RuntimeError:
        sys.exit(1)
    except MemoryError:
        emit({"type": "error", "code": "MEMORY_LIMIT"})
        sys.exit(1)
    except Exception:
        emit({"type": "error", "code": "PROCESS_FAILED"})
        sys.exit(1)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()
