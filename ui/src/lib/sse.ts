// Server-sent events over fetch. Native EventSource cannot send the
// Authorization header, so this reads the stream by hand, parses `data:`
// frames as JSON, and reconnects with backoff until unsubscribed.

export function subscribeSse<T>(url: string, onEvent: (evt: T) => void): () => void {
  const controller = new AbortController();
  let stopped = false;
  let attempt = 0;

  const headers = (): Record<string, string> => {
    const token = localStorage.getItem('nixre_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const connect = async () => {
    while (!stopped) {
      try {
        const res = await fetch(url, { headers: headers(), signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            try {
              onEvent(JSON.parse(line.slice(5).trim()) as T);
            } catch {
              /* malformed frame — skip */
            }
          }
        }
      } catch {
        // Aborting the fetch throws when we stop; anything else retries.
        if (stopped || controller.signal.aborted) return;
        attempt += 1;
      }
      if (stopped) return;
      await new Promise(r => setTimeout(r, Math.min(5000, 500 * 2 ** attempt)));
    }
  };

  void connect();
  return () => {
    stopped = true;
    controller.abort();
  };
}
