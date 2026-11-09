'use strict';

const CONFIG_ERROR = () => Object.assign(new Error('Invalid presence configuration.'), { code: 'PRESENCE_CONFIG' });
const defaults = {
  enabled: false, locations: [], pollIntervalSeconds: 300,
  maxLocationAgeSeconds: 600, confirmationSamples: 2, exposeSwitch: false,
};
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const integer = (value, min, max) => Number.isInteger(value) && finite(value, min, max);

function normalizePresenceConfig(config) {
  if (config === undefined || config === null) return { ...defaults, locations: [] };
  if (typeof config !== 'object' || Array.isArray(config)
      || (config.enabled !== undefined && typeof config.enabled !== 'boolean')) throw CONFIG_ERROR();
  if (config.enabled !== true) return { ...defaults, locations: [] };
  const result = { ...defaults, ...config, enabled: true };
  if (!integer(result.pollIntervalSeconds, 60, 86400)
      || !integer(result.maxLocationAgeSeconds, 60, 86400)
      || result.maxLocationAgeSeconds < result.pollIntervalSeconds
      || !integer(result.confirmationSamples, 1, 5)
      || typeof result.exposeSwitch !== 'boolean'
      || !Array.isArray(result.locations) || result.locations.length < 1 || result.locations.length > 20) throw CONFIG_ERROR();
  const ids = new Set();
  const locations = result.locations.map((location) => {
    if (!location || typeof location !== 'object' || Array.isArray(location)) throw CONFIG_ERROR();
    const { id, latitude, longitude } = location;
    const name = location.name === undefined ? id : location.name;
    const arrivalRadiusMeters = location.arrivalRadiusMeters ?? 150;
    const departureRadiusMeters = location.departureRadiusMeters ?? 250;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(id) || ids.has(id)
        || typeof name !== 'string' || !name.trim() || name.trim().length > 48
        || !finite(latitude, -90, 90) || !finite(longitude, -180, 180)
        || !integer(arrivalRadiusMeters, 1, 100000) || !integer(departureRadiusMeters, 1, 100000)
        || departureRadiusMeters <= arrivalRadiusMeters) throw CONFIG_ERROR();
    ids.add(id);
    return { id, name: name.trim(), latitude, longitude, arrivalRadiusMeters, departureRadiusMeters };
  });
  return {
    enabled: true, locations, pollIntervalSeconds: result.pollIntervalSeconds,
    maxLocationAgeSeconds: result.maxLocationAgeSeconds,
    confirmationSamples: result.confirmationSamples, exposeSwitch: result.exposeSwitch,
  };
}

