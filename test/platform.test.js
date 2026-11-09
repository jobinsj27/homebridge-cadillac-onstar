'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mock, test } = require('node:test');
const clientModule = require('../lib/client');

let clientCreations = 0;
const clientArguments = [];
const createClientMock = mock.method(clientModule, 'createClient', async (...args) => {
  clientCreations += 1;
  clientArguments.push(args);
  throw new Error('Tests must never create a real OnStar client');
});
const { CadillacPlatform } = require('../index');
createClientMock.mock.restore();

const C = { On: {}, Name: {}, Manufacturer: {}, Model: {}, SerialNumber: {} };
const Service = { AccessoryInformation: {}, Switch: {}, LockMechanism: {} };
const switchNames = ['Cadillac Start', 'Cadillac Stop', 'Cadillac Lock', 'Cadillac Unlock'];
const switchKeys = ['start', 'stop', 'lock', 'unlock'];

class FakeCharacteristic {
  onGet(callback) { this.get = callback; return this; }
  onSet(callback) { this.set = callback; return this; }
  async write(value) {
    await this.set(value);
    // HAP acknowledges the requested value after the asynchronous handler.
    // An earlier updateCharacteristic(false) would be overwritten here.
    this.value = value;
  }
}

class FakeService {
  constructor() { this.characteristics = new Map(); this.updates = []; }
  getCharacteristic(key) {
    if (!this.characteristics.has(key)) this.characteristics.set(key, new FakeCharacteristic());
    return this.characteristics.get(key);
  }
  setCharacteristic(key, value) { return this.updateCharacteristic(key, value); }
  updateCharacteristic(key, value) {
    this.getCharacteristic(key).value = value;
    this.updates.push({ key, value });
    return this;
  }
}

class FakeAccessory {
  constructor(name, id) {
    this.displayName = name;
    this.UUID = id;
    this.context = {};
    this.services = new Map([[Service.AccessoryInformation, new FakeService()]]);
  }
  getService(type) { return this.services.get(type); }
  addService(type) {
    const service = new FakeService();
    this.services.set(type, service);
    return service;
  }
}

class HapStatusError extends Error {
  constructor(status) { super(`HAP status ${status}`); this.hapStatus = status; }
}

function fixture(config = {
  credentialsFile: '/synthetic/private/credentials.json', browserPath: '/synthetic/browsers',
}, storagePath = '/synthetic/homebridge') {
  const api = new EventEmitter();
  api.hap = {
    Characteristic: C, Service, HapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402, RESOURCE_BUSY: -70403 },
    uuid: { generate: (input) => `test-uuid:${input}` },
  };
  api.platformAccessory = FakeAccessory;
  api.user = { storagePath: () => storagePath };
  api.registered = [];
  api.updated = [];
  api.unregistered = [];
  api.registerPlatformAccessories = (_plugin, _platform, accessories) => api.registered.push(...accessories);
  api.updatePlatformAccessories = (accessories) => api.updated.push(...accessories);
  api.unregisterPlatformAccessories = (_plugin, _platform, accessories) => api.unregistered.push(...accessories);
  const warnings = [];
  const platform = new CadillacPlatform({ warn: (message) => warnings.push(message) }, config, api);
  const characteristic = (key) => platform[`${key}Service`].getCharacteristic(C.On);
  return { api, platform, warnings, characteristic };
}

const afterAcknowledgment = () => new Promise((resolve) => setImmediate(resolve));

test('initializer registers the public package and platform names', () => {
  const registered = [];
  require('../index')({ registerPlatform: (...args) => registered.push(args) });
  assert.deepEqual(registered, [['homebridge-cadillac-onstar', 'CadillacOnStar', CadillacPlatform]]);
});

