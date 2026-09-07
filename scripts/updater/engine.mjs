// Deliberately independent of core, PostgreSQL, and third-party dependencies.
export async function executeUpdate(driver, job, save) {
  let context;
  let outcome = 'failed';
  const step = async (name, action) => {
    const item = { name, status: 'running', startedAt: Date.now() };
    job.steps.push(item);
    await save();
    try {
      const result = await action();
      Object.assign(item, { status: 'passed', finishedAt: Date.now() });
      await save();
      return result;
    } catch (error) {
      Object.assign(item, { status: 'failed', finishedAt: Date.now(), message: error.message });
      throw error;
    }
  };
  job.database = 'unchanged';
  try {
    context = await step('Recheck approved revision and configuration', () => driver.preflight(job.plan));
    await step('Build candidate images and test the UI', () => driver.build(context));
    await step('Back up the database for rehearsal', () => driver.backup(context, 'rehearsal'));
    await step('Restore backup and rehearse migrations', () => driver.rehearse(context));
    await step('Recheck activity and pause core / SSH', async () => {
      await driver.guard(context);
      // Persist BEFORE any stop; a partial stop also needs recovery.
      job.quiesced = true;
      await save();
      await driver.stop(context);
    });
    await step('Take and verify the final database backup', async () => {
      job.backup = await driver.backup(context, 'final');
      await save();
    });
    await step('Apply production migrations', async () => {
      // A worker crash or a lost COMMIT response must never trigger blind rollback.
      job.database = 'uncertain';
      await save();
      try {
        job.migrations = await driver.migrate(context);
        job.database = 'committed';
      } catch (error) {
        if (error.rollbackConfirmed === true) job.database = 'unchanged';
        throw error;
      } finally { await save(); }
    });
    await step('Start the candidate backend', () => driver.activate(context));
    await step('Verify revision, database, and health', () => driver.health(context));
    await step('Publish the UI and fast-forward the checkout', () => driver.publish(context));
    outcome = 'succeeded';
    job.message = 'Update completed. Backend, database migrations, and UI revision verified.';
  } catch (error) {
    job.message = error.message;
    outcome = 'failed';
    if (job.quiesced) {
      if (job.database === 'unchanged') {
        try {
          await step('Restore the previous services', () => driver.resumeOld(context));
          job.message += ' Previous services restored; database unchanged.';
        } catch {
          outcome = 'recovery_required';
          job.message += ' Previous services could not be restored. Operator recovery is required.';
        }
      } else {
        outcome = 'recovery_required';
        try { await driver.stop(context); }
        catch { job.message += ' Some services could not be stopped; inspect Docker on the host.'; }
        job.message += ' Database changes committed or are uncertain. Automatic rollback is blocked. Use the saved backup and recovery guide.';
      }
    }
  } finally {
    if (context) {
      try { await driver.cleanup(context, { ...job, status: outcome }); }
      catch { job.cleanupWarning = 'Temporary resources remain; see the private worker log.'; }
    }
    job.finishedAt = Date.now();
    // Observers must keep polling until recovery and cleanup have actually
    // settled, not stop when the first failure is detected.
    job.status = outcome;
    await save();
  }
}

export function recoverInterrupted(job) {
  if (!job || !['checking', 'running'].includes(job.status)) return job;
  return { ...job, status: 'recovery_required', finishedAt: Date.now(),
    message: 'Updater restarted during an operation. No commands were replayed. Inspect services, the saved backup, and the private log before enabling another update.' };
}
