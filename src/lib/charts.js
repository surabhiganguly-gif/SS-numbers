import { formatCompactINR } from './format.js';

// Grouped bar chart: Income / Expense / Savings per month. Fixed categorical
// mapping (blue/red/green) — never reassigned per render, per the dataviz method.
export function trendChartHtml(months) {
  const W = 360;
  const H = 200;
  const PAD_TOP = 18;
  const PAD_BOTTOM = 26;
  const PAD_X = 6;

  const plotW = W - PAD_X * 2;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const groupW = plotW / Math.max(1, months.length);
  const groupPadding = 12;
  const barGap = 3;
  const barW = Math.max(4, (groupW - groupPadding - barGap * 2) / 3);

  const maxValue = Math.max(1, ...months.flatMap((m) => [m.income, m.expense, m.savings]));

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = PAD_TOP + plotH * (1 - f);
    return `<line x1="${PAD_X}" y1="${y}" x2="${W - PAD_X}" y2="${y}" stroke="var(--chart-grid)" stroke-width="1" />`;
  });

  const series = ['income', 'expense', 'savings'];
  const colorVar = { income: 'var(--chart-income)', expense: 'var(--chart-expense)', savings: 'var(--chart-savings)' };

  const bars = months
    .map((m, i) => {
      const groupX = PAD_X + i * groupW + groupPadding / 2;
      const barsHtml = series
        .map((s, j) => {
          const value = m[s] || 0;
          const barH = (value / maxValue) * plotH;
          const x = groupX + j * (barW + barGap);
          const y = PAD_TOP + (plotH - barH);
          const label = value > 0 ? formatCompactINR(value) : '';
          return `
            <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(0, barH)}" rx="2" fill="${colorVar[s]}">
              <title>${m.label} ${s}: ${formatCompactINR(value)}</title>
            </rect>
            ${label ? `<text x="${x + barW / 2}" y="${y - 3}" font-size="7" text-anchor="middle" fill="var(--chart-muted)">${label}</text>` : ''}
          `;
        })
        .join('');
      const labelX = groupX + (barW * 3 + barGap * 2) / 2;
      const badge = m.granularity === 'monthly-lump' ? ' *' : '';
      return `${barsHtml}<text x="${labelX}" y="${H - 6}" font-size="9" text-anchor="middle" fill="var(--chart-muted)">${m.label}${badge}</text>`;
    })
    .join('');

  const legend = `
    <div class="chart-legend">
      <span><span class="swatch" style="background:var(--chart-income)"></span>Income</span>
      <span><span class="swatch" style="background:var(--chart-expense)"></span>Expense</span>
      <span><span class="swatch" style="background:var(--chart-savings)"></span>Savings</span>
    </div>`;

  const hasLumpMonth = months.some((m) => m.granularity === 'monthly-lump');

  return `
    ${legend}
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly income, expense and savings">
      ${gridLines.join('')}
      <line x1="${PAD_X}" y1="${PAD_TOP + plotH}" x2="${W - PAD_X}" y2="${PAD_TOP + plotH}" stroke="var(--chart-axis)" stroke-width="1" />
      ${bars}
    </svg>
    ${hasLumpMonth ? '<div class="hint">* monthly total imported from historical records, not daily-tracked</div>' : ''}
  `;
}

// Horizontal bar chart ranking categories by spend — single hue (magnitude
// comparison, not multi-series identity), per the dataviz color-formula.
export function categoryBarChartHtml(items) {
  if (items.length === 0) return '<div class="empty-state">No spend recorded for this month.</div>';

  const ROW_H = 22;
  const GAP = 6;
  const LABEL_W = 108;
  const W = 360;
  const H = items.length * (ROW_H + GAP);
  const barAreaW = W - LABEL_W - 44;

  const maxValue = Math.max(1, ...items.map((it) => it.value));

  const rows = items
    .map((it, i) => {
      const y = i * (ROW_H + GAP);
      const barW = Math.max(2, (it.value / maxValue) * barAreaW);
      return `
        <text x="0" y="${y + ROW_H / 2 + 3}" font-size="9" fill="var(--text)">${it.label}</text>
        <rect x="${LABEL_W}" y="${y + 2}" width="${barW}" height="${ROW_H - 4}" rx="2" fill="var(--chart-category)">
          <title>${it.label}: ${formatCompactINR(it.value)}</title>
        </rect>
        <text x="${LABEL_W + barW + 6}" y="${y + ROW_H / 2 + 3}" font-size="8" fill="var(--chart-muted)">${formatCompactINR(it.value)}</text>
      `;
    })
    .join('');

  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spend by category">${rows}</svg>`;
}
