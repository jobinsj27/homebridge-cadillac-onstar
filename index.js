'use strict';

const path = require('node:path');
const { VehicleController } = require('./lib/controller');
const { createClient } = require('./lib/client');
const PLUGIN = 'homebridge-cadillac-onstar';
const LEGACY_UUID_PREFIX = 'homebridge-escalade-onstar';
const PLATFORM = 'CadillacOnStar';

class CadillacPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.resetHandles = new Set();
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
    this.controller = new VehicleController({
      createClient: () => createClient(this.config.credentialsFile, this.browserPath),
    });
    api.on('didFinishLaunching', () => this.register());
    api.on('shutdown', () => {
      this.closed = true;
      for (const handle of this.resetHandles) clearImmediate(handle);
      this.resetHandles.clear();
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
    if (!this.controller || this.closed) return;
    const { Service, Characteristic: C, uuid } = this.api.hap;
    const obsoleteId = uuid.generate(`${this.uuidPrefix}:doors`);
    const obsolete = this.cached.get(obsoleteId);
    if (obsolete) {
      this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [obsolete]);
      this.cached.delete(obsoleteId);
    }
    for (const [key, suffix, action] of [
      ['start', 'Start', () => this.controller.setStart(true)],
      ['stop', 'Stop', () => this.controller.setStart(false)],
      ['lock', 'Lock', () => this.controller.setLocked(true)],
      ['unlock', 'Unlock', () => this.controller.setLocked(false)],
    ]) {
      // This singular platform's IDs survive display-name or credential changes.
      const name = `${this.vehicleName} ${suffix}`;
      const id = uuid.generate(`${this.uuidPrefix}:${key}`);
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
  }
}

module.exports = (api) => api.registerPlatform(PLUGIN, PLATFORM, CadillacPlatform);
module.exports.CadillacPlatform = CadillacPlatform;
module.exports.VehicleController = VehicleController;
