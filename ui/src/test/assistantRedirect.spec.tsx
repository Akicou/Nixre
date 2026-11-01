import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AssistantRedirect } from '../App';

const Probe = () => {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
};

describe('old repo assistant links', () => {
  it('land in the agent workspace scoped to the same repo', () => {
    render(
      <MemoryRouter initialEntries={['/acme/api/assistant']}>
        <Routes>
          <Route path="/:space/:repo/assistant" element={<AssistantRedirect />} />
          <Route path="/agent" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where')).toHaveTextContent('/agent?repo=acme%2Fapi');
  });
});
