import os
import tempfile
import unittest

from docx import Document
from docx.shared import Inches

try:
    from .docx_convert import (
        is_nota_dinas,
        repair_editable_docx,
        restore_missing_spaces,
    )
except ImportError:
    from docx_convert import (
        is_nota_dinas,
        repair_editable_docx,
        restore_missing_spaces,
    )


class DocxConvertTextRepairTest(unittest.TestCase):
    def test_detects_nota_dinas_without_matching_generic_documents(self):
        self.assertTrue(
            is_nota_dinas(
                ["KEMENTERIAN KEUANGAN\nNOTA DINAS\nNOMOR ND-63/BPDP.100/2026"]
            )
        )
        self.assertFalse(
            is_nota_dinas(["SURAT UNDANGAN\nNOMOR UND-63/BPDP.100/2026"])
        )

    def test_restores_realistic_nd_prose_from_pdf_whitespace(self):
        converted = (
            "Sehubungandenganpelaksanaanmonitoringdananalisisisumediamassadanmediasosial "
            "terkait APBN."
        )
        source = (
            "Sehubungan dengan pelaksanaan monitoring dan analisis isu media massa dan "
            "media sosial terkait APBN."
        )
        self.assertEqual(
            restore_missing_spaces(converted, [source]),
            source,
        )

    def test_restores_table_text_but_keeps_compound_hyphens(self):
        converted = (
            "Daftar ketentuan yang ditetapkanolehmasing-masingPimpinanEselonI."
        )
        source = (
            "Daftar ketentuan yang ditetapkan oleh masing-masing Pimpinan Eselon I."
        )
        self.assertEqual(
            restore_missing_spaces(converted, [source]),
            source,
        )

    def test_restores_table_cell_when_pdf_reading_order_interleaves_columns(self):
        converted = "DaftarsistemyangdigunakanolehUnitEselonI"
        full_page = (
            "Daftar sistem\n"
            "Divisi KLI\n"
            "yang digunakan oleh\n"
            "Unit Eselon I"
        )
        source_block = "Daftar sistem yang digunakan oleh Unit Eselon I"
        self.assertEqual(
            restore_missing_spaces(
                converted, [full_page, source_block], min_compact_chars=6
            ),
            "Daftar sistem yang digunakan oleh Unit Eselon I",
        )

    def test_unicode_casefold_expansion_keeps_reference_offsets_aligned(self):
        self.assertEqual(
            restore_missing_spaces(
                "VorgangTest",
                ["Maß Vorgang Test"],
                min_compact_chars=6,
            ),
            "Vorgang Test",
        )

    def test_leaves_ambiguous_spacing_and_identifiers_untouched(self):
        self.assertEqual(
            restore_missing_spaces("ABCD", ["AB CD", "A BCD"], min_compact_chars=4),
            "ABCD",
        )
        identifier_text = (
            "ABC123/2026 https://contoh.go.id user@example.go.id"
        )
        self.assertEqual(
            restore_missing_spaces(identifier_text, [identifier_text]),
            identifier_text,
        )
        self.assertEqual(
            restore_missing_spaces(
                "ABC123/2026",
                ["ABC 123/2026"],
                min_compact_chars=6,
            ),
            "ABC123/2026",
        )
        self.assertEqual(
            restore_missing_spaces(
                "https://contoh.go.id/path",
                ["https://contoh.go.id/ path"],
                min_compact_chars=6,
            ),
            "https://contoh.go.id/path",
        )
        self.assertEqual(
            restore_missing_spaces("ABCD", ["AB CD"], min_compact_chars=6),
            "ABCD",
        )
        self.assertEqual(
            restore_missing_spaces(
                "turunanatasPermenpan6Tahun2022.",
                ["turunan atas Permenpan 6 Tahun 2022."],
                min_compact_chars=6,
            ),
            "turunan atas Permenpan 6 Tahun 2022.",
        )
        self.assertEqual(
            restore_missing_spaces(
                "PimpinanEselonIpadaperiodeJanuari2026",
                [
                    "PimpinanEselonIpadaperiodeJanuari2026",
                    "Pimpinan Eselon I pada periode Januari 2026",
                ],
                min_compact_chars=6,
                prefer_richest_spacing=True,
            ),
            "Pimpinan Eselon I pada periode Januari 2026",
        )
        self.assertEqual(
            restore_missing_spaces(
                "ditetapkanolehmasing-masingPimpinanEselonIpadaperiodeJanuari2026",
                [
                    "ditetapkan oleh masing-masing Pimpinan Eselon I pada "
                    "periode Januari 2026"
                ],
                min_compact_chars=6,
                prefer_richest_spacing=True,
            ),
            "ditetapkan oleh masing-masing Pimpinan Eselon I pada periode "
            "Januari 2026",
        )

    def test_repairs_body_and_table_runs_without_losing_formatting(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "sample.docx")
            document = Document()
            paragraph = document.add_paragraph()
            bold_run = paragraph.add_run("Sehubungandengan")
            bold_run.bold = True
            paragraph.add_run("\tpelaksanaan")
            table = document.add_table(rows=2, cols=1)
            table.cell(0, 0).text = "Datayangmemuatidentitaspegawai"
            table.cell(1, 0).text = "Laporanyangdapatdisalin"
            document.save(path)

            restored = repair_editable_docx(
                path,
                [
                    "Sehubungan dengan pelaksanaan",
                    "Data yang memuat identitas pegawai",
                    "Laporan yang dapat disalin",
                ],
                nota_dinas=True,
            )

            repaired = Document(path)
            self.assertEqual(
                repaired.paragraphs[0].text,
                "Sehubungan dengan\tpelaksanaan",
            )
            self.assertTrue(repaired.paragraphs[0].runs[0].bold)
            self.assertEqual(
                repaired.tables[0].cell(0, 0).text,
                "Data yang memuat identitas pegawai",
            )
            self.assertEqual(
                repaired.tables[0].cell(1, 0).text,
                "Laporan yang dapat disalin",
            )
            self.assertEqual(restored, 8)

    def test_normalizes_nd_continuation_tabs_and_symbol_bullets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "layout.docx")
            document = Document()
            numbered = document.add_paragraph()
            numbered.add_run("1. ")
            numbered.add_run("\t")
            numbered.add_run("Judul dan kalimat pertama ")
            numbered.add_run("\t")
            numbered.add_run("dilanjutkan secara alami.")
            numbered.paragraph_format.left_indent = Inches(0.1)
            numbered.paragraph_format.tab_stops.add_tab_stop(Inches(0.4))
            bullet = document.add_paragraph()
            symbol = bullet.add_run("\uf0b7")
            symbol.font.name = "SymbolMT"
            body = bullet.add_run("Isi butir yang portabel.")
            body.font.name = "Arial"
            heading = document.add_paragraph()
            heading.add_run("4.")
            heading.add_run("Aktivitas Media Sosial")
            document.save(path)

            restored = repair_editable_docx(
                path,
                [
                    "1. Judul dan kalimat pertama dilanjutkan secara alami.",
                    "\u2022 Isi butir yang portabel.",
                    "4. Aktivitas Media Sosial",
                ],
                nota_dinas=True,
            )

            repaired = Document(path)
            self.assertEqual(
                repaired.paragraphs[0].text,
                "1. \tJudul dan kalimat pertama dilanjutkan secara alami.",
            )
            self.assertEqual(
                repaired.paragraphs[1].text,
                "\u2022 Isi butir yang portabel.",
            )
            self.assertEqual(repaired.paragraphs[1].runs[0].font.name, "Arial")
            self.assertEqual(
                repaired.paragraphs[2].text,
                "4. Aktivitas Media Sosial",
            )
            self.assertEqual(
                repaired.paragraphs[0].paragraph_format.left_indent,
                Inches(0.4),
            )
            self.assertEqual(
                repaired.paragraphs[0].paragraph_format.first_line_indent,
                Inches(-0.3),
            )
            self.assertEqual(restored, 1)

    def test_rebuilds_merged_nd_tembusan_table_from_source_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "tembusan.docx")
            document = Document()
            document.add_paragraph("Tembusan:")
            table = document.add_table(rows=1, cols=2)
            table.cell(0, 0).text = "1.\n2.\n3."
            table.cell(0, 1).text = (
                "Penerima pertama Penerima kedua\nPenerima ketiga"
            )
            document.save(path)

            repair_editable_docx(
                path,
                [
                    "Tembusan:\n"
                    "1. Penerima pertama\n"
                    "2. Penerima kedua\n"
                    "3. Penerima ketiga"
                ],
                nota_dinas=True,
            )

            repaired = Document(path)
            self.assertEqual(len(repaired.tables[0].rows), 3)
            self.assertTrue(
                all(row.height is None for row in repaired.tables[0].rows)
            )
            self.assertEqual(
                [
                    [cell.text for cell in row.cells]
                    for row in repaired.tables[0].rows
                ],
                [
                    ["1.", "Penerima pertama"],
                    ["2.", "Penerima kedua"],
                    ["3.", "Penerima ketiga"],
                ],
            )


if __name__ == "__main__":
    unittest.main()