test('unconfigured or invalid path installs stay inert and log only setup guidance', () => {
  const before = clientCreations;
  for (const config of [null, {}, { username: 'private-account', password: 'private-password' },
    { credentialsFile: '' }, { credentialsFile: 'private-token-relative-path' },
    { credentialsFile: 42 },
    { credentialsFile: '/synthetic/credentials.json', browserPath: 'private-browser-relative-path' },
    { credentialsFile: '/synthetic/credentials.json', accessoryUuidPrefix: 'private-invalid-namespace' }]) {
    const { api, platform, warnings } = fixture(config);
    api.emit('didFinishLaunching');
    platform.register();
    api.emit('shutdown');
    assert.equal(platform.controller, undefined);
    assert.deepEqual(api.registered, []);
    assert.deepEqual(api.updated, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /inactive/);
    assert.doesNotMatch(warnings[0], /private-/);
  }
  assert.equal(clientCreations, before);
});

test('vehicle labels are configurable without changing stable public accessory IDs', () => {
  const original = fixture();
  const renamed = fixture({ credentialsFile: '/synthetic/other-private/credentials.json',
    vehicleName: '  Family SUV  ', model: 'Escalade ESV' });
  original.api.emit('didFinishLaunching');
  renamed.api.emit('didFinishLaunching');
  assert.deepEqual(renamed.api.registered.map(a => a.UUID), original.api.registered.map(a => a.UUID));
  assert.deepEqual(renamed.api.registered.map(a => a.displayName),
    ['Family SUV Start', 'Family SUV Stop', 'Family SUV Lock', 'Family SUV Unlock']);
  for (const accessory of renamed.api.registered) {
    assert.equal(accessory.getService(Service.AccessoryInformation).getCharacteristic(C.Model).value, 'Escalade ESV');
  }
  for (const accessory of original.api.registered) {
    assert.equal(accessory.getService(Service.AccessoryInformation).getCharacteristic(C.Model).value, 'OnStar Vehicle');
    assert.ok(accessory.UUID.startsWith('test-uuid:homebridge-cadillac-onstar:'));
  }
  original.api.emit('shutdown');
  renamed.api.emit('shutdown');
});

test('runtime browser cache follows Homebridge storage and honors explicit absolute overrides', async () => {
  const configured = fixture({ credentialsFile: '/synthetic/private/credentials.json' }, '/synthetic/custom-storage');
  assert.equal(configured.platform.browserPath, '/synthetic/custom-storage/.cache/homebridge-cadillac-onstar/browsers');
  await assert.rejects(configured.platform.controller.createClient());
  assert.deepEqual(clientArguments.at(-1), [
    '/synthetic/private/credentials.json', '/synthetic/custom-storage/.cache/homebridge-cadillac-onstar/browsers',
  ]);
  const override = fixture({ credentialsFile: '/synthetic/private/credentials.json', browserPath: '/synthetic/explicit-cache' });
  assert.equal(override.platform.browserPath, '/synthetic/explicit-cache');
  const fallback = fixture({ credentialsFile: '/synthetic/private/credentials.json' }, null);
  assert.equal(fallback.platform.browserPath, '/synthetic/private/.cache/browsers');
  for (const { api } of [configured, override, fallback]) api.emit('shutdown');
});

test('new UUID namespace does not claim or remove legacy cached accessories automatically', () => {
  const { api, platform } = fixture();
  const legacy = new FakeAccessory('Legacy Doors', api.hap.uuid.generate('homebridge-escalade-onstar:doors'));
  platform.configureAccessory(legacy);
  api.emit('didFinishLaunching');
  assert.deepEqual(api.unregistered, []);
  assert.equal(platform.cached.get(legacy.UUID), legacy);
  assert.equal(api.registered.length, 4);
  api.emit('shutdown');
});

test('startup, GETs, false writes, resets, and shutdown never create a vehicle client', async () => {
  const before = clientCreations;
  const { api, platform, characteristic } = fixture();
  api.emit('didFinishLaunching');
  assert.deepEqual(api.registered.map((accessory) => accessory.displayName), switchNames);
  for (const accessory of api.registered) {
    assert.ok(accessory.getService(Service.Switch));
    assert.equal(accessory.getService(Service.LockMechanism), undefined);
  }
  for (const key of switchKeys) {
    assert.equal(characteristic(key).get(), false);
    assert.equal(characteristic(key).value, false);
    await characteristic(key).write(false);
    platform.resetSwitch(platform[`${key}Service`]);
  }
  await afterAcknowledgment();
  for (const key of switchKeys) assert.equal(characteristic(key).get(), false);
  api.emit('shutdown');
  await afterAcknowledgment();
  assert.equal(clientCreations, before);
});

