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
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches
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


def repair_editable_docx(output, reference_pages, nota_dinas=False):
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
            nota_dinas,
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
    if restored or normalized:
        document.save(output)
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
    source, output, workspace, reference_pages=None, nota_dinas=False
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
        output, reference_pages or [], nota_dinas=nota_dinas
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
                document.close()
                convert_editable(
                    args.input,
                    args.output,
                    workspace,
                    reference_pages=reference_pages,
                    nota_dinas=nota_dinas,
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
