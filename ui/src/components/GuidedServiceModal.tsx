import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Box, Cpu, Database, GitBranch, Loader2, X } from 'lucide-react';
import { api, DeploymentCapabilities, DeployService, StandaloneServiceInput } from '../lib/api';
import { parseDotenv } from '../lib/dotenv';

export type ServicePreset = 'git' | 'image' | 'llama' | 'postgres';
const inputClass = 'w-full min-w-0 rounded-md border border-border-subtle bg-surface-base px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-50';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-xs font-medium text-txt-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50';

export function GuidedServiceModal({ space, capabilities, initialPreset = 'git', onClose, onComplete }: {
  space: string;
  capabilities?: DeploymentCapabilities;
  initialPreset?: ServicePreset;
  onClose: () => void;
  onComplete: (service: DeployService) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const scrollBody = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const [preset, setPreset] = useState<ServicePreset>(initialPreset);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initialPreset === 'llama' ? 'llama-server' : initialPreset === 'postgres' ? 'postgres' : '');
  const [gitUrl, setGitUrl] = useState(initialPreset === 'llama' ? 'https://github.com/ggml-org/llama.cpp' : '');
  const [branch, setBranch] = useState(initialPreset === 'llama' ? 'master' : 'main');
  const [refType, setRefType] = useState('branch');
  const [pr, setPr] = useState('');
  const [image, setImage] = useState('');
  const [version, setVersion] = useState('17');
  const [database, setDatabase] = useState('app');
  const [username, setUsername] = useState('app');
  const [root, setRoot] = useState('.');
  const [dockerfile, setDockerfile] = useState(initialPreset === 'llama' ? '.devops/cpu.Dockerfile' : 'Dockerfile');
  const [target, setTarget] = useState(initialPreset === 'llama' ? 'server' : '');
  const [port, setPort] = useState(8080);
  const [cpu, setCpu] = useState(initialPreset === 'llama' ? 2 : 1);
  const [memory, setMemory] = useState(initialPreset === 'llama' ? 8192 : 512);
  const [exposure, setExposure] = useState<'internal' | 'http'>('internal');
  const [volume, setVolume] = useState('');
  const [model, setModel] = useState('');
  const [gpu, setGpu] = useState(false);
  const [context, setContext] = useState(4096);
  const [entrypoint, setEntrypoint] = useState('/app/llama-server');
  const [command, setCommand] = useState('');
  const [healthType, setHealthType] = useState<'http' | 'tcp'>('http');
  const [healthPath, setHealthPath] = useState(initialPreset === 'llama' ? '/health' : '/');
  const [healthTimeout, setHealthTimeout] = useState(initialPreset === 'llama' ? 300000 : 60000);
  const [envText, setEnvText] = useState('');
  const [review, setReview] = useState<StandaloneServiceInput | null>(null);
  const [created, setCreated] = useState<DeployService | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isLlama = preset === 'llama';
  const isPostgres = preset === 'postgres';
  const isGit = preset === 'git' || isLlama;
  const mountsAllowed = Boolean(capabilities?.host_mounts && capabilities.bind_allowlist.length);

  // Keep focus inside the modal, restore its opener, and never lose a created ID mid-request.
  const dismiss = useRef(() => {});
  dismiss.current = () => { if (!submitting.current) { if (created) onComplete(created); else onClose(); } };
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    heading.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss.current(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || []);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); heading.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); opener?.focus(); };
  }, []);
  useEffect(() => {
    if (scrollBody.current) scrollBody.current.scrollTop = 0;
    heading.current?.focus();
  }, [step]);

  function choose(next: ServicePreset) {
    setPreset(next); setError(''); setCommand(''); setEnvText(''); setGpu(false); setModel('');
    setName(next === 'llama' ? 'llama-server' : next === 'postgres' ? 'postgres' : '');
    setGitUrl(next === 'llama' ? 'https://github.com/ggml-org/llama.cpp' : '');
    setBranch(next === 'llama' ? 'master' : 'main'); setRefType('branch'); setPr('');
    setImage(''); setVersion('17'); setDatabase('app'); setUsername('app');
    setDockerfile(next === 'llama' ? '.devops/cpu.Dockerfile' : 'Dockerfile');
    setTarget(next === 'llama' ? 'server' : ''); setRoot('.');
    setCpu(next === 'llama' ? 2 : 1); setMemory(next === 'llama' ? 8192 : 512);
    setPort(8080); setHealthType('http'); setEntrypoint('/app/llama-server'); setContext(4096);
    setHealthPath(next === 'llama' ? '/health' : '/'); setHealthTimeout(next === 'llama' ? 300000 : 60000);
    setExposure('internal'); setVolume(''); setReview(null);
  }

  function makeInput(): StandaloneServiceInput {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name)) throw new Error('Use a lowercase service name of at most 40 letters, numbers or hyphens, with no leading or trailing hyphen.');
    const resources = { name, cpu_cores: cpu, memory_mb: memory };
    if (isPostgres) return { ...resources, source_type: 'image', template: 'postgres', image_ref: `postgres:${version}`, database, username };
    const env = parseDotenv(envText);
    if (env.errors.length) throw new Error(env.errors.join('\n'));
    let args: string[] | null = null;
    if (command.trim()) {
      try { args = JSON.parse(command); } catch { throw new Error('Command must be a JSON array of strings, for example ["--verbose"].'); }
      if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('Command must be a JSON array of strings.');
    }
    if (isLlama) {
      const path = model.trim();
      const approved = capabilities?.bind_allowlist.some(prefix => path === prefix || path.startsWith(`${prefix.replace(/\/+$/, '')}/`));
      if (!mountsAllowed || !approved || !path.startsWith('/') || /[:\s\0\\]/.test(path) || path.includes('..') || path.split('/').some(part => part === '.')) {
        throw new Error('Enter an absolute deployment-host GGUF file path under an approved prefix. Host mounts require instance-admin permission and an operator allowlist.');
      }
      if (gpu && !capabilities?.gpus) throw new Error('The operator has not granted GPU access.');
      args = ['--model', '/models/model.gguf', '--host', '0.0.0.0', '--port', String(port), '--ctx-size', String(context), '--n-gpu-layers', gpu ? '99' : '0', ...(args || [])];
    }
    return {
      ...resources, source_type: isGit ? 'git' : 'image',
      ...(isGit ? { git_url: gitUrl.trim(), branch: refType === 'pr' ? `refs/pull/${pr}/head` : branch.trim(), root_dir: root.trim(), dockerfile_path: dockerfile.trim(), build_target: target.trim() || null } : { image_ref: image.trim() }),
      container_port: port, exposure, deployment_strategy: 'recreate',
      volume_path: isLlama ? null : volume.trim() || null,
      runtime_options: {
        health_type: isLlama ? 'http' : healthType, health_path: healthPath, health_timeout_ms: healthTimeout,
        command: args,
        ...(isLlama ? { entrypoint: [entrypoint.trim()], host_config: { binds: [`${model.trim()}:/models/model.gguf:ro`], gpus: gpu ? 'all' : null } } : {}),
      }, env: env.vars,
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    try {
      if (step === 0) {
        if (isLlama && !mountsAllowed) throw new Error('Host model setup is disabled by operator policy. Choose External Git or Container image instead.');
        if (isGit) {
          let url: URL;
          try { url = new URL(gitUrl); } catch { throw new Error('Enter an HTTPS Git repository URL.'); }
          if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS Git URL without embedded credentials, query or fragment.');
          if (refType === 'pr' && !/^[1-9]\d*$/.test(pr)) throw new Error('Enter a positive pull request number.');
        }
        setStep(1); return;
      }
      if (step === 1) { setReview(makeInput()); setStep(2); return; }
      if (!review) return;
      submitting.current = true; setBusy(true);
      let service = created;
      if (!service) {
        service = await api.createStandaloneService(space, review);
        setCreated(service);
      }
      try { await api.deployService(space, null, service.id); }
      catch (e) { throw new Error(`Service "${service.name}" was created, but deployment was not confirmed. ${e instanceof Error ? e.message : 'Request failed.'} Open the service to check its status, or retry deployment. No second service will be created.`); }
      onComplete(service);
    } catch (e) { setError(e instanceof Error ? e.message : 'Service request failed.'); }
    finally { submitting.current = false; setBusy(false); }
  }

  const field = (label: string, control: React.ReactNode, help?: string) => <label className="block min-w-0 space-y-1.5 text-xs text-txt-secondary"><span>{label}</span>{control}{help && <span className="block text-[11px] text-txt-tertiary leading-relaxed">{help}</span>}</label>;
  const text = (value: string, change: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => <input className={inputClass} value={value} onChange={e => change(e.target.value)} {...props} />;
  const number = (value: number, change: (v: number) => void, min: number, max: number, stepSize = 1) => <input className={inputClass} type="number" required min={min} max={max} step={stepSize} value={value} onChange={e => change(Number(e.target.value))} />;
  const note = (children: React.ReactNode) => <p className="border-l-2 border-brand bg-surface-subtle/50 pl-3 py-2 pr-2 text-xs leading-relaxed text-txt-secondary">{children}</p>;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/50 p-3 sm:p-6 flex items-center justify-center" onMouseDown={e => { if (e.target === e.currentTarget) dismiss.current(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-3xl max-h-[calc(100dvh-24px)] flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-canvas shadow-2xl text-txt-primary">
        <header className="flex items-start justify-between gap-4 p-5 sm:px-7 border-b border-border-subtle">
          <div><h2 id={titleId} ref={heading} tabIndex={-1} className="text-xl font-semibold tracking-tight focus:outline-none">New service</h2><p className="mt-1 text-xs text-txt-secondary">A guided setup in {space}. No repository required.</p></div>
          <button type="button" aria-label="Close setup" disabled={busy} className={buttonClass} onClick={() => dismiss.current()}><X className="w-4 h-4" /></button>
        </header>
        <ol aria-label="Setup progress" className="flex gap-4 sm:gap-8 px-5 sm:px-7 py-4 border-b border-border-subtle bg-surface-subtle/30">
          {['Source', 'Configure', 'Review'].map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} className={`flex items-center gap-2 text-xs ${index === step ? 'text-txt-brand font-semibold' : 'text-txt-tertiary'}`}><span className={`w-6 h-6 flex items-center justify-center rounded-full border font-mono text-[10px] ${index === step ? 'border-brand bg-brand text-white' : 'border-border-subtle'}`}>{index + 1}</span>{label}</li>)}
        </ol>
        <form onSubmit={submit} className="flex flex-col min-h-0">
          <div ref={scrollBody} className="overflow-y-auto p-5 sm:p-7 space-y-5">
            {step === 0 && <>
              <div><h3 className="text-base font-semibold">What would you like to run?</h3><p className="text-xs text-txt-secondary mt-1">Bring source code, a container, or start with a guided preset.</p></div>
              <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2"><legend className="sr-only">Service source</legend>
                {([
                  ['git', 'External Git', 'Build an HTTPS repository.', GitBranch], ['image', 'Container image', 'Run an image and tag directly.', Box],
                  ['llama', 'llama.cpp', 'Git build with a read-only host model.', Cpu], ['postgres', 'PostgreSQL', 'Internal database with retained storage.', Database],
                ] as const).map(([key, label, description, Icon]) => <label key={key} className={`flex items-start gap-3 p-4 border rounded-md ${preset === key ? 'border-brand bg-brand/5' : 'border-border-subtle'} ${key === 'llama' && !mountsAllowed ? 'opacity-50' : 'cursor-pointer'}`}>
                  <input type="radio" name="service-source" value={key} checked={preset === key} disabled={key === 'llama' && !mountsAllowed} onChange={() => choose(key)} className="mt-1 accent-brand" />
                  <span className="min-w-0"><span className="flex items-center gap-2 text-sm font-medium"><Icon className="w-4 h-4" />{label}</span><span className="block mt-1 text-xs text-txt-secondary">{description}</span></span>
                </label>)}
              </fieldset>
              {!mountsAllowed && note('Host model setup is disabled: instance-admin permission and an approved bind prefix are required. Ask the operator, or use generic Git / image setup without host mounts.')}
              {isGit && <>
                {field('Git repository URL', text(gitUrl, setGitUrl, { type: 'url', required: true, placeholder: 'https://github.com/owner/project' }), capabilities?.git_hosts.length ? `Allowed Git hosts: ${capabilities.git_hosts.join(', ')}` : 'The operator controls allowed Git hosts.')}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {field('Deploy from', <select className={inputClass} value={refType} onChange={e => setRefType(e.target.value)}><option value="branch">Branch / full Git ref</option><option value="pr">GitHub pull request</option></select>)}
                  {refType === 'pr' ? field('Pull request number', text(pr, setPr, { type: 'number', required: true, min: 1, step: 1 }), 'Uses refs/pull/NUMBER/head.') : field('Branch or full ref', text(branch, setBranch, { required: true, pattern: '[^\\s]+' }))}
                </div>
                {note('Source and reference are validated during the build. No commit has been resolved yet. Dockerfile, build context and target are explicitly editable next.')}
              </>}
              {preset === 'image' && field('Container image and tag', text(image, setImage, { required: true, placeholder: 'nginx:1.27' }), 'An image reference or digest. No Git repository will be created or requested.')}
              {isPostgres && note('PostgreSQL uses internal TCP 5432, a managed volume at /var/lib/postgresql/data, and stop/start releases. A password is generated and encrypted by the server, never in this form.')}
            </>}
            {step === 1 && <>
              <h3 className="text-base font-semibold">Give it a place to run.</h3>
              {field('Service name', text(name, setName, { required: true, pattern: '[a-z0-9](?:[a-z0-9\\-]{0,38}[a-z0-9])?', maxLength: 40 }), `Unique in ${space}. Lowercase letters, numbers and hyphens; no trailing hyphen.`)}
              {isPostgres ? <>
                {field('PostgreSQL version', <select className={inputClass} value={version} onChange={e => setVersion(e.target.value)}><option value="17">PostgreSQL 17</option><option value="16">PostgreSQL 16</option></select>)}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{field('Database name', text(database, setDatabase, { required: true, pattern: '[a-z_][a-z0-9_]{0,39}' }))}{field('Database user', text(username, setUsername, { required: true, pattern: '[a-z_][a-z0-9_]{0,39}' }))}</div>
                {note('Password: generated securely on the server. Reveal or copy the connection only after creation with write permission. No preview credential exists.')}
              </> : <>
                {isLlama && <>
                  {field('Compute', <select className={inputClass} value={gpu ? 'gpu' : 'cpu'} onChange={e => { const enabled = e.target.value === 'gpu'; setGpu(enabled); setDockerfile(enabled ? '.devops/cuda.Dockerfile' : '.devops/cpu.Dockerfile'); }}><option value="cpu">CPU</option><option value="gpu" disabled={!capabilities?.gpus}>NVIDIA GPU (operator permission required)</option></select>, 'GPU mode requires an NVIDIA GPU and NVIDIA Container Toolkit on the deployment host. Hardware is not detected or verified.')}
                  {field('Host GGUF file path', text(model, setModel, { required: true, placeholder: '/srv/models/model.gguf', disabled: !mountsAllowed }), `Deployment-host path, not your browser filesystem. Approved prefixes: ${capabilities?.bind_allowlist.join(', ') || 'none'}`)}
                  {model && <code className="block break-all bg-surface-base border border-border-subtle p-3 text-xs">{model.trim()}:/models/model.gguf:ro</code>}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{field('Server entrypoint', text(entrypoint, setEntrypoint, { required: true }))}{field('Context size', number(context, setContext, 1, 1048576))}</div>
                </>}
                {isGit && <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {field('Build context', text(root, setRoot, { required: true }), 'Repository-relative directory.')}
                  {field('Dockerfile path', text(dockerfile, setDockerfile, { required: true }), 'Relative to the build context.')}
                  {field('Build target (optional)', text(target, setTarget), 'Docker multi-stage target, for example server.')}
                </div>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {field('Container port', number(port, setPort, 1, 65535))}
                  {field('Network access', <select className={inputClass} value={exposure} onChange={e => setExposure(e.target.value as typeof exposure)}><option value="internal">Internal network</option><option value="http">HTTP routing</option></select>)}
                  {!isLlama && field('Health check', <select className={inputClass} value={healthType} onChange={e => setHealthType(e.target.value as typeof healthType)}><option value="http">HTTP</option><option value="tcp">TCP</option></select>)}
                  {(isLlama || healthType === 'http') && field('Health path', text(healthPath, setHealthPath, { required: true, pattern: '/.*' }))}
                  {field('Startup health timeout (ms)', number(healthTimeout, setHealthTimeout, 1000, 600000))}
                </div>
                {field(isLlama ? 'Additional server arguments (JSON array)' : 'Command override (JSON array, optional)', <textarea className={`${inputClass} font-mono text-xs`} rows={3} value={command} onChange={e => setCommand(e.target.value)} placeholder={'["--verbose"]'} />, isLlama ? 'Model, host, port, context and GPU-layer arguments are supplied by this setup.' : 'Leave blank to use the image command. Arguments are not interpreted by a shell.')}
                {!isLlama && <>
                  {field('Persistent volume mount (optional)', text(volume, setVolume, { placeholder: '/data', pattern: '/.*' }), 'A Docker-managed local volume. Setting a mount uses stop/start releases to avoid concurrent writers.')}
                </>}
                {field('Environment variables (optional)', <textarea autoComplete="off" spellCheck={false} className={`${inputClass} font-mono text-xs`} rows={3} value={envText} onChange={e => setEnvText(e.target.value)} placeholder="KEY=value" />, 'Stored encrypted. The review shows names only, not secret values.')}
              </>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{field('CPU cores (limit)', number(cpu, setCpu, 0.1, 64, 0.1))}{field('Memory MB (limit)', number(memory, setMemory, 32, 262144))}</div>
              {note('All standalone services use stop/start (recreate) releases. The old container stops before the new one starts, so releases briefly interrupt service.')}
              {isLlama && note('8192 MB is a starting limit, not a model-size guarantee. Allow memory for model weights, context and runtime overhead. Stop/start releases avoid running two model servers at once.')}
              {(isPostgres || volume) && note('Managed volumes consume host storage as data grows; no preallocated size or quota. Data remains after service deletion. No backup is configured. Retention is not a backup.')}
              {note('Internal access uses the shared approved apps network, not per-space isolation. Internal services have no public TCP proxy. Public HTTP may receive an automatic address under the instance base domain. Attached custom domains require ownership verification.')}
            </>}
            {step === 2 && review && <>
              <div><h3 className="text-base font-semibold">One last look.</h3><p className="mt-1 text-xs text-txt-secondary">Create the service, then request its first deployment.</p></div>
              <dl className="divide-y divide-border-subtle text-xs">
                {Object.entries(review).filter(([key]) => !['env', 'runtime_options'].includes(key)).map(([key, value]) => <div key={key} className="flex flex-wrap justify-between gap-2 py-2.5"><dt className="text-txt-secondary">{key.replace(/_/g, ' ')}</dt><dd className="font-mono break-all">{value === null ? 'None' : String(value)}</dd></div>)}
                {isPostgres && <><div className="py-2.5">Internal TCP 5432 / stop then start / retain volume</div><div className="py-2.5 font-mono">/var/lib/postgresql/data</div><div className="py-2.5">Password generated and encrypted by server. Backups not configured.</div></>}
                {review.env && <div className="py-2.5"><dt className="text-txt-secondary">Environment names (values hidden)</dt><dd className="font-mono break-all mt-1">{Object.keys(review.env).join(', ') || 'None'}</dd></div>}
              </dl>
              {review.runtime_options && <div><h4 className="text-xs text-txt-secondary mb-2">Runtime and mounts</h4><pre className="whitespace-pre-wrap break-all border border-border-subtle rounded-md p-3 bg-surface-base font-mono text-xs">{JSON.stringify(review.runtime_options, null, 2)}</pre></div>}
              {isGit && note('Git ref and Dockerfile will be checked during the build. The resolved commit will appear in deployment history, not before the build.')}
              {note('This runs on the deployment host. Internal networking is shared, not isolated by space. Retained storage is not backed up automatically.')}
            </>}
            {error && <p role="alert" className="text-xs whitespace-pre-wrap text-feedback-error-text border-l-2 border-feedback-error-border pl-3">{error}</p>}
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-7 border-t border-border-subtle">
            <span className="text-[11px] text-txt-tertiary">{busy ? (created ? 'Requesting deployment...' : 'Creating service...') : 'Your host. Explicit configuration.'}</span>
            <div className="flex flex-wrap gap-2">
              {created ? <button type="button" className={buttonClass} disabled={busy} onClick={() => onComplete(created)}>Open created service</button> : <button type="button" className={buttonClass} disabled={busy} onClick={() => { setError(''); if (step === 0) onClose(); else setStep(step - 1); }}>{step === 0 ? 'Cancel' : 'Back'}</button>}
              <button type="submit" disabled={busy || (isLlama && !mountsAllowed)} className={`${buttonClass} !bg-brand !text-white !border-brand hover:!bg-brand-hover`}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}{step < 2 ? 'Continue' : created ? 'Retry deployment' : 'Create and deploy'}</button>
            </div>
          </footer>
        </form>
      </div>
    </div>, document.body,
  );
}