test('each true write sends its one matching action and resets after HAP acknowledges true', async () => {
  const { api, platform, characteristic } = fixture();
  const actions = [];
  platform.controller.setStart = async (value) => { actions.push(['start', value]); };
  platform.controller.setLocked = async (value) => { actions.push(['locked', value]); };
  api.emit('didFinishLaunching');
  for (const key of switchKeys) {
    await characteristic(key).write(true);
    assert.equal(characteristic(key).value, true);
    await afterAcknowledgment();
    assert.equal(characteristic(key).value, false);
    assert.equal(characteristic(key).get(), false);
    await characteristic(key).write(false);
  }
  assert.deepEqual(actions, [['start', true], ['start', false], ['locked', true], ['locked', false]]);
  api.emit('shutdown');
});

test('failed and busy actions still reset and expose only sanitized HAP errors', async () => {
  const { api, platform, warnings, characteristic } = fixture();
  platform.controller.setStart = async () => { throw new Error('secret-upstream-password'); };
  platform.controller.setLocked = async () => {
    throw Object.assign(new Error('secret-upstream-token'), { code: 'BUSY' });
  };
  api.emit('didFinishLaunching');
  for (const key of switchKeys) {
    const item = characteristic(key);
    item.value = true;
    const expected = ['start', 'stop'].includes(key)
      ? api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE : api.hap.HAPStatus.RESOURCE_BUSY;
    await assert.rejects(item.write(true), { hapStatus: expected });
    await afterAcknowledgment();
    assert.equal(item.value, false);
    assert.equal(item.get(), false);
  }
  assert.equal(warnings.join(' ').includes('secret-'), false);
  api.emit('shutdown');
});

test('explicit legacy namespace preserves cached Start identity and removes only its old Doors accessory', () => {
  const before = clientCreations;
  const { api, platform, characteristic } = fixture({
    credentialsFile: '/synthetic/private/credentials.json', accessoryUuidPrefix: 'homebridge-escalade-onstar',
  });
  const cachedStart = new FakeAccessory('Old start', api.hap.uuid.generate('homebridge-escalade-onstar:start'));
  const cachedDoors = new FakeAccessory('Old doors', api.hap.uuid.generate('homebridge-escalade-onstar:doors'));
  cachedStart.addService(Service.Switch).setCharacteristic(C.On, true);
  cachedDoors.addService(Service.LockMechanism);
  cachedStart.context = { previousSession: true };
  platform.configureAccessory(cachedStart);
  platform.configureAccessory(cachedDoors);
  const unrelated = new FakeAccessory('Other plugin', api.hap.uuid.generate('other-plugin:doors'));
  platform.configureAccessory(unrelated);
  api.emit('didFinishLaunching');
  assert.deepEqual(api.updated, [cachedStart]);
  assert.deepEqual(api.unregistered, [cachedDoors]);
  assert.deepEqual(api.registered.map((accessory) => accessory.displayName), switchNames.slice(1));
  assert.equal(cachedStart.UUID, api.hap.uuid.generate('homebridge-escalade-onstar:start'));
  assert.equal(characteristic('start').value, false);
  assert.deepEqual(cachedStart.context, { kind: 'start' });
  assert.equal(platform.cached.has(cachedDoors.UUID), false);
  assert.equal(platform.cached.get(unrelated.UUID), unrelated);
  assert.ok(api.registered.every(accessory => accessory.UUID.startsWith('test-uuid:homebridge-escalade-onstar:')));
  api.emit('shutdown');
  assert.equal(clientCreations, before);
});

