import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActionsPanel, splitLog } from '../components/ActionsPanel';
import { ActionsSettings } from '../components/ActionsSettings';
import { FileFinder, fuzzyScore } from '../components/FileFinder';
import { PullRequestDetail } from '../components/PullRequestDetail';
import { RepositoryHeader } from '../components/RepositoryHeader';
import { Dashboard } from '../pages/Dashboard';
import { repo, pullRequest } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: {
    listWorkflows: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    getJobLog: vi.fn(),
    cancelRun: vi.fn(),
    rerunRun: vi.fn(),
    dispatchWorkflow: vi.fn(),
    listRepoSecrets: vi.fn(),
    setRepoSecret: vi.fn(),
    deleteRepoSecret: vi.fn(),
    updateRepo: vi.fn(),
    listFiles: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    getPullRequestChecks: vi.fn(),
    mergePullRequest: vi.fn(),
    starRepo: vi.fn(),
    downloadArchive: vi.fn(),
    listSpaces: vi.fn(),
    listRepos: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/actionEvents', () => ({ subscribeRunEvents: () => () => {} }));
vi.mock('../components/DeploymentsOverview', () => ({ DeploymentsOverview: () => null }));

const SHA = 'c0ffee0000000000000000000000000000000000';
const run = {
  id: 1,
  number: 7,
  workflow_path: '.nixre/workflows/ci.yml',
  workflow_name: 'CI',
  event: 'push' as const,
  ref: 'refs/heads/main',
  branch: 'main',
  tag: null,
  sha: SHA,
  pr_number: null,
  actor: 'jane',
  inputs: {},
  status: 'completed' as const,
  conclusion: 'failure' as const,
  error: null,
  created: Date.now() - 60_000,
  started: Date.now() - 60_000,
  finished: Date.now() - 30_000,
};
const job = {
  id: 11,
  key: 'test',
  name: 'test (22)',
  matrix: { node: 22 },
  needs: [],
  image: 'node:22',
  status: 'completed' as const,
  conclusion: 'failure' as const,
  steps: [
    { name: 'npm ci', status: 'completed' as const, conclusion: 'success' as const },
    { name: 'npm test', status: 'completed' as const, conclusion: 'failure' as const },
  ],
  started: Date.now() - 50_000,
  finished: Date.now() - 30_000,
};
const workflow = {
  path: '.nixre/workflows/ci.yml',
  name: 'CI',
  error: null,
  events: ['push', 'workflow_dispatch'],
  schedule: ['0 3 * * *'],
  inputs: { level: { description: 'Level', required: true, default: 'low', type: 'choice' as const, options: ['low', 'high'] } },
  jobs: [{ id: 'test', name: 'test' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listWorkflows.mockResolvedValue({ ref: 'main', workflows: [workflow] });
  api.listRuns.mockResolvedValue({ runs: [run] });
  api.getRun.mockResolvedValue({ run, jobs: [job], can_write: true });
  api.getJobLog.mockResolvedValue('##[step:-1]\nPulling node:22\n##[step:0]\nadded 12 packages\n##[step:1]\n\u001b[31mFAIL\u001b[0m src/app.test.js\nProcess exited with code 1\n');
  api.listRepoSecrets.mockResolvedValue([{ key: 'NPM_TOKEN', updated: Date.now() }]);
});

function panel(props: Partial<React.ComponentProps<typeof ActionsPanel>> = {}) {
  const onSelectRun = vi.fn();
  render(
    <ActionsPanel repoPath="acme/website" defaultBranch="main" canWrite signedIn selectedRun={null} onSelectRun={onSelectRun} {...props} />,
  );
  return { onSelectRun };
}

describe('Actions tab', () => {
  it('lists runs with their trigger and opens one', async () => {
    const { onSelectRun } = panel();
    const row = await screen.findByRole('button', { name: /CI #7/ });
    expect(row).toHaveTextContent('push to main');
    expect(row).toHaveTextContent('c0ffee0');
    expect(within(row).getByLabelText('Failed')).toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelectRun).toHaveBeenCalledWith(7);
  });

  it('shows an explanation and a sample workflow when there are no runs', async () => {
    api.listRuns.mockResolvedValue({ runs: [] });
    panel();
    expect(await screen.findByText('No workflow runs yet')).toBeInTheDocument();
    expect(screen.getByText(/runs-on: ubuntu-latest/)).toBeInTheDocument();
  });

  it('filters by workflow, shows its schedule and badge, and dispatches with inputs', async () => {
    api.dispatchWorkflow.mockResolvedValue({ ...run, number: 8 });
    const { onSelectRun } = panel();
    fireEvent.click(await screen.findByRole('button', { name: 'CI' }));
    await waitFor(() => expect(api.listRuns).toHaveBeenLastCalledWith('acme/website', { workflow: '.nixre/workflows/ci.yml' }));
    expect(screen.getByText('0 3 * * *')).toBeInTheDocument();
    expect(screen.getByAltText('CI status badge')).toHaveAttribute('src', expect.stringContaining('/actions/badge.svg?workflow=ci.yml'));
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/ }));
    fireEvent.change(screen.getByLabelText('level'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(api.dispatchWorkflow).toHaveBeenCalledWith('acme/website', '.nixre/workflows/ci.yml', 'main', { level: 'high' }));
    expect(onSelectRun).toHaveBeenCalledWith(8);
  });

  it('hides Run workflow from people without write access', async () => {
    panel({ canWrite: false });
    fireEvent.click(await screen.findByRole('button', { name: 'CI' }));
    expect(screen.queryByRole('button', { name: /Run workflow/ })).toBeNull();
  });

  it('shows a run with its jobs, opens the failed step, and strips ANSI colours', async () => {
    panel({ selectedRun: 7 });
    expect(await screen.findByText('test (22)', { selector: 'h4' })).toBeInTheDocument();
    const failed = await screen.findByRole('button', { name: /npm test/ });
    expect(failed).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('FAIL src/app.test.js')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /npm ci/ })).toHaveAttribute('aria-expanded', 'false');
    api.rerunRun.mockResolvedValue({ ...run, number: 8 });
    fireEvent.click(screen.getByRole('button', { name: /Re-run/ }));
    await waitFor(() => expect(api.rerunRun).toHaveBeenCalledWith('acme/website', 7));
  });

  it('offers Cancel on an active run', async () => {
    api.getRun.mockResolvedValue({ run: { ...run, status: 'running', conclusion: null }, jobs: [{ ...job, status: 'running', conclusion: null }], can_write: true });
    api.cancelRun.mockResolvedValue({ ok: true });
    panel({ selectedRun: 7 });
    fireEvent.click(await screen.findByRole('button', { name: /Cancel run/ }));
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith('acme/website', 7));
  });

  it('splits stored logs into step sections', () => {
    const sections = splitLog('##[step:-1]\nsetup\n##[step:0]\na\nb\n##[step:2]\nc\n');
    expect(sections.get(-1)).toEqual(['setup']);
    expect(sections.get(0)).toEqual(['a', 'b']);
    expect(sections.get(2)).toEqual(['c']);
  });
});

