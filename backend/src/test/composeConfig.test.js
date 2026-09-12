import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const composeFile = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url));
const envFile = fileURLToPath(new URL('../../../.env.example', import.meta.url));

// Keep CLI/plugin discovery working without inheriting operator secrets, PG*,
// COMPOSE_* overrides, Docker endpoints, or application policy settings.
const cliEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
const fixtureEnv = {
  ...cliEnv,
  COMPOSE_DISABLE_ENV_FILE: 'true',
  NIXRE_INTERNAL_TOKEN: 'compose-test-internal-token-not-a-real-secret',
  NIXRE_AI_SECRET: 'compose-test-ai-key-not-a-real-secret',
  POSTGRES_PASSWORD: 'compose-test-password-not-a-real-secret',
};

function config(project, overrides = {}) {
  const result = spawnSync('docker', [
    'compose', '-f', composeFile, '--env-file', envFile, '-p', project,
    'config', '--format', 'json',
  ], {
    cwd: workspace,
    env: { ...fixtureEnv, ...overrides },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  // Never expose stdout/stderr: either can contain interpolated credentials.
  assert.ok(!result.error, 'docker compose config must execute successfully');
  assert.equal(result.status, 0, 'docker compose config must accept the workspace configuration');
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail('docker compose config must return valid JSON (output withheld)');
  }
}

function forwarded(environment, expected) {
  for (const [key, value] of Object.entries(expected)) {
    // Canonical Compose output escapes literal dollars as $$ for reloading.
    const actual = environment[key]?.replaceAll('$$', '$');
    // Boolean assertions keep even individual credential values out of diffs.
    assert.ok(actual === value, `${key} must match its fixture value`);
  }
}

test('workspace Docker Compose configuration contracts (no daemon required)', async t => {
  const probe = spawnSync('docker', ['compose', 'version'], {
    cwd: workspace, env: cliEnv, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  if (probe.error?.code === 'ENOENT' || (!probe.error && probe.status !== 0)) {
    t.skip('Docker Compose CLI unavailable: docker compose version could not run; no daemon is required');
    return;
  }
  assert.ok(!probe.error && probe.status === 0, 'Docker Compose CLI availability probe must complete');

  for (const project of ['nixre-contract-one', 'forge-contract-two']) {
    for (const custom of [false, true]) {
      await t.test(`${project}: ${custom ? 'explicit' : 'default'} network identities and isolation`, () => {
        const overrides = custom ? {
          NIXRE_APPS_NETWORK: `${project}-custom-apps`,
          NIXRE_DATA_NETWORK: `${project}-private-db`,
        } : { NIXRE_APPS_NETWORK: '', NIXRE_DATA_NETWORK: '' };
        const { services, networks } = config(project, { ...overrides, SANDBOX_NETWORK: '' });
        const core = services['nixre-core'];
        const appName = custom ? overrides.NIXRE_APPS_NETWORK : 'nixre-apps';
        const dataName = custom ? overrides.NIXRE_DATA_NETWORK : `${project}_nixre-data`;

        assert.equal(networks.default.name, `${project}_default`);
        assert.equal(core.environment.SANDBOX_NETWORK, networks.default.name);
        assert.equal(networks['nixre-apps'].name, appName);
        assert.equal(core.environment.NIXRE_APPS_NETWORK, networks['nixre-apps'].name);
        assert.equal(networks['nixre-data'].name, dataName);
        assert.equal(core.environment.NIXRE_DATA_NETWORK, networks['nixre-data'].name,
          'the exclusion must use the actual data network name, not its Compose key');
        assert.equal(networks['nixre-data'].internal, true);
        assert.notEqual(dataName, appName);
        assert.notEqual(dataName, core.environment.SANDBOX_NETWORK);
        assert.deepEqual(Object.keys(core.networks).sort(), ['default', 'nixre-apps', 'nixre-data']);
        assert.deepEqual(Object.keys(services['nixre-db'].networks), ['nixre-data']);
        assert.equal(services['nixre-db'].ports?.length ?? 0, 0);
        for (const service of ['nixre-ssh', 'nixre-web', 'nixre-agent-sandbox']) {
          assert.deepEqual(Object.keys(services[service].networks), ['default'],
            `${service} must retain the legacy network without database access`);
        }
      });
    }
  }

  await t.test('current and legacy secret migration settings reach core', () => {
    const overrides = {
      NIXRE_AI_SECRET_LEGACY: 'compose-test-previous-key-not-a-real-secret',
      NIXRE_SECRET_SALT: 'compose-test-current-salt',
      NIXRE_SECRET_SALT_LEGACY: 'compose-test-previous-salt',
      ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY: '1',
    };
    const { services } = config('nixre-contract-secrets', overrides);
    forwarded(services['nixre-core'].environment, {
      INTERNAL_TOKEN: fixtureEnv.NIXRE_INTERNAL_TOKEN,
      AI_SECRET: fixtureEnv.NIXRE_AI_SECRET,
      AI_SECRET_LEGACY: overrides.NIXRE_AI_SECRET_LEGACY,
      NIXRE_SECRET_SALT: overrides.NIXRE_SECRET_SALT,
      NIXRE_SECRET_SALT_LEGACY: overrides.NIXRE_SECRET_SALT_LEGACY,
      ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY: overrides.ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY,
    });
    forwarded(services['nixre-ssh'].environment, { INTERNAL_TOKEN: fixtureEnv.NIXRE_INTERNAL_TOKEN });
  });

  await t.test('standalone Git allowlist reaches core without changing the default', () => {
    const defaults = config('nixre-contract-git');
    assert.equal(defaults.services['nixre-core'].environment.NIXRE_DEPLOY_GIT_HOSTS, '');
    const configured = config('nixre-contract-git', { NIXRE_DEPLOY_GIT_HOSTS: 'gitlab.com,codeberg.org' });
    assert.equal(configured.services['nixre-core'].environment.NIXRE_DEPLOY_GIT_HOSTS, 'gitlab.com,codeberg.org');
  });

  await t.test('Postgres uses separate fields and preserves URI punctuation in passwords', () => {
    const overrides = {
      POSTGRES_USER: 'compose_fixture_user',
      POSTGRES_DB: 'compose_fixture_database',
      POSTGRES_PASSWORD: 'fixture:@/?#[]%+$with_dollar${NOT_AN_ENV_VAR}&=!',
    };
    const { services } = config('nixre-contract-postgres', overrides);
    forwarded(services['nixre-db'].environment, overrides);
    const coreEnv = services['nixre-core'].environment;
    forwarded(coreEnv, {
      PGHOST: 'nixre-db', PGPORT: '5432', PGUSER: overrides.POSTGRES_USER,
      PGDATABASE: overrides.POSTGRES_DB, PGPASSWORD: overrides.POSTGRES_PASSWORD,
    });
    for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'PGCONNECTIONSTRING']) {
      assert.equal(Object.hasOwn(coreEnv, key), false, `${key} must not override separate PG fields`);
    }
  });

  await t.test('security, resolver and resource settings have safe example defaults', () => {
    const { services } = config('nixre-contract-defaults');
    forwarded(services['nixre-core'].environment, {
      AI_SECRET_LEGACY: '', NIXRE_SECRET_SALT_LEGACY: '',
      ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY: '',
      NIXRE_SECRET_SALT: 'nixre.instance.secret.v1',
      NIXRE_DEPLOY_BIND_ALLOWLIST: '', NIXRE_DEPLOY_ALLOW_PRIVILEGED: 'false',
      NIXRE_DEPLOY_ALLOW_HOST_NETWORK: 'false', NIXRE_REGISTRATION_CLOSED: 'true',
      TRUSTED_PROXY_CIDRS: '', NIXRE_RESERVED_DOMAINS: '', NIXRE_AI_PRIVATE_ORIGINS: '',
      SANDBOX_IDLE_MS: '900000', SANDBOX_MEMORY_BYTES: '2147483648',
      SANDBOX_NANO_CPUS: '2000000000', SANDBOX_PIDS_LIMIT: '512',
      DEPLOY_PIDS_LIMIT: '512', DEPLOY_MAX_SERVICES_PER_REPO: '20',
      NIXRE_VERIFY_RESOLVERS: '1.1.1.1,8.8.8.8,9.9.9.9',
      BLOCKED_PEER_NAMES: 'nixre-core,nixre-db,nixre-ssh,nixre-web,nixre-tunnel',
    });
    forwarded(services['nixre-web'].environment, { NIXRE_TRUSTED_EDGE_CIDRS: '' });
  });

  await t.test('operator security, resolver and resource overrides reach core unchanged', () => {
    const overrides = {
      NIXRE_DEPLOY_BIND_ALLOWLIST: '/srv/compose-fixture,/opt/compose-fixture',
      NIXRE_DEPLOY_ALLOW_PRIVILEGED: 'true', NIXRE_DEPLOY_ALLOW_HOST_NETWORK: 'true',
      NIXRE_REGISTRATION_CLOSED: 'false', NIXRE_RESERVED_DOMAINS: 'forge.example.test,ssh.example.test',
      NIXRE_AI_PRIVATE_ORIGINS: 'http://fixture-model:11434,http://fixture-stt:8080',
      BLOCKED_PEER_NAMES: 'fixture-db,fixture-admin', NIXRE_VERIFY_RESOLVERS: '8.8.4.4,1.0.0.1',
      TRUSTED_PROXY_CIDRS: '192.0.2.10/32,2001:db8::10/128',
      SANDBOX_IDLE_MS: '45000', SANDBOX_MEMORY_BYTES: '536870912', SANDBOX_NANO_CPUS: '500000000',
      SANDBOX_PIDS_LIMIT: '64', DEPLOY_PIDS_LIMIT: '96', DEPLOY_MAX_SERVICES_PER_REPO: '3',
      DEPLOY_HEALTH_TIMEOUT_MS: '17000', DEPLOY_PROXY_TIMEOUT_MS: '65000',
    };
    forwarded(config('nixre-contract-policy', overrides).services['nixre-core'].environment, overrides);
  });

  await t.test('Caddy receives space-separated edge trust independently of core trust', () => {
    const overrides = {
      NIXRE_TRUSTED_EDGE_CIDRS: '127.0.0.1/32 ::1/128 192.0.2.20/32',
      TRUSTED_PROXY_CIDRS: '192.0.2.30/32,2001:db8::30/128',
    };
    const { services } = config('nixre-contract-edge', overrides);
    forwarded(services['nixre-web'].environment, {
      NIXRE_TRUSTED_EDGE_CIDRS: overrides.NIXRE_TRUSTED_EDGE_CIDRS,
    });
    forwarded(services['nixre-core'].environment, { TRUSTED_PROXY_CIDRS: overrides.TRUSTED_PROXY_CIDRS });
    assert.equal(services['nixre-web'].image, 'caddy:2-alpine');
    const caddyMount = services['nixre-web'].volumes.find(volume => volume.target === '/etc/caddy/Caddyfile');
    assert.ok(caddyMount, 'web must mount the workspace Caddy configuration');
    assert.equal(caddyMount.source.replaceAll('\\', '/'), `${workspace.replaceAll('\\', '/').replace(/\/$/, '')}/Caddyfile`);
  });
});