// Haversine remains well behaved across the antimeridian and at the poles.
function distanceMeters(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat = radians(b.latitude - a.latitude);
  const lon = radians(b.longitude - a.longitude);
  const value = Math.sin(lat / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(lon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
}

class PresenceMonitor {
  constructor({ config, readLocation, onUpdate = () => {}, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.config = normalizePresenceConfig(config);
    if (this.config.enabled && typeof readLocation !== 'function') throw CONFIG_ERROR();
    this.readLocation = readLocation;
    this.onUpdate = onUpdate;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.running = false;
    this.closed = false;
    this.reading = false;
    this.failures = 0;
    this.lastObservedAt = null;
    this.states = new Map(this.config.locations.map(({ id }) => [id, {
      id, present: null, available: false, observedAt: null,
      candidate: null, confirmations: 0, needsBaseline: true,
    }]));
  }

  getState(id) {
    // A delayed event loop or clock jump must not let a HomeKit read report
    // stale data while the expiry callback is still waiting to run.
    if (this.lastObservedAt !== null
        && this.now() - this.lastObservedAt >= this.config.maxLocationAgeSeconds * 1000) this.markUnavailable();
    const state = this.states.get(id);
    return state ? this.snapshot(state) : undefined;
  }

  snapshot(state, changed = false, baseline = false) {
    return { id: state.id, present: state.present, available: state.available,
      changed, baseline, observedAt: state.observedAt };
  }

  notify(state, changed = false, baseline = false) {
    try {
      // A consumer's logging/UI callback must not break polling or produce an
      // unhandled rejection, including when it happens to be async.
      Promise.resolve(this.onUpdate(this.snapshot(state, changed, baseline))).catch(() => {});
    } catch { /* Consumer callbacks do not control the telemetry state machine. */ }
  }

  clear(name) {
    const handle = this[name];
    this[name] = undefined;
    if (handle !== undefined) {
      try { this.clearTimer(handle); } catch { /* Closed/generation checks also invalidate callbacks. */ }
    }
  }

  schedule(name, callback, delay) {
    this.clear(name);
    if (!this.running || this.closed) return;
    try {
      const handle = this.setTimer(() => {
        if (!this.running || this.closed || this[name] !== handle) return;
        this[name] = undefined;
        callback();
      }, Math.max(0, delay));
      this[name] = handle;
      handle?.unref?.();
    } catch {
      // If timers cannot be installed, fail closed instead of displaying a
      // fresh state forever or throwing through a Homebridge event handler.
      this.running = false;
      this.clear('pollTimer');
      this.clear('expiryTimer');
      this.markUnavailable();
    }
  }

  start() {
    if (this.closed || this.running || !this.config.enabled) return;
    this.running = true;
    void this.poll();
  }

  markUnavailable() {
    for (const state of this.states.values()) {
      const wasAvailable = state.available;
      state.available = false;
      state.candidate = null;
      state.confirmations = 0;
      state.needsBaseline = true;
      if (wasAvailable) this.notify(state);
    }
  }

  expire() {
    if (this.lastObservedAt === null) return;
    const remaining = this.lastObservedAt + this.config.maxLocationAgeSeconds * 1000 - this.now();
    if (remaining <= 0) this.markUnavailable();
    else this.schedule('expiryTimer', () => this.expire(), remaining);
  }

  accept(sample) {
    const now = this.now();
    const ageLimit = this.config.maxLocationAgeSeconds * 1000;
    if (!sample || !finite(sample.latitude, -90, 90) || !finite(sample.longitude, -180, 180)
        || !finite(sample.observedAt, 0, now)
        || now - sample.observedAt >= ageLimit
        || (sample.accuracyMeters !== undefined && !finite(sample.accuracyMeters, 0, 100000))) {
      throw Object.assign(new Error('Location unavailable.'), { code: 'LOCATION_UNAVAILABLE' });
    }
    // Cached/reordered responses never count as an additional observation and
    // never extend the freshness deadline of a confirmed vehicle position.
    if (this.lastObservedAt !== null && sample.observedAt <= this.lastObservedAt) return;
    this.lastObservedAt = sample.observedAt;
    for (const location of this.config.locations) {
      const state = this.states.get(location.id);
      const distance = distanceMeters(location, sample);
      const uncertainty = sample.accuracyMeters ?? 0;
      const target = distance + uncertainty <= location.arrivalRadiusMeters ? true
        : Math.max(0, distance - uncertainty) >= location.departureRadiusMeters ? false : null;
      state.observedAt = sample.observedAt;
      let changed = false;
      let baseline = false;
      if (target === null || (!state.needsBaseline && target === state.present)) {
        state.candidate = null;
        state.confirmations = 0;
      } else {
        state.confirmations = target === state.candidate ? state.confirmations + 1 : 1;
        state.candidate = target;
        if (state.confirmations >= this.config.confirmationSamples) {
          baseline = state.needsBaseline;
          changed = !baseline && state.present !== target;
          state.present = target;
          state.available = true;
          state.needsBaseline = false;
          state.candidate = null;
          state.confirmations = 0;
        }
      }
      this.notify(state, changed, baseline);
    }
    this.schedule('expiryTimer', () => this.expire(), sample.observedAt + ageLimit - now);
  }

  async poll() {
    if (!this.running || this.closed || this.reading) return;
    this.reading = true;
    try {
      const sample = await this.readLocation();
      if (!this.running || this.closed) return;
      this.accept(sample);
      this.failures = 0;
    } catch (error) {
      if (!this.running || this.closed) return;
      if (error?.code === 'BUSY') {
        this.failures = 0;
      } else if (error?.code === 'LOCATION_UNAVAILABLE') {
        // Parked vehicles may retain an old GPS fix despite a successful
        // request. Keep looking at the configured cadence so the next drive
        // does not inherit an hours-long transport-failure backoff.
        this.failures = 0;
        this.markUnavailable();
      } else {
        this.failures = Math.min(this.failures + 1, 16);
        this.markUnavailable();
      }
    } finally {
      this.reading = false;
      if (this.running && !this.closed) {
        const base = this.config.pollIntervalSeconds * 1000;
        const delay = Math.min(base * 2 ** this.failures, Math.max(base, 3600000));
        this.schedule('pollTimer', () => { void this.poll(); }, delay);
      }
    }
  }

  shutdown() {
    this.closed = true;
    this.running = false;
    this.clear('pollTimer');
    this.clear('expiryTimer');
    // No shutdown notification: stopping the process is not a departure.
    for (const state of this.states.values()) state.available = false;
  }
}

module.exports = { normalizePresenceConfig, PresenceMonitor, distanceMeters };
