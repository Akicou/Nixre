# Authentication & access

Nixre owns its own auth: **argon2 password hashes, server-side sessions, WebAuthn passkeys, personal access tokens (PATs), and SSH keys**. Passwords are never used for git transport.

## Web login

- `POST /api/v1/login` with `{username, password}` → session cookie/token.
- Passkeys (WebAuthn) live server-side in your account and can open a new session.
- Sessions are stored in the `sessions` table (plaintext token id for debugging).
- **Logout** invalidates the session.

## Mint a personal access token (for git over HTTPS)

**Settings → Access Tokens → Generate.** Tokens start with `nxp_`, are shown **only once**, are stored **hashed**, and have a lifetime (default 30 days). When it expires you get `Authentication failed` and mint a new one.

## Git over HTTPS

Username is **ignored**; the **password must be a PAT**.

```bash
git clone https://git.nixre.dev/git/<space>/<repo>.git
# prompts: username = anything, password = nxp_...
# or embed:
git clone https://<username>:<token>@git.nixre.dev/git/<space>/<repo>.git
```

Credential managers cache it after the first success. If git keeps failing after fixing creds, clear the stale cache:
- Windows: Credential Manager → Windows Credentials → `git:https://git.nixre.dev`
- macOS: `git credential-osxkeychain erase`

## Git over SSH (recommended — no prompts, no expiry)

1. Register a public key at **Settings → SSH Keys** (fingerprints shown).
2. The `nixre-ssh` container's `AuthorizedKeysCommand` resolves keys via core, and each session is locked to a per-key git-shell wrapper that ACL-checks the repo.
3. Clone over the tunnel:

```bash
git clone ssh://git@ssh.nixre.dev:3022/<space>/<repo>.git
```

On this server, connect with `ProxyCommand cloudflared access ssh` if you run the client from the host itself; from your own machine plain `ssh` through the tunnel `ssh.nixre.dev:3022` works.

## Admin

- The **first account** ever created is the instance admin (`admin` flag set at registration).
- Admin endpoints: `GET/PATCH /api/v1/admin/users`, and `POST /api/v1/admin/registration` (set/reset whether self-service register is open).
- **Registration is closed** on this instance (`NIXRE_REGISTRATION_CLOSED=true`, plus the kill switch). Add users by having them register when the switch is open, or insert/update directly in the DB.

## GitHub access for the assistant

The assistant can clone/mirror `github.com` repos via your stored GitHub personal access token (set in the assistant settings). **There is no shell GitHub credential on this server**, so a terminal `git push` to GitHub fails with "could not read Username for 'https://github.com'". Any GitHub push must be done from a machine with credentials.

## Debug session (developer only)

For local testing, insert a temp session into the `sessions` table and use `Authorization: Bearer dbg-XX`. **Always delete debug sessions after use.**

```bash
docker exec nixre-db psql -U nixre -d nixre \
  -c "INSERT INTO sessions (id, user_uid, created, expires) VALUES ('dbg-XX', 'Lyan', $1, $2);"
# then: curl -H 'Authorization: Bearer dbg-XX' https://git.nixre.dev/api/v1/user
```

Admin user uid on this instance is `Lyan`.
