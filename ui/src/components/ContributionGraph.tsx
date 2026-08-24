import React, { useMemo } from 'react';
import { Contributions } from '../lib/api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LEVEL_CLASS = [
  'bg-surface-subtle',
  'bg-txt-open/30',
  'bg-txt-open/55',
  'bg-txt-open/80',
  'bg-txt-open',
];

function levelFor(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(date: string, count: number): string {
  const pretty = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const noun = count === 1 ? 'contribution' : 'contributions';
  return `${count} ${noun} on ${pretty}`;
}

export function contributionYears(createdMs: number, now = new Date()): number[] {
  const current = now.getUTCFullYear();
  const ms = createdMs > 0 && createdMs < 1e12 ? createdMs * 1000 : createdMs;
  const start = ms > 0 ? new Date(ms).getUTCFullYear() : current;
  const from = Number.isFinite(start) ? Math.min(Math.max(start, current - 15), current) : current;
  const years: number[] = [];
  for (let y = current; y >= from; y--) years.push(y);
  return years.length ? years : [current];
}

interface Cell {
  date: string | null;
  count: number;
}

function buildCells(year: number, days: { date: string; count: number }[]): Cell[] {
  const counts = new Map(days.map(d => [d.date, d.count]));
  const jan1 = utcDate(year, 0, 1);
  const dec31 = utcDate(year, 11, 31);
  const cells: Cell[] = [];
  for (let i = 0; i < jan1.getUTCDay(); i++) cells.push({ date: null, count: 0 });
  for (let d = new Date(jan1); d.getTime() <= dec31.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = isoDay(d);
    cells.push({ date, count: counts.get(date) || 0 });
  }
  return cells;
}

function monthLabels(cells: Cell[]): { week: number; label: string }[] {
  const labels: { week: number; label: string }[] = [];
  let last = -1;
  const weekCount = Math.ceil(cells.length / 7);
  for (let w = 0; w < weekCount; w++) {
    const slice = cells.slice(w * 7, w * 7 + 7);
    const first = slice.find(c => c.date);
    if (!first?.date) continue;
    const month = Number(first.date.slice(5, 7)) - 1;
    if (month !== last) {
      labels.push({ week: w, label: MONTHS[month] });
      last = month;
    }
  }
  return labels;
}

interface ContributionGraphProps {
  data: Contributions | null;
  years: number[];
  onYearChange: (year: number) => void;
  loading?: boolean;
}

export const ContributionGraph: React.FC<ContributionGraphProps> = ({
  data,
  years,
  onYearChange,
  loading = false,
}) => {
  const year = data?.year ?? years[0] ?? new Date().getUTCFullYear();
  const days = data?.days ?? [];
  const total = data?.total ?? 0;

  const cells = useMemo(() => buildCells(year, days), [year, days]);
  const months = useMemo(() => monthLabels(cells), [cells]);
  const weekCount = Math.ceil(cells.length / 7);

  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <h2 className="text-sm font-semibold text-txt-primary">
          {loading ? 'Loading contributions…' : `${total.toLocaleString()} contributions in ${year}`}
        </h2>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 min-w-0">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="inline-block min-w-full">
            <div
              className="grid gap-[3px] mb-1 text-[10px] text-txt-tertiary"
              style={{ gridTemplateColumns: `28px repeat(${weekCount}, 11px)` }}
            >
              <span />
              {Array.from({ length: weekCount }, (_, w) => {
                const m = months.find(x => x.week === w);
                return (
                  <span key={w} className="leading-none whitespace-nowrap">
                    {m?.label || ''}
                  </span>
                );
              })}
            </div>
            <div className="flex gap-[3px]">
              <div className="grid grid-rows-7 gap-[3px] text-[9px] text-txt-tertiary leading-[11px] w-7 shrink-0 pr-1">
                <span />
                <span>Mon</span>
                <span />
                <span>Wed</span>
                <span />
                <span>Fri</span>
                <span />
              </div>
              <div
                className="grid grid-rows-7 grid-flow-col gap-[3px]"
                style={{ gridTemplateColumns: `repeat(${weekCount}, 11px)` }}
              >
                {cells.map((cell, i) => (
                  <span
                    key={cell.date || `pad-${i}`}
                    title={cell.date ? formatDayLabel(cell.date, cell.count) : undefined}
                    className={`w-[11px] h-[11px] rounded-[2px] ${cell.date ? LEVEL_CLASS[levelFor(cell.count)] : 'bg-transparent'}`}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-1 mt-2 text-[10px] text-txt-tertiary">
              <span>Less</span>
              {LEVEL_CLASS.map((cls, i) => (
                <span key={i} className={`w-[11px] h-[11px] rounded-[2px] ${cls}`} />
              ))}
              <span>More</span>
            </div>
          </div>
        </div>

        {years.length > 1 && (
          <div className="flex flex-row sm:flex-col gap-1 shrink-0 overflow-x-auto">
            {years.map(y => (
              <button
                key={y}
                type="button"
                onClick={() => onYearChange(y)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium text-left transition shrink-0 ${
                  y === year
                    ? 'bg-brand text-white'
                    : 'text-txt-secondary hover:bg-surface-subtle'
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