describe('Actions settings', () => {
  it('toggles required checks and adds a secret without ever showing values', async () => {
    api.updateRepo.mockResolvedValue({ ...repo, require_checks: true });
    api.setRepoSecret.mockResolvedValue({ key: 'DEPLOY_KEY' });
    const onUpdated = vi.fn();
    render(<ActionsSettings repo={{ ...repo, can_write: true }} repoPath="acme/website" onUpdated={onUpdated} />);
    expect(await screen.findByText('NPM_TOKEN')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Require passing checks before merging'));
    await waitFor(() => expect(api.updateRepo).toHaveBeenCalledWith('acme/website', { require_checks: true }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ require_checks: true, can_write: true }));
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'deploy_key' } });
    fireEvent.change(screen.getByLabelText('Secret value'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add or update' }));
    await waitFor(() => expect(api.setRepoSecret).toHaveBeenCalledWith('acme/website', 'DEPLOY_KEY', 'hunter2'));
  });
});

describe('PR checks', () => {
  beforeEach(() => {
    api.getPullRequest.mockResolvedValue(pullRequest);
    api.getPullRequestDiff.mockResolvedValue([]);
  });

  it('lists checks and blocks merging while required checks fail', async () => {
    api.getPullRequestChecks.mockResolvedValue({
      sha: SHA,
      state: 'failure',
      required: true,
      statuses: [
        { context: 'CI / test (pull_request)', state: 'failure', description: "Step 'npm test' failed", target_url: '/acme/website?tab=actions&run=7', created: 1, updated: 1 },
        { context: 'lint', state: 'success', description: 'ok', target_url: '', created: 1, updated: 1 },
      ],
    });
    render(<PullRequestDetail repoPath="acme/website" prNumber={1} onBack={() => {}} />);
    expect(await screen.findByText('Some checks failed')).toBeInTheDocument();
    expect(screen.getByText('CI / test (pull_request)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute('href', '/acme/website?tab=actions&run=7');
    expect(screen.getByText(/Required checks failed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Merge Pull Request/ })).toBeDisabled();
  });

  it('allows merging once everything is green', async () => {
    api.getPullRequestChecks.mockResolvedValue({
      sha: SHA,
      state: 'success',
      required: true,
      statuses: [{ context: 'CI / test (pull_request)', state: 'success', description: 'Successful in 20s', target_url: '', created: 1, updated: 1 }],
    });
    render(<PullRequestDetail repoPath="acme/website" prNumber={1} onBack={() => {}} />);
    expect(await screen.findByText('All checks have passed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Merge Pull Request/ })).toBeEnabled();
  });
});

describe('File finder', () => {
  it('ranks name and segment-start matches first', () => {
    const files = ['src/components/Button.tsx', 'docs/about-this.md', 'src/lib/api.ts', 'backend/src/routes/actions.js'];
    const ranked = files
      .map(f => ({ f, r: fuzzyScore('act', f) }))
      .filter(x => x.r)
      .sort((a, b) => b.r!.score - a.r!.score)
      .map(x => x.f);
    expect(ranked[0]).toBe('backend/src/routes/actions.js');
    expect(fuzzyScore('zzz', 'src/app.ts')).toBeNull();
  });

  it('filters as you type and opens the file on Enter', async () => {
    api.listFiles.mockResolvedValue({ ref: 'main', truncated: false, files: ['README.md', 'src/app.tsx', 'src/lib/api.ts'] });
    const onPick = vi.fn();
    render(<FileFinder repoPath="acme/website" gitRef="main" onPick={onPick} onClose={() => {}} />);
    expect(await screen.findByRole('option', { name: /README\.md/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Find a file'), { target: { value: 'libapi' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    fireEvent.keyDown(screen.getByLabelText('Find a file'), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('src/lib/api.ts');
  });
});

describe('Stars and downloads', () => {
  it('stars a repository for a signed-in user and asks guests to sign in', async () => {
    api.starRepo.mockResolvedValue({ starred: true, stars: 4 });
    const { unmount } = render(
      <MemoryRouter>
        <RepositoryHeader repo={{ ...repo, stars: 3, starred: false }} space="acme" branchCount={1} signedIn />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Star\s*3/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Starred\s*4/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(api.starRepo).toHaveBeenCalledWith('acme/website', true);
    unmount();
    render(
      <MemoryRouter>
        <RepositoryHeader repo={{ ...repo, stars: 3 }} space="acme" branchCount={1} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Star\s*3/ })).toHaveAttribute('href', '/login');
  });

  it('downloads the current branch as a ZIP from the clone menu', async () => {
    api.downloadArchive.mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <RepositoryHeader repo={repo} space="acme" branchCount={1} gitRef="feature/x" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Clone Repo/ }));
    fireEvent.click(screen.getByRole('button', { name: 'ZIP' }));
    expect(api.downloadArchive).toHaveBeenCalledWith('acme/website', 'feature/x', 'zip');
  });

  it('sorts the guest home page by stars', async () => {
    api.listSpaces.mockResolvedValue([]);
    api.listRepos.mockResolvedValue([
      { ...repo, id: 1, uid: 'a', path: 'acme/a', stars: 1 },
      { ...repo, id: 2, uid: 'b', path: 'acme/b', stars: 9 },
    ]);
    render(
      <MemoryRouter>
        <Dashboard user={null} />
      </MemoryRouter>,
    );
    const links = await screen.findAllByRole('link', { name: /^acme\// });
    expect(links.map(l => l.textContent)).toEqual(['acme/b', 'acme/a']);
    expect(screen.getByLabelText('9 stars')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Sort repositories'), { target: { value: 'name' } });
    expect(screen.getAllByRole('link', { name: /^acme\// }).map(l => l.textContent)).toEqual(['acme/a', 'acme/b']);
  });
});
