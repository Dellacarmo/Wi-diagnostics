"""
Report Generator Module
Generates PDF, Word, and Excel reports with beautiful dashboards.
"""

import os
import json
from datetime import datetime
from typing import Dict, List, Any, Optional


class ReportGenerator:
    """Generates professional diagnostic reports in multiple formats."""

    REPORTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "reports")

    def __init__(self):
        os.makedirs(self.REPORTS_DIR, exist_ok=True)
        self._check_dependencies()

    def _check_dependencies(self):
        """Check which report libraries are available."""
        self.has_reportlab = False
        self.has_docx = False
        self.has_openpyxl = False

        try:
            import reportlab
            self.has_reportlab = True
        except ImportError:
            pass

        try:
            import docx
            self.has_docx = True
        except ImportError:
            pass

        try:
            import openpyxl
            self.has_openpyxl = True
        except ImportError:
            pass

    def generate_all(self, data: Dict[str, Any]) -> Dict[str, str]:
        """Generate reports in all available formats."""
        results = {}

        if self.has_reportlab:
            try:
                path = self.generate_pdf(data)
                results["pdf"] = path
            except Exception as e:
                results["pdf_error"] = str(e)

        if self.has_docx:
            try:
                path = self.generate_word(data)
                results["word"] = path
            except Exception as e:
                results["word_error"] = str(e)

        if self.has_openpyxl:
            try:
                path = self.generate_excel(data)
                results["excel"] = path
            except Exception as e:
                results["excel_error"] = str(e)

        return results

    def _get_timestamp_str(self) -> str:
        return datetime.now().strftime('%Y-%m-%d_%H-%M-%S')

    def generate_pdf(self, data: Dict[str, Any]) -> str:
        """Generate a beautiful PDF report with dashboard."""
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm, cm
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
            Image, PageBreak, HRFlowable
        )
        from reportlab.graphics.shapes import Drawing, Rect, String, Circle, Line
        from reportlab.graphics.charts.barcharts import VerticalBarChart
        from reportlab.graphics.charts.piecharts import Pie
        from reportlab.graphics import renderPDF

        filename = f"wifi_report_{self._get_timestamp_str()}.pdf"
        filepath = os.path.join(self.REPORTS_DIR, filename)

        doc = SimpleDocTemplate(
            filepath, pagesize=A4,
            rightMargin=20*mm, leftMargin=20*mm,
            topMargin=20*mm, bottomMargin=20*mm
        )

        styles = getSampleStyleSheet()

        # Custom styles
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Title'],
            fontSize=28,
            textColor=colors.HexColor('#0A0E17'),
            spaceAfter=6*mm,
            fontName='Helvetica-Bold',
        )

        subtitle_style = ParagraphStyle(
            'CustomSubtitle',
            parent=styles['Normal'],
            fontSize=12,
            textColor=colors.HexColor('#6B7280'),
            spaceAfter=12*mm,
        )

        heading_style = ParagraphStyle(
            'CustomHeading',
            parent=styles['Heading2'],
            fontSize=16,
            textColor=colors.HexColor('#00FFCC'),
            spaceBefore=8*mm,
            spaceAfter=4*mm,
        )

        elements = []

        # Title page
        elements.append(Spacer(1, 40*mm))
        elements.append(Paragraph("🛰️ RF Space Observatory", title_style))
        elements.append(Paragraph("WiFi Network Diagnostic Report", subtitle_style))
        elements.append(HRFlowable(width="80%", thickness=2, color=colors.HexColor('#00FFCC')))
        elements.append(Spacer(1, 10*mm))

        # Report metadata
        meta_data = [
            ["Generated:", datetime.now().strftime('%Y-%m-%d %H:%M:%S')],
            ["Hostname:", data.get("network_config", {}).get("hostname", "N/A")],
            ["Local IP:", data.get("network_config", {}).get("local_ip", "N/A")],
            ["Gateway:", data.get("network_config", {}).get("gateway", "N/A")],
            ["OS:", data.get("network_config", {}).get("os", "N/A")],
        ]
        meta_table = Table(meta_data, colWidths=[40*mm, 80*mm])
        meta_table.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('TEXTCOLOR', (0, 0), (0, -1), colors.HexColor('#6B7280')),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        elements.append(meta_table)

        elements.append(PageBreak())

        # Access Points Summary
        elements.append(Paragraph("📡 Access Points Overview", heading_style))

        aps = data.get("access_points", [])
        if aps:
            # AP table
            ap_table_data = [["Label", "Band", "Channel", "RSSI (dBm)", "Distance (m)", "Quality (%)", "Security"]]

            for ap in sorted(aps, key=lambda x: x.get('rssi_mean', -100), reverse=True):
                ap_table_data.append([
                    ap.get("ssid_label", "N/A"),
                    ap.get("band", "N/A"),
                    str(ap.get("channel", "N/A")),
                    f"{ap.get('rssi_mean', 0):.1f}",
                    f"{ap.get('distance_estimate', 0):.1f}",
                    f"{ap.get('signal_quality', 0):.0f}",
                    ap.get("security", "N/A"),
                ])

            ap_table = Table(ap_table_data, colWidths=[25*mm, 18*mm, 18*mm, 22*mm, 22*mm, 22*mm, 25*mm])
            ap_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0A0E17')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 8),
                ('FONTSIZE', (0, 1), (-1, -1), 7),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#E5E7EB')),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F9FAFB')]),
                ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                ('TOPPADDING', (0, 0), (-1, -1), 4),
            ]))
            elements.append(ap_table)
        else:
            elements.append(Paragraph("No access points data available.", styles['Normal']))

        elements.append(Spacer(1, 10*mm))

        # Signal Strength Chart
        if aps:
            elements.append(Paragraph("📶 Signal Strength Distribution", heading_style))

            drawing = Drawing(400, 200)

            # Bar chart of RSSI values
            chart = VerticalBarChart()
            chart.x = 50
            chart.y = 50
            chart.height = 125
            chart.width = 300
            chart.data = [[ap.get('rssi_mean', -80) for ap in sorted(aps, key=lambda x: x.get('rssi_mean', -100), reverse=True)]]
            chart.categoryAxis.categoryNames = [ap.get('ssid_label', '') for ap in sorted(aps, key=lambda x: x.get('rssi_mean', -100), reverse=True)]
            chart.valueAxis.valueMin = -100
            chart.valueAxis.valueMax = -20
            chart.valueAxis.valueStep = 10
            chart.bars[0].fillColor = colors.HexColor('#00FFCC')
            chart.bars[0].strokeColor = None

            drawing.add(chart)
            elements.append(drawing)

        elements.append(PageBreak())

        # Band Distribution Pie Chart
        if aps:
            elements.append(Paragraph("📊 Frequency Band Distribution", heading_style))

            drawing = Drawing(300, 200)
            pie = Pie()
            pie.x = 75
            pie.y = 25
            pie.width = 150
            pie.height = 150

            band_24 = sum(1 for ap in aps if ap.get('band') == '2.4GHz')
            band_5 = sum(1 for ap in aps if ap.get('band') == '5GHz')

            pie.data = [band_24, band_5]
            pie.labels = [f'2.4GHz ({band_24})', f'5GHz ({band_5})']
            pie.slices[0].fillColor = colors.HexColor('#00FFCC')
            pie.slices[1].fillColor = colors.HexColor('#FF00AA')
            pie.slices.strokeWidth = 0

            drawing.add(pie)
            elements.append(drawing)

        elements.append(Spacer(1, 10*mm))

        # Log Statistics
        log_stats = data.get("log_stats", {})
        if log_stats:
            elements.append(Paragraph("📋 Log Statistics", heading_style))

            log_table_data = [
                ["Metric", "Value"],
                ["Total Logs", str(log_stats.get("total_logs", 0))],
                ["Errors", str(log_stats.get("errors", 0))],
                ["Warnings", str(log_stats.get("warnings", 0))],
                ["Connections", str(log_stats.get("connections", 0))],
                ["Total Outages", str(log_stats.get("total_outages", 0))],
                ["Total Downtime", f"{log_stats.get('total_downtime_seconds', 0):.0f}s"],
                ["Currently Down", "🔴 Yes" if log_stats.get("currently_down") else "🟢 No"],
            ]

            log_table = Table(log_table_data, colWidths=[60*mm, 60*mm])
            log_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0A0E17')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#E5E7EB')),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F9FAFB')]),
            ]))
            elements.append(log_table)

        # Outage details
        outages = data.get("outages", [])
        if outages:
            elements.append(Spacer(1, 8*mm))
            elements.append(Paragraph("🔴 Outage History", heading_style))

            outage_data = [["#", "Start", "End", "Duration (s)"]]
            for i, outage in enumerate(outages, 1):
                outage_data.append([
                    str(i),
                    outage.get("inicio", "N/A"),
                    outage.get("fim", "N/A"),
                    f"{outage.get('duracao_segundos', 0):.0f}",
                ])

            outage_table = Table(outage_data, colWidths=[15*mm, 45*mm, 45*mm, 25*mm])
            outage_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#DC2626')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#E5E7EB')),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#FEF2F2')]),
            ]))
            elements.append(outage_table)

        # Footer
        elements.append(Spacer(1, 20*mm))
        elements.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#E5E7EB')))
        elements.append(Paragraph(
            f"Generated by RF Space Observatory — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            ParagraphStyle('Footer', parent=styles['Normal'], fontSize=8,
                          textColor=colors.HexColor('#9CA3AF'), alignment=1)
        ))

        doc.build(elements)
        print(f"[report_generator] 📄 PDF saved: {filepath}")
        return filepath

    def generate_word(self, data: Dict[str, Any]) -> str:
        """Generate a Word document report."""
        from docx import Document
        from docx.shared import Inches, Pt, Cm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.enum.table import WD_TABLE_ALIGNMENT

        filename = f"wifi_report_{self._get_timestamp_str()}.docx"
        filepath = os.path.join(self.REPORTS_DIR, filename)

        doc = Document()

        # Style configuration
        style = doc.styles['Normal']
        font = style.font
        font.name = 'Calibri'
        font.size = Pt(11)

        # Title
        title = doc.add_heading('RF Space Observatory', level=0)
        title.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for run in title.runs:
            run.font.color.rgb = RGBColor(0x0A, 0x0E, 0x17)

        subtitle = doc.add_paragraph('WiFi Network Diagnostic Report')
        subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for run in subtitle.runs:
            run.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)
            run.font.size = Pt(14)

        doc.add_paragraph()  # Spacer

        # Metadata
        doc.add_heading('System Information', level=2)
        meta = data.get("network_config", {})
        p = doc.add_paragraph()
        p.add_run(f"Hostname: ").bold = True
        p.add_run(f"{meta.get('hostname', 'N/A')}\n")
        p.add_run(f"Local IP: ").bold = True
        p.add_run(f"{meta.get('local_ip', 'N/A')}\n")
        p.add_run(f"Gateway: ").bold = True
        p.add_run(f"{meta.get('gateway', 'N/A')}\n")
        p.add_run(f"OS: ").bold = True
        p.add_run(f"{meta.get('os', 'N/A')}\n")
        p.add_run(f"Generated: ").bold = True
        p.add_run(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        # Access Points Table
        doc.add_heading('Access Points Overview', level=2)

        aps = data.get("access_points", [])
        if aps:
            table = doc.add_table(rows=1, cols=7)
            table.style = 'Medium Shading 1 Accent 1'
            table.alignment = WD_TABLE_ALIGNMENT.CENTER

            # Header
            headers = ["Label", "Band", "Channel", "RSSI (dBm)", "Distance (m)", "Quality (%)", "Security"]
            for i, header in enumerate(headers):
                cell = table.rows[0].cells[i]
                cell.text = header

            # Data rows
            for ap in sorted(aps, key=lambda x: x.get('rssi_mean', -100), reverse=True):
                row = table.add_row()
                row.cells[0].text = ap.get("ssid_label", "N/A")
                row.cells[1].text = ap.get("band", "N/A")
                row.cells[2].text = str(ap.get("channel", "N/A"))
                row.cells[3].text = f"{ap.get('rssi_mean', 0):.1f}"
                row.cells[4].text = f"{ap.get('distance_estimate', 0):.1f}"
                row.cells[5].text = f"{ap.get('signal_quality', 0):.0f}"
                row.cells[6].text = ap.get("security", "N/A")

        # Scan Statistics
        scan_stats = data.get("scan_stats", {})
        if scan_stats:
            doc.add_heading('Scan Statistics', level=2)
            p = doc.add_paragraph()
            p.add_run(f"Total APs: ").bold = True
            p.add_run(f"{scan_stats.get('total_aps', 0)}\n")
            p.add_run(f"2.4 GHz: ").bold = True
            p.add_run(f"{scan_stats.get('band_24ghz', 0)}\n")
            p.add_run(f"5 GHz: ").bold = True
            p.add_run(f"{scan_stats.get('band_5ghz', 0)}\n")
            p.add_run(f"Average RSSI: ").bold = True
            p.add_run(f"{scan_stats.get('avg_rssi', 0)} dBm\n")
            p.add_run(f"Total Scans: ").bold = True
            p.add_run(f"{scan_stats.get('total_scans', 0)}")

        # Log Statistics
        log_stats = data.get("log_stats", {})
        if log_stats:
            doc.add_heading('Log Statistics', level=2)
            p = doc.add_paragraph()
            p.add_run(f"Total Logs: ").bold = True
            p.add_run(f"{log_stats.get('total_logs', 0)}\n")
            p.add_run(f"Errors: ").bold = True
            p.add_run(f"{log_stats.get('errors', 0)}\n")
            p.add_run(f"Total Outages: ").bold = True
            p.add_run(f"{log_stats.get('total_outages', 0)}\n")
            p.add_run(f"Total Downtime: ").bold = True
            p.add_run(f"{log_stats.get('total_downtime_seconds', 0):.0f}s\n")

            status = "🔴 DOWN" if log_stats.get("currently_down") else "🟢 UP"
            p.add_run(f"Current Status: ").bold = True
            p.add_run(status)

        # Outages
        outages = data.get("outages", [])
        if outages:
            doc.add_heading('Outage History', level=2)
            table = doc.add_table(rows=1, cols=4)
            table.style = 'Medium Shading 1 Accent 1'

            headers = ["Start", "End", "Duration (s)", "Message"]
            for i, h in enumerate(headers):
                table.rows[0].cells[i].text = h

            for outage in outages:
                row = table.add_row()
                row.cells[0].text = outage.get("inicio", "N/A")
                row.cells[1].text = outage.get("fim", "N/A")
                row.cells[2].text = f"{outage.get('duracao_segundos', 0):.0f}"
                row.cells[3].text = outage.get("message", "")

        doc.save(filepath)
        print(f"[report_generator] 📝 Word saved: {filepath}")
        return filepath

    def generate_excel(self, data: Dict[str, Any]) -> str:
        """Generate an Excel workbook with multiple sheets."""
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.chart import BarChart, PieChart, Reference
        from openpyxl.utils import get_column_letter

        filename = f"wifi_report_{self._get_timestamp_str()}.xlsx"
        filepath = os.path.join(self.REPORTS_DIR, filename)

        wb = Workbook()

        # Color definitions
        header_fill = PatternFill(start_color="0A0E17", end_color="0A0E17", fill_type="solid")
        header_font = Font(color="FFFFFF", bold=True, size=11)
        band_24_fill = PatternFill(start_color="E6FFF5", end_color="E6FFF5", fill_type="solid")
        band_5_fill = PatternFill(start_color="FFE6F5", end_color="FFE6F5", fill_type="solid")
        thin_border = Border(
            left=Side(style='thin', color='E5E7EB'),
            right=Side(style='thin', color='E5E7EB'),
            top=Side(style='thin', color='E5E7EB'),
            bottom=Side(style='thin', color='E5E7EB'),
        )

        # Sheet 1: Access Points
        ws_aps = wb.active
        ws_aps.title = "Access Points"

        ap_headers = ["Label", "BSSID", "Band", "Channel", "RSSI Mean (dBm)",
                       "RSSI Std", "Signal Quality (%)", "Distance (m)",
                       "Samples", "Security", "First Seen", "Last Seen"]

        for col, header in enumerate(ap_headers, 1):
            cell = ws_aps.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal='center')
            cell.border = thin_border

        aps = data.get("access_points", [])
        for row_idx, ap in enumerate(sorted(aps, key=lambda x: x.get('rssi_mean', -100), reverse=True), 2):
            values = [
                ap.get("ssid_label", ""),
                ap.get("bssid", ""),
                ap.get("band", ""),
                ap.get("channel", 0),
                round(ap.get("rssi_mean", 0), 1),
                round(ap.get("rssi_std", 0), 1),
                round(ap.get("signal_quality", 0), 1),
                round(ap.get("distance_estimate", 0), 1),
                ap.get("sample_count", 0),
                ap.get("security", ""),
                ap.get("first_seen", ""),
                ap.get("last_seen", ""),
            ]

            for col, value in enumerate(values, 1):
                cell = ws_aps.cell(row=row_idx, column=col, value=value)
                cell.border = thin_border
                cell.alignment = Alignment(horizontal='center')

                # Color by band
                if ap.get("band") == "2.4GHz":
                    if col == 3:
                        cell.fill = band_24_fill
                elif ap.get("band") == "5GHz":
                    if col == 3:
                        cell.fill = band_5_fill

        # Auto-adjust column widths
        for col in range(1, len(ap_headers) + 1):
            ws_aps.column_dimensions[get_column_letter(col)].width = 16

        # Add RSSI chart
        if aps:
            chart = BarChart()
            chart.title = "Signal Strength (RSSI) by Access Point"
            chart.y_axis.title = "RSSI (dBm)"
            chart.x_axis.title = "Access Point"
            chart.style = 10
            chart.width = 25
            chart.height = 15

            data_ref = Reference(ws_aps, min_col=5, min_row=1, max_row=len(aps) + 1)
            cats = Reference(ws_aps, min_col=1, min_row=2, max_row=len(aps) + 1)
            chart.add_data(data_ref, titles_from_data=True)
            chart.set_categories(cats)
            chart.shape = 4

            ws_aps.add_chart(chart, f"A{len(aps) + 4}")

        # Sheet 2: Scan Statistics
        ws_stats = wb.create_sheet("Statistics")

        scan_stats = data.get("scan_stats", {})
        log_stats = data.get("log_stats", {})

        stats_data = [
            ["Metric", "Value"],
            ["Total Access Points", scan_stats.get("total_aps", 0)],
            ["2.4 GHz APs", scan_stats.get("band_24ghz", 0)],
            ["5 GHz APs", scan_stats.get("band_5ghz", 0)],
            ["Average RSSI", f"{scan_stats.get('avg_rssi', 0)} dBm"],
            ["Strongest Signal", f"{scan_stats.get('strongest_signal', 0)} dBm"],
            ["Weakest Signal", f"{scan_stats.get('weakest_signal', 0)} dBm"],
            ["Total Scans", scan_stats.get("total_scans", 0)],
            ["", ""],
            ["Total Logs", log_stats.get("total_logs", 0)],
            ["Log Errors", log_stats.get("errors", 0)],
            ["Log Warnings", log_stats.get("warnings", 0)],
            ["Total Outages", log_stats.get("total_outages", 0)],
            ["Total Downtime", f"{log_stats.get('total_downtime_seconds', 0):.0f}s"],
        ]

        for row_idx, row_data in enumerate(stats_data, 1):
            for col, value in enumerate(row_data, 1):
                cell = ws_stats.cell(row=row_idx, column=col, value=value)
                if row_idx == 1:
                    cell.fill = header_fill
                    cell.font = header_font
                cell.border = thin_border

        ws_stats.column_dimensions['A'].width = 25
        ws_stats.column_dimensions['B'].width = 20

        # Band pie chart
        if scan_stats.get("total_aps", 0) > 0:
            ws_chart = wb.create_sheet("Charts")

            ws_chart.cell(row=1, column=1, value="Band")
            ws_chart.cell(row=1, column=2, value="Count")
            ws_chart.cell(row=2, column=1, value="2.4 GHz")
            ws_chart.cell(row=2, column=2, value=scan_stats.get("band_24ghz", 0))
            ws_chart.cell(row=3, column=1, value="5 GHz")
            ws_chart.cell(row=3, column=2, value=scan_stats.get("band_5ghz", 0))

            pie = PieChart()
            pie.title = "WiFi Band Distribution"
            pie.style = 10
            pie_data = Reference(ws_chart, min_col=2, min_row=1, max_row=3)
            pie_cats = Reference(ws_chart, min_col=1, min_row=2, max_row=3)
            pie.add_data(pie_data, titles_from_data=True)
            pie.set_categories(pie_cats)
            pie.width = 20
            pie.height = 15

            ws_chart.add_chart(pie, "A5")

        # Sheet 3: Outages
        outages = data.get("outages", [])
        if outages:
            ws_outages = wb.create_sheet("Outages")

            outage_headers = ["#", "Start", "End", "Duration (s)", "Message"]
            for col, header in enumerate(outage_headers, 1):
                cell = ws_outages.cell(row=1, column=col, value=header)
                cell.fill = PatternFill(start_color="DC2626", end_color="DC2626", fill_type="solid")
                cell.font = Font(color="FFFFFF", bold=True)
                cell.border = thin_border

            for row_idx, outage in enumerate(outages, 2):
                values = [
                    row_idx - 1,
                    outage.get("inicio", ""),
                    outage.get("fim", ""),
                    outage.get("duracao_segundos", 0),
                    outage.get("message", ""),
                ]
                for col, value in enumerate(values, 1):
                    cell = ws_outages.cell(row=row_idx, column=col, value=value)
                    cell.border = thin_border

        wb.save(filepath)
        print(f"[report_generator] 📊 Excel saved: {filepath}")
        return filepath