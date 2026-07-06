import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { getCurrentUser } from './auth/session.js';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface SummaryData {
  totalUsers: number;
  activeToday: number;
  active7d: number;
  eventsToday: number;
}

interface DailyRow {
  date: string;
  activeUsers: number;
  events: number;
}

interface FeatureRow {
  feature: string;
  count: number;
  users: number;
}

interface ReportMonth {
  month: string;
  label: string;
  events: number;
  activeUsers: number;
}

interface WeeklyRow {
  weekStart: string;
  weekEnd: string;
  activeUsers: number;
  events: number;
}

interface MonthlyReport {
  month: string;
  label: string;
  generatedAt: string;
  timeZone: string;
  summary: {
    totalUsers: number;
    monthlyActiveUsers: number;
    totalActivities: number;
    daysWithActivity: number;
    avgDailyActiveUsers: number;
    avgWeeklyActiveUsers: number;
    avgDailyActivities: number;
  };
  daily: DailyRow[];
  weekly: WeeklyRow[];
  features: FeatureRow[];
}

type DocWithAutoTable = jsPDF & {
  lastAutoTable?: {
    finalY: number;
  };
};

const numberFormatter = new Intl.NumberFormat('id-ID');
const decimalFormatter = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

const chartColors = [
  '#1F5630',
  '#E67E22',
  '#22C55E',
  '#0F766E',
  '#F59E0B',
  '#2563EB',
  '#7C3AED',
  '#DC2626',
];

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el as T;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  const body = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !body.success) {
    throw new Error(body.error || 'Request failed');
  }
  return body.data;
}

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatDecimal(value: number): string {
  return decimalFormatter.format(value);
}

function formatShortDate(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function formatLongDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function setText(id: string, value: string): void {
  byId(id).textContent = value;
}

function setStatus(message: string): void {
  byId('monthly-report-status').textContent = message;
}

function setDownloadButtonLabel(label: string): void {
  const labelEl = byId<HTMLButtonElement>('download-monthly-report').querySelector('span');
  if (labelEl) labelEl.textContent = label;
}

function renderDailyChart(days: DailyRow[]): void {
  const chart = byId<HTMLDivElement>('daily-chart');
  chart.textContent = '';

  if (!days.some((day) => day.events > 0)) {
    const empty = createElement('p', 'text-sm text-on-surface-variant');
    empty.textContent = 'Belum ada data penggunaan.';
    chart.appendChild(empty);
    return;
  }

  const max = Math.max(1, ...days.map((day) => Math.max(day.events, day.activeUsers)));
  for (const day of days) {
    const col = createElement(
      'div',
      'flex h-full flex-1 flex-col items-center justify-end gap-1'
    );
    const bars = createElement(
      'div',
      'flex w-full flex-1 items-end justify-center gap-0.5'
    );
    bars.title = `${day.date} - ${day.events} aktivitas, ${day.activeUsers} pengguna`;

    const eventBar = createElement('div', 'w-2/5 rounded-t bg-vibrant-palm');
    eventBar.style.height = `${Math.max(day.events ? 4 : 1, Math.round((day.events / max) * 88))}%`;

    const userBar = createElement('div', 'w-2/5 rounded-t bg-accent-green');
    userBar.style.height = `${Math.max(day.activeUsers ? 4 : 1, Math.round((day.activeUsers / max) * 88))}%`;

    const label = createElement('span', 'text-[10px] text-on-surface-variant');
    label.textContent = formatShortDate(day.date);

    bars.append(eventBar, userBar);
    col.append(bars, label);
    chart.appendChild(col);
  }
}

function renderFeatures(features: FeatureRow[]): void {
  const list = byId<HTMLDivElement>('feature-list');
  list.textContent = '';

  if (features.length === 0) {
    const empty = createElement('p', 'text-sm text-on-surface-variant');
    empty.textContent = 'Belum ada fitur yang diakses.';
    list.appendChild(empty);
    return;
  }

  const max = Math.max(1, ...features.map((feature) => feature.count));
  for (const feature of features) {
    const row = createElement('div');
    const header = createElement('div', 'mb-1 flex items-center justify-between gap-3 text-sm');
    const name = createElement('span', 'font-medium text-content');
    name.textContent = feature.feature;
    const value = createElement('span', 'shrink-0 text-on-surface-variant');
    value.textContent = `${formatNumber(feature.count)}x - ${formatNumber(feature.users)} pengguna`;
    const track = createElement('div', 'h-2 w-full rounded bg-surface-muted');
    const bar = createElement('div', 'h-2 rounded bg-accent-green');
    bar.style.width = `${Math.max(2, Math.round((feature.count / max) * 100))}%`;

    header.append(name, value);
    track.appendChild(bar);
    row.append(header, track);
    list.appendChild(row);
  }
}

async function loadDashboard(): Promise<void> {
  const [summary, days, features] = await Promise.all([
    apiGet<SummaryData>('/api/admin/reports/summary'),
    apiGet<DailyRow[]>('/api/admin/reports/daily?days=14'),
    apiGet<FeatureRow[]>('/api/admin/reports/features?days=30'),
  ]);

  setText('stat-users', formatNumber(summary.totalUsers));
  setText('stat-today', formatNumber(summary.activeToday));
  setText('stat-week', formatNumber(summary.active7d));
  setText('stat-events', formatNumber(summary.eventsToday));
  renderDailyChart(days);
  renderFeatures(features);
}

async function loadReportMonths(): Promise<void> {
  const select = byId<HTMLSelectElement>('report-month-select');
  const button = byId<HTMLButtonElement>('download-monthly-report');
  const months = await apiGet<ReportMonth[]>('/api/admin/reports/months');

  select.textContent = '';
  if (months.length === 0) {
    const option = createElement('option');
    option.textContent = 'Belum ada report';
    select.appendChild(option);
    select.disabled = true;
    button.disabled = true;
    setStatus('Belum ada aktivitas yang bisa dijadikan report bulanan.');
    return;
  }

  for (const month of months) {
    const option = createElement('option');
    option.value = month.month;
    option.textContent = `${month.label} - ${formatNumber(month.events)} aktivitas`;
    select.appendChild(option);
  }

  select.disabled = false;
  button.disabled = false;
  setStatus(`${months.length} bulan report tersedia.`);
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.scale(ratio, ratio);
  return [canvas, ctx];
}

function drawNoData(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#6B7280';
  ctx.font = '18px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Belum ada data', width / 2, height / 2);
}

