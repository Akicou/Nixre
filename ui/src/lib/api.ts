// Nixre Core REST API Client — 100% sovereign (nixre-core backend).

export interface User {
  id: number;
  uid: string;
  email: string;
  display_name: string;
  admin: boolean;
  blocked?: boolean;
  created?: number;
  updated?: number;
}

export interface Space {
  id: number;
  uid: string;
  path: string;
  description: string;
  is_public: boolean;
  is_personal?: boolean;
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

export interface UserProfile {
  uid: string;
  display_name: string;
  email: string;
  is_self: boolean;
  is_admin: boolean;
  bio: string;
  is_public: boolean;
  avatar: string;
  created: number;
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
        return memberships.map(m => ({
          id: m.space.id,
          uid: m.space.identifier || m.space.path || m.space.uid,
          path: m.space.path || m.space.identifier,
          description: m.space.description || '',
          is_public: m.space.is_public ?? false,
          is_personal: m.space.is_personal ?? false,
          created: m.space.created || 0,
          created_by: m.space.created_by || 0,
          updated: m.space.updated || 0,
        }));
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
    return {
      id: res.id,
      uid: res.identifier || res.path || res.uid,
      path: res.path || res.identifier,
      description: res.description || '',
      is_public: res.is_public ?? false,
      is_personal: res.is_personal ?? false,
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

  async createRepo(parent_ref: string, uid: string, description: string, is_public = true, readme = true, default_branch = 'main'): Promise<Repository> {
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

  async getUserProfile(uid: string): Promise<UserProfile> {
    return this.request<UserProfile>(`/users/${uid}`);
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
