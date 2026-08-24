// Nixre Core REST API Client — 100% sovereign (nixre-core backend).

export interface User {
  id: number;
  uid: string;
  email: string;
  display_name: string;
  admin: boolean;
  blocked?: boolean;
  avatar_url?: string;
  socials?: SocialLink[];
  created?: number;
  updated?: number;
}

export interface ProfileReadme {
  exists: boolean;
  hasReadme: boolean;
  repo: { path: string; default_branch: string; readme: string } | null;
}

export interface ProfileOrg {
  uid: string;
  avatar_url?: string;
}

export interface SpaceMember {
  uid: string;
  display_name: string;
  role: string;
  avatar_url?: string;
}

export interface ContributionDay {
  date: string;
  count: number;
}

export interface Contributions {
  year: number;
  total: number;
  days: ContributionDay[];
}

export interface Space {
  id: number;
  uid: string;
  path: string;
  description: string;
  is_public: boolean;
  is_personal?: boolean;
  avatar_url?: string;
  is_member?: boolean;
  role?: string | null;
  can_manage?: boolean;
  can_transfer?: boolean;
  profile_readme?: ProfileReadme;
  created: number;
  created_by: number;
  updated: number;
}

export interface Repository {
  id: number;
  uid: string;
  path: string;
  description: string;
  is_public: boolean;
  default_branch: string;
  git_url: string;
  git_ssh_url: string;
  size: number;
  num_forks: number;
  num_pulls: number;
  num_open_pulls: number;
  num_closed_pulls: number;
  num_merged_pulls: number;
  created: number;
  updated: number;
  can_write?: boolean;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface CommitActor {
  identity: CommitIdentity;
  when: string;
  uid?: string | null;
  display_name?: string;
  avatar?: string;
  avatar_url?: string;
  linked?: boolean;
}

export interface Commit {
  sha: string;
  title: string;
  message: string;
  author: CommitActor;
  committer: CommitActor;
}

export interface CommitDetail {
  commit: Commit;
  stats: { additions: number; deletions: number; changes: number };
  files: { path: string; additions: number; deletions: number; status: string }[];
}

export interface SocialLink {
  platform: string;
  url: string;
}

export interface UserGoal {
  id: string;
  label: string;
  current: number;
  target: number;
  done: boolean;
  count?: number;
  repo?: { space_uid: string; uid: string; path: string; default_branch: string; readme: string } | null;
}

export interface UserGoals {
  goals: UserGoal[];
}

export interface EnvFeedbackReport {
  missing_binaries: string[];
  missing_packages: string[];
  missing_nixre_tools: string[];
  permission_gaps: string[];
  dockerfile_suggestions: string[];
  notes: string;
}

export interface EnvFeedback {
  id: string;
  user_id: string;
  conversation_id: string | null;
  repo_path: string;
  report: EnvFeedbackReport;
  created_at: string;
}

export interface UserProfile {
  uid: string;
  display_name: string;
  email: string;
  is_self: boolean;
  is_member?: boolean;
  is_admin: boolean;
  bio: string;
  is_public: boolean;
  avatar: string;
  avatar_url?: string;
  socials?: SocialLink[];
  profile_readme?: ProfileReadme;
  created: number;
  orgs?: ProfileOrg[];
  repos: Repository[];
}

export interface Branch {
  name: string;
  sha: string;
  commit?: Commit;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: 'blob' | 'tree';
  mode: number;
  sha: string;
  size?: number;
}

export interface PullRequest {
  number: number;
  title: string;
  description: string;
  state: 'open' | 'merged' | 'closed';
  is_draft: boolean;
  source_branch: string;
  target_branch: string;
  author: {
    uid: string;
    display_name: string;
    email: string;
  };
  created: number;
  updated: number;
  merged?: number;
  merged_by?: {
    uid: string;
    display_name: string;
  };
}

export interface FileDiff {
  sha: string;
  old_sha?: string;
  path: string;
  old_path?: string;
  status: 'UNDEFINED' | 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string; // base64-encoded unified diff, see lib/diff.ts
  is_binary: boolean;
  is_submodule: boolean;
}

export interface PublicKey {
  id: number;
  identifier: string;
  fingerprint: string;
  content: string;
  created: number;
}

export interface Token {
  identifier: string;
  type: string;
  issued_at: number;
  expires_at: number;
}

export interface UserSecret {
  kind: string;
  configured: boolean;
  key_mask?: string | null;
}

export interface UserStt {
  configured: boolean;
  base_url: string | null;
  model: string | null;
  key_mask?: string | null;
}

class ApiClient {
  // nixre-core owns every route (sovereignty complete, phase 4). The session
  // token is a core session (`nxs_...`) or a personal access token
  // (`nxp_...`); both resolve through the same backend middleware.
  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = localStorage.getItem('nixre_token');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`/api/v1${path}`, {
      ...options,
      headers: {
        ...this.getHeaders(),
        ...(options.headers as Record<string, string> | undefined),
      },
      credentials: 'include',
    });

