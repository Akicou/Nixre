import { api, type TreeEntry } from './api';

export type TreeLoader = (path: string) => Promise<TreeEntry[]>;

/** Share directory requests between the tree and README discovery for one ref. */
export function createRepositoryTreeLoader(repoPath: string, branch: string): TreeLoader {
  const requests = new Map<string, Promise<TreeEntry[]>>();
  return path => {
    let pending = requests.get(path);
    if (!pending) {
      pending = api.getTree(repoPath, branch, path).then(result => result.entries).catch(error => {
        requests.delete(path);
        throw error;
      });
      requests.set(path, pending);
    }
    return pending;
  };
}
