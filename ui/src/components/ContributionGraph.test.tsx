import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContributionGraph, contributionYears } from '../components/ContributionGraph';

describe('contributionYears', () => {
  it('returns newest year first and treats second-scale timestamps as seconds', () => {
    const years = contributionYears(1_700_000_000, new Date('2026-08-24T00:00:00Z'));
    expect(years[0]).toBe(2026);
    expect(years).toContain(2023);
    expect(years[years.length - 1]).toBe(2023);
  });
});

describe('ContributionGraph', () => {
  it('shows the total and lets the year change', () => {
    const onYearChange = vi.fn();
    render(
      <ContributionGraph
        data={{ year: 2026, total: 42, days: [{ date: '2026-01-02', count: 3 }] }}
        years={[2026, 2025]}
        onYearChange={onYearChange}
      />,
    );
    expect(screen.getByText('42 contributions in 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2025' }));
    expect(onYearChange).toHaveBeenCalledWith(2025);
  });
});