    if (res.status === 401) {
      // Unauthorized
      localStorage.removeItem('nixre_token');
      localStorage.removeItem('nixre_user');
      if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
        window.location.href = '/login';
      }
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      let msg = `HTTP error ${res.status}`;
      try {
        const body = await res.json();
        if (body.message) msg = body.message;
      } catch {}
      throw new Error(msg);
    }

    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return res.json();
    }
    return {} as T;
  }

  // Auth endpoints
  async login(login_identifier: string, password: string):Promise<{ access_token: string; user: User }> {
    const data = await this.request<{ access_token: string }>('/login', {
      method: 'POST',
      body: JSON.stringify({ login_identifier, password }),
    });
    localStorage.setItem('nixre_token', data.access_token);
    const user = await this.currentUser();
    localStorage.setItem('nixre_user', JSON.stringify(user));
    return { access_token: data.access_token, user };
  }

  async register(uid: string, email: string, display_name: string, password: string): Promise<{ access_token: string; user: User }> {
    const data = await this.request<{ access_token: string }>('/register', {
      method: 'POST',
      body: JSON.stringify({ uid, email, display_name, password }),
    });
    localStorage.setItem('nixre_token', data.access_token);
    const user = await this.currentUser();
    localStorage.setItem('nixre_user', JSON.stringify(user));
    return { access_token: data.access_token, user };
  }

  async currentUser(): Promise<User> {
    return this.request<User>('/user');
  }

  async logout(): Promise<void> {
    try {
      await this.request('/logout', { method: 'POST' });
    } catch {}
    localStorage.removeItem('nixre_token');
    localStorage.removeItem('nixre_user');
  }

  // Spaces (Organizations)
  async listSpaces(): Promise<Space[]> {
    try {
      const memberships = await this.request<any[]>('/user/memberships');
      if (Array.isArray(memberships) && memberships.length > 0) {
        return memberships.map(m => this.normalizeSpace(m.space));
      }
    } catch {}
    try {
      const direct = await this.request<Space[]>('/spaces');
      if (Array.isArray(direct)) return direct;
    } catch {}
    return [];
  }

  async getSpace(spaceRef: string): Promise<Space> {
    const res = await this.request<any>(`/spaces/${spaceRef}`);
    return this.normalizeSpace(res);
  }

  async updateSpace(spaceUid: string, update: { description?: string; is_public?: boolean }): Promise<Space> {
    const res = await this.request<any>(`/spaces/${spaceUid}`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    });
    return this.normalizeSpace(res);
  }

  private normalizeSpace(res: any): Space {
    return {
      id: res.id,
      uid: res.identifier || res.path || res.uid,
      path: res.path || res.identifier,
      description: res.description || '',
      is_public: res.is_public ?? false,
      is_personal: res.is_personal ?? false,
      is_member: res.is_member ?? false,
      role: res.role ?? null,
      can_manage: res.can_manage ?? false,
      can_transfer: res.can_transfer ?? false,
      avatar_url: res.avatar_url || '',
      profile_readme: res.profile_readme,
      created: res.created || 0,
      created_by: res.created_by || 0,
      updated: res.updated || 0,
    };
  }

  async createSpace(uid: string, description: string, is_public = false): Promise<Space> {
    const res = await this.request<any>('/spaces', {
      method: 'POST',
      body: JSON.stringify({ uid, description, is_public }),
    });
    return {
      id: res.id,
      uid: res.identifier || res.path || res.uid,
      path: res.path || res.identifier,
      description: res.description || '',
      is_public: res.is_public ?? false,
      is_personal: res.is_personal ?? false,
      avatar_url: res.avatar_url || '',
      created: res.created || 0,
      created_by: res.created_by || 0,
      updated: res.updated || 0,
    };
  }

  // Repositories
  async listRepos(spaceRef?: string): Promise<Repository[]> {
    if (spaceRef) {
      const res = await this.request<any[]>(`/spaces/${spaceRef}/repos`);
      return Array.isArray(res) ? res : [];
    }
    // Fetch spaces first, then fetch all repos across spaces
    const spaces = await this.listSpaces();
    if (spaces.length === 0) {
      try {
        const direct = await this.request<any[]>('/repos');
        return Array.isArray(direct) ? direct : [];
      } catch {
        return [];
      }
    }
    const repoPromises = spaces.map(s => this.request<any[]>(`/spaces/${s.uid}/repos`).catch(() => []));
    const results = await Promise.all(repoPromises);
    const allRepos: Repository[] = [];
    for (const rList of results) {
      if (Array.isArray(rList)) {
        allRepos.push(...rList);
      }
    }
    return allRepos;
  }

  async getRepo(repoRef: string): Promise<Repository> {
    return this.request<Repository>(`/repos/${repoRef}/+`);
  }

  async createRepo(parent_ref: string, uid: string, description: string, is_public = true, readme = true, default_branch = 'main', readmeContent?: string): Promise<Repository> {
    try {
      return await this.request<Repository>('/repos', {
        method: 'POST',
        body: JSON.stringify({
          parent_ref,
          uid,
          description,
          is_public,
          readme,
          default_branch,
          ...(readmeContent !== undefined ? { readmeContent } : {}),
        }),
      });
    } catch (err) {
      // A timed-out first create still writes the row. Retry then looks like
      // "already exists" (or a 502). Open the existing repo instead of failing.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists|502/i.test(msg)) {
        try {
          return await this.getRepo(`${parent_ref}/${uid}`);
        } catch {
          /* fall through */
        }
      }
      throw err;
    }
  }

  async updateRepo(repoRef: string, update: { description?: string; is_public?: boolean }): Promise<Repository> {
    return this.request<Repository>(`/repos/${repoRef}/+`, {
      method: 'PATCH',
      body: JSON.stringify(update),
    });
  }

  async deleteRepo(repoRef: string): Promise<void> {
    await this.request(`/repos/${repoRef}/+`, { method: 'DELETE' });
  }

  async transferRepo(repoRef: string, dest: { space: string; uid?: string }): Promise<Repository> {
    return this.request<Repository>(`/repos/${repoRef}/+/transfer`, {
      method: 'POST',
      body: JSON.stringify(dest),
    });
  }

  // Git / Code Explorer
  // Gitness serves repo content at /repos/{ref}/+/content/{path}?git_ref={ref}
  // and nests the listing under `content.entries` with `file`/`dir` types.
  async getTree(repoRef: string, gitRef = 'main', path = ''): Promise<{ entries: TreeEntry[] }> {
    const pathSegment = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
    const res = await this.request<any>(`/repos/${repoRef}/+/content${pathSegment}?git_ref=${encodeURIComponent(gitRef)}`);
    const rawEntries: any[] = res.content?.entries || [];
    const entries: TreeEntry[] = rawEntries.map(e => ({
      path: e.path,
      name: e.name,
      type: e.type === 'dir' ? 'tree' : 'blob',
      mode: e.mode ?? 0,
      sha: e.sha,
      size: e.size,
    }));
    return { entries };
  }

  async getRawBlob(repoRef: string, gitRef = 'main', path = ''): Promise<{ content: string; name: string; size: number }> {
    const pathSegment = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
    const res = await fetch(`/api/v1/repos/${repoRef}/+/raw${pathSegment}?git_ref=${encodeURIComponent(gitRef)}`, {
      headers: this.getHeaders(),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP error ${res.status}`;
      try {
        const body = JSON.parse(text);
        if (body.message) msg = body.message;
      } catch {}
      throw new Error(msg);
    }
    return { content: text, name: path.split('/').pop() || '', size: text.length };
  }

  async getCommits(repoRef: string, gitRef = 'main', page = 1, limit = 25, path?: string, follow = false): Promise<{ commits: Commit[] }> {
    const params = new URLSearchParams();
    params.set('git_ref', gitRef);
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (path) params.set('path', path);
    if (follow) params.set('follow', 'true');
    const res = await this.request<any>(`/repos/${repoRef}/+/commits?${params.toString()}`);
    return { commits: res.commits || [] };
  }

  async getCommit(repoRef: string, sha: string): Promise<CommitDetail> {
    return this.request<CommitDetail>(`/repos/${repoRef}/+/commits/${sha}`);
  }

  async commitFiles(
    repoRef: string,
    body: {
      branch: string;
      new_branch?: string;
      message: string;
      files: { path: string; content: string; action: 'create' | 'update' }[];
      base_sha?: string;
    },
  ): Promise<{ sha: string; branch: string }> {
    return this.request(`/repos/${repoRef}/+/commits`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getUserProfile(uid: string): Promise<UserProfile> {
    return this.request<UserProfile>(`/users/${uid}`);
  }

  async getUserGoals(uid: string): Promise<UserGoals> {
    return this.request<UserGoals>(`/users/${uid}/goals`);
  }

  async getContributions(kind: 'user' | 'space', uid: string, year: number): Promise<Contributions> {
    const path = kind === 'user' ? `/users/${uid}/contributions` : `/spaces/${uid}/contributions`;
    return this.request<Contributions>(`${path}?year=${year}`);
  }

  async listSpaceMembers(spaceUid: string): Promise<SpaceMember[]> {
    const res = await this.request<SpaceMember[]>(`/spaces/${spaceUid}/members`);
    return Array.isArray(res) ? res : [];
  }

  async addSpaceMember(spaceUid: string, uid: string, role: 'admin' | 'member' = 'member'): Promise<SpaceMember[]> {
    const res = await this.request<SpaceMember[]>(`/spaces/${spaceUid}/members`, {
      method: 'POST',
      body: JSON.stringify({ uid, role }),
    });
    return Array.isArray(res) ? res : [];
  }

  async updateSpaceMember(spaceUid: string, userUid: string, role: 'admin' | 'member'): Promise<SpaceMember[]> {
    const res = await this.request<SpaceMember[]>(`/spaces/${spaceUid}/members/${userUid}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    return Array.isArray(res) ? res : [];
  }

  async removeSpaceMember(spaceUid: string, userUid: string): Promise<SpaceMember[]> {
    const res = await this.request<SpaceMember[]>(`/spaces/${spaceUid}/members/${userUid}`, {
      method: 'DELETE',
    });
    return Array.isArray(res) ? res : [];
  }

  async transferSpace(spaceUid: string, uid: string): Promise<{ space: Space; members: SpaceMember[] }> {
    const res = await this.request<any>(`/spaces/${spaceUid}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ uid }),
    });
    return {
      space: this.normalizeSpace(res),
      members: Array.isArray(res.members) ? res.members : [],
    };
  }

  async updateUserProfile(update: { display_name?: string; socials?: SocialLink[] }): Promise<User> {
    return this.request<User>('/user/profile', {
      method: 'PUT',
      body: JSON.stringify(update),
    });
  }

  async getBranches(repoRef: string): Promise<Branch[]> {
    const res = await this.request<any>(`/repos/${repoRef}/+/branches`);
    return res.branches || res || [];
  }

  // Pull Requests
  async listPullRequests(repoRef: string, state = 'open', page = 1): Promise<PullRequest[]> {
    const res = await this.request<any>(`/repos/${repoRef}/+/pullreq?state=${state}&page=${page}`);
    return res.pullrequests || res || [];
  }

  async getPullRequest(repoRef: string, prNumber: number): Promise<PullRequest> {
    return this.request<PullRequest>(`/repos/${repoRef}/+/pullreq/${prNumber}`);
  }

  async createPullRequest(repoRef: string, title: string, description: string, source_branch: string, target_branch: string): Promise<PullRequest> {
    return this.request<PullRequest>(`/repos/${repoRef}/+/pullreq`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        source_branch,
        target_branch,
      }),
    });
  }

  async mergePullRequest(repoRef: string, prNumber: number, method = 'merge'): Promise<void> {
    return this.request(`/repos/${repoRef}/+/pullreq/${prNumber}/merge`, {
      method: 'POST',
      body: JSON.stringify({ method }),
    });
  }

  async getPullRequestDiff(repoRef: string, prNumber: number): Promise<FileDiff[]> {
    const res = await this.request<FileDiff[]>(`/repos/${repoRef}/+/pullreq/${prNumber}/diff?include_patch=true`);
    return Array.isArray(res) ? res : [];
  }

  /** Branch-to-branch diff without a PR (assistant description drafting). */
  async compareBranches(repoRef: string, base: string, head: string): Promise<FileDiff[]> {
    const res = await this.request<FileDiff[]>(
      `/repos/${repoRef}/+/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
    );
    return Array.isArray(res) ? res : [];
  }

  // Keys & Tokens
  async listPublicKeys(): Promise<PublicKey[]> {
    const res = await this.request<any>('/user/publickeys');
    return res.keys || res || [];
  }

  async addPublicKey(identifier: string, content: string): Promise<PublicKey> {
    return this.request<PublicKey>('/user/publickeys', {
      method: 'POST',
      body: JSON.stringify({ identifier, content }),
    });
  }

  async deletePublicKey(identifier: string): Promise<void> {
    return this.request(`/user/publickeys/${identifier}`, { method: 'DELETE' });
  }

  async listTokens(): Promise<Token[]> {
    const res = await this.request<any>('/user/tokens');
    return res.tokens || res || [];
  }

  async createToken(identifier: string, lifetime: number): Promise<{ access_token: string; token: Token }> {
    return this.request('/user/tokens', {
      method: 'POST',
      body: JSON.stringify({ identifier, lifetime }),
    });
  }

  async deleteToken(identifier: string): Promise<void> {
    return this.request(`/user/tokens/${identifier}`, { method: 'DELETE' });
  }

  async listSecrets(): Promise<UserSecret[]> {
    const res = await this.request<UserSecret[]>('/user/secrets');
    return Array.isArray(res) ? res : [];
  }

  async setGithubSecret(token: string): Promise<UserSecret> {
    return this.request<UserSecret>('/user/secrets/github', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    });
  }

  async deleteGithubSecret(): Promise<void> {
    await this.request('/user/secrets/github', { method: 'DELETE' });
  }

  async getStt(): Promise<UserStt> {
    return this.request<UserStt>('/user/stt');
  }

  async setStt(body: { base_url: string; model: string; api_key?: string }): Promise<UserStt> {
    return this.request<UserStt>('/user/stt', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async deleteStt(): Promise<void> {
    await this.request('/user/stt', { method: 'DELETE' });
  }

  async transcribeAudio(audio: string, format: string): Promise<{ text: string }> {
    return this.request<{ text: string }>('/ai/transcribe', {
      method: 'POST',
      body: JSON.stringify({ audio, format }),
    });
  }

  async listEnvFeedback(): Promise<EnvFeedback[]> {
    const res = await this.request<{ reports?: EnvFeedback[] }>('/ai/env-feedback');
    return Array.isArray(res.reports) ? res.reports : [];
  }

  // Avatar uploads
  async setUserAvatar(data: string, mime: string): Promise<{ ok: boolean; avatar_url: string }> {
    return this.request('/user/avatar', {
      method: 'POST',
      body: JSON.stringify({ data, mime }),
    });
  }

  async removeUserAvatar(): Promise<void> {
    await this.request('/user/avatar', { method: 'DELETE' });
  }

  async setSpaceAvatar(spaceUid: string, data: string, mime: string): Promise<{ ok: boolean; avatar_url: string }> {
    return this.request(`/spaces/${spaceUid}/avatar`, {
      method: 'POST',
      body: JSON.stringify({ data, mime }),
    });
  }

  async removeSpaceAvatar(spaceUid: string): Promise<void> {
    await this.request(`/spaces/${spaceUid}/avatar`, { method: 'DELETE' });
  }

  // Admin Controls
  async listUsers(): Promise<User[]> {
    const res = await this.request<any>('/users');
    return res.users || res || [];
  }

  async getRegistrationStatus(): Promise<{ closed: boolean }> {
    return this.request<{ closed: boolean }>('/admin/registration');
  }

  async setRegistrationClosed(closed: boolean): Promise<{ closed: boolean }> {
    return this.request<{ closed: boolean }>('/admin/registration', {
      method: 'PUT',
      body: JSON.stringify({ closed }),
    });
  }
}

export const api = new ApiClient();