function createPieChart(features: FeatureRow[]): string {
  const width = 760;
  const height = 360;
  const [canvas, ctx] = makeCanvas(width, height);
  const total = features.reduce((sum, feature) => sum + feature.count, 0);

  if (total === 0) {
    drawNoData(ctx, width, height);
    return canvas.toDataURL('image/png');
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  const slices = features.slice(0, 6);
  const otherCount = features.slice(6).reduce((sum, feature) => sum + feature.count, 0);
  const chartData =
    otherCount > 0
      ? [...slices, { feature: 'lainnya', count: otherCount, users: 0 }]
      : slices;

  const centerX = 185;
  const centerY = 180;
  const radius = 118;
  let start = -Math.PI / 2;

  chartData.forEach((item, index) => {
    const angle = (item.count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = chartColors[index % chartColors.length];
    ctx.fill();
    start += angle;
  });

  ctx.fillStyle = '#0B1F17';
  ctx.font = 'bold 20px Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Distribusi fitur', 360, 52);
  ctx.font = '13px Arial, sans-serif';

  chartData.forEach((item, index) => {
    const y = 88 + index * 34;
    const pct = Math.round((item.count / total) * 100);
    ctx.fillStyle = chartColors[index % chartColors.length];
    ctx.fillRect(360, y - 11, 16, 16);
    ctx.fillStyle = '#123528';
    ctx.fillText(`${item.feature}`, 386, y);
    ctx.fillStyle = '#6B7280';
    ctx.fillText(`${formatNumber(item.count)} aktivitas (${pct}%)`, 386, y + 17);
  });

  return canvas.toDataURL('image/png');
}

function createTimeSeriesChart(days: DailyRow[]): string {
  const width = 1040;
  const height = 360;
  const [canvas, ctx] = makeCanvas(width, height);
  const max = Math.max(1, ...days.map((day) => Math.max(day.events, day.activeUsers)));
  const left = 58;
  const right = 24;
  const top = 30;
  const bottom = 52;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#D1D5DB';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, top + chartHeight);
  ctx.lineTo(left + chartWidth, top + chartHeight);
  ctx.stroke();

  ctx.fillStyle = '#6B7280';
  ctx.font = '12px Arial, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const value = Math.round((max / 4) * i);
    const y = top + chartHeight - (chartHeight / 4) * i;
    ctx.fillText(String(value), left - 8, y + 4);
    ctx.strokeStyle = '#EEF2F7';
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + chartWidth, y);
    ctx.stroke();
  }

  const step = days.length > 1 ? chartWidth / (days.length - 1) : chartWidth;
  const xFor = (index: number) => left + step * index;
  const yFor = (value: number) => top + chartHeight - (value / max) * chartHeight;

  days.forEach((day, index) => {
    const x = xFor(index);
    const barWidth = Math.max(5, Math.min(18, step * 0.42));
    ctx.fillStyle = '#E67E22';
    ctx.fillRect(x - barWidth / 2, yFor(day.events), barWidth, top + chartHeight - yFor(day.events));
  });

  ctx.strokeStyle = '#22C55E';
  ctx.lineWidth = 3;
  ctx.beginPath();
  days.forEach((day, index) => {
    const x = xFor(index);
    const y = yFor(day.activeUsers);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  days.forEach((day, index) => {
    const x = xFor(index);
    const y = yFor(day.activeUsers);
    ctx.fillStyle = '#22C55E';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = '#123528';
  ctx.font = '12px Arial, sans-serif';
  ctx.textAlign = 'center';
  const labelEvery = days.length > 20 ? 3 : 2;
  days.forEach((day, index) => {
    if (index % labelEvery !== 0 && index !== days.length - 1) return;
    ctx.fillText(formatShortDate(day.date), xFor(index), height - 24);
  });

  ctx.textAlign = 'left';
  ctx.fillStyle = '#E67E22';
  ctx.fillRect(width - 205, 28, 14, 14);
  ctx.fillStyle = '#123528';
  ctx.fillText('Aktivitas', width - 184, 40);
  ctx.fillStyle = '#22C55E';
  ctx.fillRect(width - 115, 28, 14, 14);
  ctx.fillStyle = '#123528';
  ctx.fillText('Pengguna', width - 94, 40);

  return canvas.toDataURL('image/png');
}

function setPdfColor(doc: jsPDF, hex: string, target: 'fill' | 'text' | 'draw'): void {
  const [r, g, b] = hexToRgb(hex);
  if (target === 'fill') doc.setFillColor(r, g, b);
  if (target === 'text') doc.setTextColor(r, g, b);
  if (target === 'draw') doc.setDrawColor(r, g, b);
}

function addPageHeader(doc: jsPDF, title: string): void {
  const pageWidth = doc.internal.pageSize.getWidth();
  setPdfColor(doc, '#1F5630', 'fill');
  doc.rect(0, 0, pageWidth, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(title, 14, 14);
}

function drawMetric(
  doc: jsPDF,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string
): void {
  setPdfColor(doc, '#E8F4ED', 'fill');
  setPdfColor(doc, '#B7D7C4', 'draw');
  doc.roundedRect(x, y, width, 18, 2, 2, 'FD');
  setPdfColor(doc, '#466356', 'text');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(label, x + 4, y + 6);
  setPdfColor(doc, '#1F5630', 'text');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(value, x + 4, y + 14);
}

function addPdfFooter(doc: jsPDF): void {
  const total = doc.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  for (let page = 1; page <= total; page++) {
    doc.setPage(page);
    setPdfColor(doc, '#6B7280', 'text');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(`Halaman ${page}/${total}`, pageWidth - 14, pageHeight - 8, {
      align: 'right',
    });
    doc.text('Internal Government Operation - BPDP', 14, pageHeight - 8);
  }
}

function generateMonthlyPdf(report: MonthlyReport): void {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  addPageHeader(doc, `Laporan Bulanan IGO - ${report.label}`);

  setPdfColor(doc, '#123528', 'text');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const generated = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(report.generatedAt));
  doc.text(`Periode: ${report.label}`, 14, 31);
  doc.text(`Dibuat: ${generated} (${report.timeZone})`, pageWidth - 14, 31, {
    align: 'right',
  });

  const metricWidth = 42;
  const metricGap = 4;
  const metrics = [
    ['Total user aktif', formatNumber(report.summary.totalUsers)],
    ['User aktif bulan', formatNumber(report.summary.monthlyActiveUsers)],
    ['Total aktivitas', formatNumber(report.summary.totalActivities)],
    ['Hari aktif', formatNumber(report.summary.daysWithActivity)],
    ['Rata-rata user/hari', formatDecimal(report.summary.avgDailyActiveUsers)],
    ['Rata-rata aktivitas/hari', formatDecimal(report.summary.avgDailyActivities)],
  ];
  metrics.forEach(([label, value], index) => {
    drawMetric(doc, 14 + index * (metricWidth + metricGap), 40, metricWidth, label, value);
  });

  doc.addImage(createPieChart(report.features), 'PNG', 14, 68, 118, 56);
  doc.addImage(createTimeSeriesChart(report.daily), 'PNG', 141, 68, 142, 56);

  setPdfColor(doc, '#123528', 'text');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Ringkasan', 14, 137);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `Pengguna per minggu rata-rata ${formatDecimal(report.summary.avgWeeklyActiveUsers)}. ` +
      `Fitur paling sering dipakai: ${report.features[0]?.feature || '-'}.`,
    14,
    145
  );

  doc.addPage();
  addPageHeader(doc, `Detail Laporan - ${report.label}`);

  autoTable(doc, {
    head: [['Fitur populer', 'Aktivitas', 'Pengguna unik']],
    body: report.features.map((feature) => [
      feature.feature,
      formatNumber(feature.count),
      formatNumber(feature.users),
    ]),
    startY: 31,
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [31, 86, 48], textColor: 255 },
    alternateRowStyles: { fillColor: [240, 248, 244] },
  });

  let nextY = ((doc as DocWithAutoTable).lastAutoTable?.finalY || 31) + 8;
  if (nextY > 150) {
    doc.addPage();
    addPageHeader(doc, `Detail Laporan - ${report.label}`);
    nextY = 31;
  }

  autoTable(doc, {
    head: [['Minggu', 'Pengguna aktif', 'Aktivitas']],
    body: report.weekly.map((week, index) => [
      `Minggu ${index + 1} (${formatShortDate(week.weekStart)} - ${formatShortDate(week.weekEnd)})`,
      formatNumber(week.activeUsers),
      formatNumber(week.events),
    ]),
    startY: nextY,
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [230, 126, 34], textColor: 255 },
    alternateRowStyles: { fillColor: [255, 247, 237] },
  });

  nextY = ((doc as DocWithAutoTable).lastAutoTable?.finalY || nextY) + 8;
  if (nextY > 150) {
    doc.addPage();
    addPageHeader(doc, `Aktivitas Harian - ${report.label}`);
    nextY = 31;
  }

  autoTable(doc, {
    head: [['Tanggal', 'Pengguna aktif', 'Aktivitas']],
    body: report.daily.map((day) => [
      formatLongDate(day.date),
      formatNumber(day.activeUsers),
      formatNumber(day.events),
    ]),
    startY: nextY,
    margin: { left: 14, right: 14 },
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [31, 86, 48], textColor: 255 },
    alternateRowStyles: { fillColor: [240, 248, 244] },
  });

  addPdfFooter(doc);
  doc.save(`igo-report-bulanan-${report.month}.pdf`);
}

