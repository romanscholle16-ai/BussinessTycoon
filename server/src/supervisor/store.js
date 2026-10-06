// Supervisor persistence on the Phase 2 checkpoint table: run state + a single-instance lock. No new tables.
export class SupervisorStore {
  constructor(db, repos, clock) { this.db = db; this.repos = repos; this.clock = clock; }
  load() { return this.repos.checkpoints.load('supervisor', 'state')?.state ?? null; }
  save(state) { this.repos.checkpoints.save('supervisor', 'state', state, 'live'); }
  /**
   * Atomically takes the lock. Refused only while another instance holds it, its process run is still `running`,
   * and its lease has not expired. A lock left by a crashed/clean process run, or an expired lease, is taken over.
   */
  acquire(instanceId, processRunId, ttlMs) {
    return this.db.transaction(() => {
      const now = this.clock.now().getTime(), cur = this.repos.checkpoints.load('supervisor', 'lock')?.state;
      if (cur && cur.instanceId !== instanceId) {
        const run = this.db.get('SELECT status FROM process_runs WHERE id = ?', [cur.processRunId]);
        if (run?.status === 'running' && now - Date.parse(cur.renewedAt) < ttlMs) return { acquired: false, holder: cur.instanceId };
      }
      this.repos.checkpoints.save('supervisor', 'lock', { instanceId, processRunId, renewedAt: new Date(now).toISOString() }, 'live');
      return { acquired: true, tookOver: !!cur && cur.instanceId !== instanceId };
    });
  }
  renew(instanceId) {
    return this.db.transaction(() => {
      const cur = this.repos.checkpoints.load('supervisor', 'lock')?.state; if (!cur || cur.instanceId !== instanceId) return false;
      this.repos.checkpoints.save('supervisor', 'lock', { ...cur, renewedAt: this.clock.now().toISOString() }, 'live'); return true;
    });
  }
  release(instanceId) {
    this.db.transaction(() => { const cur = this.repos.checkpoints.load('supervisor', 'lock')?.state; if (cur?.instanceId === instanceId) this.repos.checkpoints.save('supervisor', 'lock', { instanceId: null, processRunId: null, renewedAt: this.clock.now().toISOString() }, 'live'); });
  }
}