test('all four cached switch identities restore without replaying old On values', async () => {
  const before = clientCreations;
  const { api, platform, characteristic } = fixture();
  const accessories = switchKeys.map((key) => {
    const accessory = new FakeAccessory(`Old ${key}`, api.hap.uuid.generate(`homebridge-cadillac-onstar:${key}`));
    accessory.addService(Service.Switch).setCharacteristic(C.On, true);
    accessory.context = { staleCommand: true };
    platform.configureAccessory(accessory);
    return accessory;
  });
  api.emit('didFinishLaunching');
  assert.deepEqual(api.updated, accessories);
  assert.deepEqual(api.registered, []);
  assert.deepEqual(api.unregistered, []);
  await afterAcknowledgment();
  for (const [index, key] of switchKeys.entries()) {
    assert.equal(characteristic(key).value, false);
    assert.equal(characteristic(key).get(), false);
    assert.deepEqual(accessories[index].context, { kind: key });
  }
  api.emit('shutdown');
  assert.equal(clientCreations, before);
});

test('explicit legacy namespace restores all four cached switch identities', () => {
  const { api, platform } = fixture({ credentialsFile: '/synthetic/private/credentials.json',
    accessoryUuidPrefix: 'homebridge-escalade-onstar' });
  const accessories = switchKeys.map(key => {
    const accessory = new FakeAccessory(`Legacy ${key}`, api.hap.uuid.generate(`homebridge-escalade-onstar:${key}`));
    accessory.addService(Service.Switch).setCharacteristic(C.On, true);
    platform.configureAccessory(accessory);
    return accessory;
  });
  api.emit('didFinishLaunching');
  assert.deepEqual(api.registered, []);
  assert.deepEqual(api.updated, accessories);
  for (const accessory of accessories) assert.equal(accessory.getService(Service.Switch).getCharacteristic(C.On).value, false);
  api.emit('shutdown');
});

test('the dedicated Stop switch cancels a remote start even after a fresh controller restart', async () => {
  const { api, platform, characteristic } = fixture();
  const calls = [];
  platform.controller.createClient = async () => ({
    cancelStart: async () => {
      calls.push('cancelStart');
      return { status: 'success', response: { data: { status: 'SUCCESS' } } };
    },
  });
  api.emit('didFinishLaunching');
  assert.equal(platform.controller.getStart(), null);
  await characteristic('stop').write(true);
  await afterAcknowledgment();
  assert.equal(characteristic('stop').value, false);
  assert.deepEqual(calls, ['cancelStart']);
  await characteristic('stop').write(false);
  api.emit('shutdown');
  assert.deepEqual(calls, ['cancelStart']);
});

test('resetting the Start switch does not stop the engine or bypass duplicate-start protection', async () => {
  const { api, platform, characteristic } = fixture();
  const calls = [];
  platform.controller.createClient = async () => ({
    start: async () => {
      calls.push('start');
      return { status: 'success', response: { data: { status: 'SUCCESS' } } };
    },
    cancelStart: async () => { calls.push('cancelStart'); },
  });
  api.emit('didFinishLaunching');
  await characteristic('start').write(true);
  await afterAcknowledgment();
  assert.equal(characteristic('start').value, false);
  assert.equal(platform.controller.getStart(), true);
  const originalExpiry = platform.controller.startExpiresAt;
  await characteristic('start').write(false);
  await characteristic('start').write(true);
  await afterAcknowledgment();
  assert.equal(platform.controller.startExpiresAt, originalExpiry);
  assert.deepEqual(calls, ['start']);
  api.emit('shutdown');
  assert.deepEqual(calls, ['start']);
});

test('shutdown suppresses a pending display reset without sending another command', async () => {
  const { api, platform, characteristic } = fixture();
  const actions = [];
  platform.controller.setLocked = async (value) => { actions.push(value); };
  api.emit('didFinishLaunching');
  await characteristic('lock').write(true);
  const updateCount = platform.lockService.updates.length;
  api.emit('shutdown');
  await afterAcknowledgment();
  assert.equal(platform.lockService.updates.length, updateCount);
  assert.deepEqual(actions, [true]);
});
