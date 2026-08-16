// Gitness REST API Client

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

export interface Commit {
  sha: string;
  title: string;
  message: string;
  author: {
    identity: {
      name: string;
      email: string;
    };
    when: string;
  };
  committer: {
    identity: {
      name: string;
      email: string;
    };
    when: string;
  };
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
  private getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = localStorage.getItem('aether_token');
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
        ...(options.headers || {}),
      },
      credentials: 'include',
    });

    if (res.status === 401) {
      // Unauthorized
      localStorage.removeItem('aether_token');
      localStorage.removeItem('aether_user');
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
    localStorage.setItem('aether_token', data.access_token);
    const user = await this.currentUser();
    localStorage.setItem('aether_user', JSON.stringify(user));
    return { access_token: data.access_token, user };
  }

  async register(uid: string, email: string, display_name: string, password: string): Promise<{ access_token: string; user: User }> {
    const data = await this.request<{ access_token: string }>('/register', {
      method: 'POST',
      body: JSON.stringify({ uid, email, display_name, password }),
    });
    localStorage.setItem('aether_token', data.access_token);
    const user = await this.currentUser();
    localStorage.setItem('aether_user', JSON.stringify(user));
    return { access_token: data.access_token, user };
  }

  async currentUser(): Promise<User> {
    return this.request<User>('/user');
  }

  async logout(): Promise<void> {
    try {
      await this.request('/logout', { method: 'POST' });
    } catch {}
    localStorage.removeItem('aether_token');
    localStorage.removeItem('aether_user');
  }

  // Spaces (Organizations)
  async listSpaces(): Promise<Space[]> {
    return this.request<Space[]>('/spaces');
  }

  async getSpace(spaceRef: string): Promise<Space> {
    return this.request<Space>(`/spaces/${spaceRef}`);
  }

  async createSpace(uid: string, description: string, is_public = false): Promise<Space> {
    return this.request<Space>('/spaces', {
      method: 'POST',
      body: JSON.stringify({ uid, description, is_public }),
    });
  }

  // Repositories
  async listRepos(spaceRef?: string): Promise<Repository[]> {
    if (spaceRef) {
      return this.request<Repository[]>(`/spaces/${spaceRef}/repos`);
    }
    return this.request<Repository[]>('/repos');
  }

  async getRepo(repoRef: string): Promise<Repository> {
    return this.request<Repository>(`/repos/${repoRef}/+`);
  }

  async createRepo(parent_ref: string, uid: string, description: string, is_public = true, readme = true, default_branch = 'main'): Promise<Repository> {
    return this.request<Repository>('/repos', {
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
  }

  // Git / Code Explorer
  async getTree(repoRef: string, gitRef = 'main', path = ''): Promise<{ entries: TreeEntry[] }> {
    const qPath = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await this.request<any>(`/repos/${repoRef}/+/content/${gitRef}${qPath}`);
    return { entries: res.content?.entries || [] };
  }

  async getRawBlob(repoRef: string, gitRef = 'main', path = ''): Promise<{ content: string; name: string; size: number }> {
    const qPath = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await fetch(`/api/v1/repos/${repoRef}/+/raw/${gitRef}${qPath}`, {
      headers: this.getHeaders(),
    });
    const text = await res.text();
    return { content: text, name: path.split('/').pop() || '', size: text.length };
  }

  async getCommits(repoRef: string, gitRef = 'main', page = 1, limit = 25): Promise<{ commits: Commit[] }> {
    const res = await this.request<any>(`/repos/${repoRef}/+/commits?git_ref=${encodeURIComponent(gitRef)}&page=${page}&limit=${limit}`);
    return { commits: res.commits || [] };
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
}

export const api = new ApiClient();
