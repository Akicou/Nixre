// Shared fixture data for the UI test suite.

export const user = {
  id: 1,
  uid: 'jane',
  email: 'jane@nixre.dev',
  display_name: 'Jane Doe',
  admin: false,
};

export const adminUser = {
  ...user,
  id: 2,
  uid: 'admin',
  admin: true,
};

export const space = {
  id: 10,
  uid: 'acme',
  path: 'acme',
  description: 'Acme Corporation',
  is_public: true,
  created: 1700000000,
  created_by: 1,
  updated: 1700000000,
};

export const repo = {
  id: 100,
  uid: 'website',
  path: 'acme/website',
  description: 'The Acme marketing website',
  is_public: true,
  default_branch: 'main',
  git_url: '/git/acme/website.git',
  git_ssh_url: 'ssh://git@host:3022/acme/website.git',
  size: 2048,
  num_forks: 0,
  num_pulls: 1,
  num_open_pulls: 1,
  num_closed_pulls: 0,
  num_merged_pulls: 0,
  created: 1700000000,
  updated: 1700000000,
};

export const treeEntries = [
  { path: 'README.md', name: 'README.md', type: 'blob', mode: 33188, sha: '1111111111111111111111111111111111111111', size: 5356 },
  { path: 'ui', name: 'ui', type: 'tree', mode: 168777, sha: '2222222222222222222222222222222222222222', size: 0 },
  { path: 'LICENSE', name: 'LICENSE', type: 'blob', mode: 33188, sha: '3333333333333333333333333333333333333333', size: 1096 },
];

export const branch = { name: 'main', sha: '4444444444444444444444444444444444444444' };

export const commit = {
  sha: '5555555555555555555555555555555555555555',
  title: 'Initial commit',
  message: 'Initial commit',
  author: { identity: { name: 'jane', email: 'jane@nixre.dev' }, when: '2024-01-01T00:00:00Z' },
  committer: { identity: { name: 'jane', email: 'jane@nixre.dev' }, when: '2024-01-01T00:00:00Z' },
};

export const pullRequest = {
  number: 7,
  title: 'Add landing page',
  description: 'This adds the landing page.',
  state: 'open' as const,
  is_draft: false,
  source_branch: 'feature',
  target_branch: 'main',
  author: { uid: 'jane', display_name: 'Jane Doe', email: 'jane@nixre.dev' },
  created: 1700000000,
  updated: 1700000000,
};
