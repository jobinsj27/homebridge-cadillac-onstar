'use strict';

const SESSION_MS = 15 * 60 * 1000;
const failure = (code) => Object.assign(new Error(code), { code });

// A resolved promise alone is not success: OnStarJS also resolves unknown shapes.
function isComplete(result) {
  const data = result?.response?.data;
  const response = data?.commandResponse ?? data;
  return result?.status === 'success'
    && typeof response?.status === 'string'
    && ['success', 'complete', 'completed'].includes(response.status.toLowerCase())
    && !result?.error && !data?.error && !response?.error && !response?.body?.error;
}

class VehicleController {
  constructor({ createClient, now = Date.now, setTimer = setTimeout,
    clearTimer = clearTimeout, onChange = () => {}, lockStateTtlMs = 60000 } = {}) {
    this.createClient = createClient;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onChange = onChange;
    this.lockStateTtlMs = lockStateTtlMs;
    this.start = null;
    this.locked = null;
    this.busy = false;
    this.closed = false;
  }

  getStart() {
    if (this.closed) return null;
    if (this.start === true && this.now() >= this.startExpiresAt) this.start = false;
    return this.start;
  }

  getLocked() {
    if (this.closed) return null;
    if (this.locked !== null && this.now() >= this.lockExpiresAt) this.locked = null;
    return this.locked;
  }

  async setStart(value) {
    if (typeof value !== 'boolean') throw failure('INVALID_VALUE');
    if (this.closed) throw failure('CLOSED');
    if (this.busy) throw failure('BUSY');
    // Repeated HomeKit writes must not extend an existing remote-start session.
    if (value && this.getStart() === true) return;
    await this.command(value ? 'start' : 'cancelStart', 'start', value);
  }

  async setLocked(value) {
    if (typeof value !== 'boolean') throw failure('INVALID_VALUE');
    // Always resend explicit door requests: a key fob may have changed the car.
    await this.command(value ? 'lockDoor' : 'unlockDoor', 'locked', value);
  }

  async setAlert(value) {
    if (typeof value !== 'boolean') throw failure('INVALID_VALUE');
    // These are explicit momentary requests, never an assumed horn/light state.
    await this.command(value ? 'alert' : 'cancelAlert');
  }

  async ensureClient() {
    if (!this.client || this.client.closed === true) {
      // Wait for a failed worker to stop before another can refresh the same
      // private session files. Only a new explicit operation reaches this path.
      if (this.client?.closed === true) await this.client.shutdown?.();
      if (this.closed) throw failure('CLOSED');
      try { this.client = await this.createClient(); }
      catch { throw failure('CREDENTIALS'); }
    }
    if (this.closed) { this.client?.shutdown?.(); throw failure('CLOSED'); }
    return this.client;
  }

  async getLocation() {
    if (this.closed) throw failure('CLOSED');
    if (this.busy) throw failure('BUSY');
    this.busy = true;
    try {
      const client = await this.ensureClient();
      // The worker validates and minimizes telemetry. It is not a command-status
      // response, and reading it must not modify local engine/lock confirmations.
      const sample = await client.location();
      if (this.closed) throw failure('CLOSED');
      return sample;
    } catch (error) {
      if (this.closed) throw failure('CLOSED');
      throw failure(['CREDENTIALS', 'CLOSED', 'LOCATION_UNAVAILABLE', 'LOCATION_PENDING'].includes(error?.code) ? error.code : 'LOCATION_FAILED');
    } finally {
      this.busy = false;
    }
  }

  async command(method, property, value) {
    if (this.closed) throw failure('CLOSED');
    if (this.busy) throw failure('BUSY');
    this.busy = true;
    const tracksState = property === 'start' || property === 'locked';
    if (tracksState) {
      this.clearTimer(this[property + 'Timer']);
      this[property] = null;
    }
    this.onChange();
    try {
      const client = await this.ensureClient();
      const result = await client[method]();
      if (!isComplete(result)) throw failure('COMMAND_FAILED');
      if (this.closed) throw failure('CLOSED');
      if (tracksState) this[property] = value;
      if (property === 'start' && value) {
        this.startExpiresAt = this.now() + SESSION_MS;
        this.startTimer = this.setTimer(() => {
          if (this.closed) return;
          this.start = false;
          this.onChange(); // Local session expiry only; the vehicle enforces its own timeout.
        }, SESSION_MS);
        this.startTimer?.unref?.();
      } else if (property === 'locked') {
        this.lockExpiresAt = this.now() + this.lockStateTtlMs;
        this.lockedTimer = this.setTimer(() => {
          if (this.closed) return;
          this.locked = null;
          this.onChange();
        }, this.lockStateTtlMs);
        this.lockedTimer?.unref?.();
      }
    } catch (error) {
      if (tracksState) this[property] = null;
      // Never expose library errors: they may contain account data or tokens.
      throw failure(['CREDENTIALS', 'CLOSED'].includes(error?.code)
        ? error.code : 'COMMAND_FAILED');
    } finally {
      this.busy = false;
      if (!this.closed) this.onChange();
    }
  }

  shutdown() {
    this.closed = true;
    this.clearTimer(this.startTimer);
    this.clearTimer(this.lockedTimer);
    this.start = this.locked = null;
    this.client?.shutdown?.();
  }
}

module.exports = { VehicleController, isComplete, SESSION_MS, failure };