async function downloadSelectedMonthlyReport(): Promise<void> {
  const select = byId<HTMLSelectElement>('report-month-select');
  const button = byId<HTMLButtonElement>('download-monthly-report');
  if (!select.value) return;

  button.disabled = true;
  setDownloadButtonLabel('Menyiapkan report...');
  setStatus('Report bulanan sedang dibuat.');

  try {
    const report = await apiGet<MonthlyReport>(
      `/api/admin/reports/monthly?month=${encodeURIComponent(select.value)}`
    );
    generateMonthlyPdf(report);
    setStatus(`Report ${report.label} berhasil dibuat.`);
  } catch (err) {
    console.error('monthly report failed', err);
    setStatus('Report bulanan gagal dibuat.');
  } finally {
    button.disabled = false;
    setDownloadButtonLabel('Download report bulanan');
  }
}

async function initReportPage(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = '/login.html';
    return;
  }
  if (user.role !== 'admin') {
    window.location.href = '/index.html';
    return;
  }

  byId<HTMLButtonElement>('download-monthly-report').addEventListener('click', () => {
    void downloadSelectedMonthlyReport();
  });

  try {
    await Promise.all([loadDashboard(), loadReportMonths()]);
  } catch (err) {
    console.error('report page failed', err);
    setStatus('Data laporan gagal dimuat.');
  }
}

void initReportPage();
