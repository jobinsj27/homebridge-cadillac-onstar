'use strict';

const path = require('node:path');
const { VehicleController } = require('./lib/controller');
const { createClient } = require('./lib/client');
const { normalizePresenceConfig, PresenceMonitor } = require('./lib/presence');
const PLUGIN = 'homebridge-cadillac-onstar';
const LEGACY_UUID_PREFIX = 'homebridge-escalade-onstar';
const PLATFORM = 'CadillacOnStar';
const CONTROL_DEFAULTS = Object.freeze({ start: true, stop: true, lock: true, unlock: true, findCar: false });

function normalizeControls(value) {
  if (value === undefined) return { ...CONTROL_DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !Object.hasOwn(CONTROL_DEFAULTS, key) || typeof value[key] !== 'boolean')) {
    throw new Error('INVALID_CONTROLS');
  }
  return { ...CONTROL_DEFAULTS, ...value };
}

class CadillacPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.resetHandles = new Set();
    this.presenceAccessories = new Map();
    this.closed = false;
    this.vehicleName = typeof this.config.vehicleName === 'string' && this.config.vehicleName.trim()
      ? this.config.vehicleName.trim() : 'Cadillac';
    this.model = typeof this.config.model === 'string' && this.config.model.trim()
      ? this.config.model.trim() : 'OnStar Vehicle';
    this.uuidPrefix = this.config.accessoryUuidPrefix ?? PLUGIN;
    if (typeof this.config.credentialsFile !== 'string' || !path.isAbsolute(this.config.credentialsFile)) {
      this.log.warn('Cadillac OnStar is inactive. Set credentialsFile to an absolute path to a private mode 0600 JSON file, then restart Homebridge.');
      return;
    }
    if (![PLUGIN, LEGACY_UUID_PREFIX].includes(this.uuidPrefix)) {
      this.log.warn('Cadillac OnStar is inactive. accessoryUuidPrefix must use the current or documented legacy namespace.');
      return;
    }
    const storagePath = api.user?.storagePath?.();
    this.browserPath = this.config.browserPath || (typeof storagePath === 'string' && path.isAbsolute(storagePath)
      ? path.join(storagePath, '.cache', PLUGIN, 'browsers')
      : path.join(path.dirname(this.config.credentialsFile), '.cache', 'browsers'));
    if (typeof this.browserPath !== 'string' || !path.isAbsolute(this.browserPath)) {
      this.log.warn('Cadillac OnStar is inactive. browserPath must be an absolute directory path.');
      return;
    }
    try {
      this.controls = normalizeControls(this.config.controls);
      this.presenceConfig = normalizePresenceConfig(this.config.presence);
    } catch {
      this.log.warn('Cadillac OnStar is inactive. Check control toggles and presence settings. Existing accessories were not removed.');
      return;
    }
    this.controller = new VehicleController({
      createClient: () => createClient(this.config.credentialsFile, this.browserPath),
    });
    api.on('didFinishLaunching', () => this.register());
    api.on('shutdown', () => {
      this.closed = true;
      for (const handle of this.resetHandles) clearImmediate(handle);
      this.resetHandles.clear();
      this.presenceMonitor?.shutdown();
      this.controller.shutdown();
    });
  }

  configureAccessory(accessory) { this.cached.set(accessory.UUID, accessory); }

  async set(service, action) {
    try { await action(); }
    catch (error) {
      this.log.warn(error?.code === 'BUSY'
        ? 'Another vehicle command is still running.'
        : 'OnStar command could not be confirmed. Check private credentials and the myCadillac app.');
      throw new this.api.hap.HapStatusError(error?.code === 'BUSY'
        ? this.api.hap.HAPStatus.RESOURCE_BUSY : this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      this.resetSwitch(service);
    }
  }

  resetSwitch(service) {
    if (this.closed) return;
    // HAP applies the requested value after onSet resolves. Reset afterwards,
    // without calling the setter or claiming any current vehicle state.
    const handle = setImmediate(() => {
      this.resetHandles.delete(handle);
      if (!this.closed) service.updateCharacteristic(this.api.hap.Characteristic.On, false);
    });
    this.resetHandles.add(handle);
    handle.unref?.();
  }

  register() {
    if (!this.controller || this.closed || this.registered) return;
    this.registered = true;
    const { Service, Characteristic: C, uuid } = this.api.hap;
    const wanted = new Set();
    const obsoleteId = uuid.generate(`${this.uuidPrefix}:doors`);
    const obsolete = this.cached.get(obsoleteId);
    if (obsolete) {
      this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [obsolete]);
      this.cached.delete(obsoleteId);
    }
    for (const [key, suffix, enabled, action] of [
      ['start', 'Start', this.controls.start, () => this.controller.setStart(true)],
      ['stop', 'Stop', this.controls.stop, () => this.controller.setStart(false)],
      ['lock', 'Lock', this.controls.lock, () => this.controller.setLocked(true)],
      ['unlock', 'Unlock', this.controls.unlock, () => this.controller.setLocked(false)],
      ['findCar', 'Find Car', this.controls.findCar, () => this.controller.setAlert(true)],
      ['stopAlert', 'Stop Alert', this.controls.findCar, () => this.controller.setAlert(false)],
    ]) {
      // This singular platform's IDs survive display-name or credential changes.
      const name = `${this.vehicleName} ${suffix}`;
      const id = uuid.generate(`${this.uuidPrefix}:${key}`);
      if (!enabled) {
        this.removeCached(id);
        continue;
      }
      wanted.add(id);
      const accessory = this.cached.get(id) || new this.api.platformAccessory(name, id);
      accessory.displayName = name;
      accessory.context = { kind: key }; // Never cache credentials or vehicle state.
      accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(C.Manufacturer, 'Cadillac')
        .setCharacteristic(C.Model, this.model)
        .setCharacteristic(C.SerialNumber, id);
      const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, name);
      service.setCharacteristic(C.Name, name);
      this[`${key}Service`] = service;
      service.getCharacteristic(C.On)
        .onGet(() => false)
        .onSet((value) => value === true ? this.set(service, action) : undefined);
      service.updateCharacteristic(C.On, false); // Clear cached values before publishing.
      if (this.cached.has(id)) this.api.updatePlatformAccessories([accessory]);
      else this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
      this.cached.set(id, accessory);
    }
    if (this.presenceConfig.enabled) {
      this.presenceMonitor = new PresenceMonitor({
        config: this.presenceConfig,
        readLocation: () => this.controller.getLocation(),
        onUpdate: snapshot => this.updatePresence(snapshot),
      });
      for (const place of this.presenceConfig.locations) {
        const sensors = [];
        for (const mirror of this.presenceConfig.exposeSwitch ? [false, true] : [false]) {
          const kind = mirror ? 'presence-switch' : 'presence';
          const id = uuid.generate(`${this.uuidPrefix}:${kind}:${place.id}`);
          wanted.add(id);
          const name = `${this.vehicleName} at ${place.name}${mirror ? ' Switch' : ''}`;
          const accessory = this.cached.get(id) || new this.api.platformAccessory(name, id);
          accessory.displayName = name;
          accessory.context = { kind, placeId: place.id };
          accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(C.Manufacturer, 'Cadillac')
            .setCharacteristic(C.Model, this.model)
            .setCharacteristic(C.SerialNumber, id);
          const type = mirror ? Service.Switch : Service.OccupancySensor;
          const service = accessory.getService(type) || accessory.addService(type, name);
          service.setCharacteristic(C.Name, name);
          const characteristicType = mirror ? C.On : C.OccupancyDetected;
          const characteristic = service.getCharacteristic(characteristicType);
          characteristic.onGet(() => {
            const state = this.presenceMonitor.getState(place.id);
            if (!state?.available || typeof state.present !== 'boolean') {
              throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
            return mirror ? state.present : Number(state.present);
          });
          if (mirror) {
            characteristic.onSet(() => {
              // A Home tile must never impersonate a GPS reading.
              throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
            });
          } else {
            service.setCharacteristic(C.StatusActive, false);
            service.setCharacteristic(C.StatusFault, C.StatusFault.GENERAL_FAULT ?? 1);
          }
          sensors.push({ service, characteristic, characteristicType, mirror });
          if (this.cached.has(id)) this.api.updatePlatformAccessories([accessory]);
          else this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
          this.cached.set(id, accessory);
        }
        this.presenceAccessories.set(place.id, sensors);
      }
    }
    // Only exact IDs paired with our own presence context are eligible for removal.
    // A different platform or malformed cache entry must never be claimed here.
    for (const [id, accessory] of this.cached) {
      const { kind, placeId } = accessory.context || {};
      if (['presence', 'presence-switch'].includes(kind) && typeof placeId === 'string'
          && id === uuid.generate(`${this.uuidPrefix}:${kind}:${placeId}`) && !wanted.has(id)) {
        this.removeCached(id);
      }
    }
    this.presenceMonitor?.start();
  }

  removeCached(id) {
    const accessory = this.cached.get(id);
    if (!accessory) return;
    this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    this.cached.delete(id);
  }

  updatePresence(snapshot) {
    if (this.closed) return;
    const { Characteristic: C } = this.api.hap;
    for (const { service, characteristic, characteristicType, mirror } of this.presenceAccessories.get(snapshot.id) || []) {
      if (!mirror) {
        service.updateCharacteristic(C.StatusActive, snapshot.available);
        service.updateCharacteristic(C.StatusFault, snapshot.available
          ? (C.StatusFault.NO_FAULT ?? 0) : (C.StatusFault.GENERAL_FAULT ?? 1));
      }
      if (!snapshot.available || typeof snapshot.present !== 'boolean') continue;
      const value = mirror ? snapshot.present : Number(snapshot.present);
      if (snapshot.changed && !snapshot.baseline) service.updateCharacteristic(characteristicType, value);
      else {
        // Establish/re-establish a baseline without emitting a synthetic crossing.
        // GETs see the baseline, but no arrival/departure event is published here.
        characteristic.value = value;
        // A previous failed GET leaves HAP's cached error set. updateValue()
        // would clear it but also emits a change event, even for equal values.
        characteristic.statusCode = this.api.hap.HAPStatus.SUCCESS ?? 0;
      }
    }
  }
}

module.exports = (api) => api.registerPlatform(PLUGIN, PLATFORM, CadillacPlatform);
module.exports.CadillacPlatform = CadillacPlatform;
module.exports.VehicleController = VehicleController;
