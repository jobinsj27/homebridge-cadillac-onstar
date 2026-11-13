'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { mock, test } = require('node:test');
const clientModule = require('../lib/client');
const presenceModule = require('../lib/presence');
const webhookModule = require('../lib/presence-webhook');

let nextWebhookError;
class FakePresenceWebhook {
  constructor(options) { this.options = options; this.closed = false; }
  async start() {
    const error = nextWebhookError;
    nextWebhookError = undefined;
    if (error) throw error;
  }
  async shutdown() { this.closed = true; }
}
const webhookMock = mock.method(webhookModule, 'PresenceWebhook', function (options) {
  return new FakePresenceWebhook(options);
});

class FakePresenceMonitor {
  constructor(options) { this.options = options; this.states = new Map(); this.starts = 0; this.closed = false; }
  start() { this.starts += 1; }
  shutdown() { this.closed = true; }
  getState(id) { return this.states.get(id); }
  publish(snapshot) { this.states.set(snapshot.id, snapshot); this.options.onUpdate(snapshot); }
}
const presenceMock = mock.method(presenceModule, 'PresenceMonitor', function (...args) {
  return new FakePresenceMonitor(...args);
});

let clientCreations = 0;
const clientArguments = [];
const createClientMock = mock.method(clientModule, 'createClient', async (...args) => {
  clientCreations += 1;
  clientArguments.push(args);
  throw new Error('Tests must never create a real OnStar client');
});
const { CadillacPlatform } = require('../index');
createClientMock.mock.restore();
presenceMock.mock.restore();
webhookMock.mock.restore();

const C = { On: {}, Name: {}, Manufacturer: {}, Model: {}, SerialNumber: {},
  OccupancyDetected: {}, StatusActive: {}, StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 } };
const Service = { AccessoryInformation: {}, Switch: {}, LockMechanism: {}, OccupancySensor: {} };
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
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402, RESOURCE_BUSY: -70403, READ_ONLY_CHARACTERISTIC: -70404 },
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

test('optional Find Car controls are momentary and false writes never send alerts', async () => {
  const { api, platform, characteristic } = fixture({ credentialsFile: '/synthetic/private/credentials.json',
    controls: { findCar: true } });
  const calls = [];
  platform.controller.setAlert = async value => { calls.push(value); };
  api.emit('didFinishLaunching');
  assert.deepEqual(api.registered.map(a => a.displayName), [...switchNames, 'Cadillac Find Car', 'Cadillac Stop Alert']);
  for (const key of ['findCar', 'stopAlert']) {
    assert.equal(characteristic(key).get(), false);
    await characteristic(key).write(false);
    await characteristic(key).write(true);
    await afterAcknowledgment();
    assert.equal(characteristic(key).value, false);
  }
  api.emit('shutdown');
  assert.deepEqual(calls, [true, false]);
});

test('control toggles remove only exact disabled IDs and reenable the same identities', () => {
  const { api, platform } = fixture({ credentialsFile: '/synthetic/private/credentials.json',
    controls: { start: false, unlock: false } });
  const disabled = ['start', 'unlock', 'findCar', 'stopAlert'].map(key => {
    const a = new FakeAccessory(key, api.hap.uuid.generate(`homebridge-cadillac-onstar:${key}`));
    a.addService(Service.Switch);
    platform.configureAccessory(a);
    return a;
  });
  const unrelated = new FakeAccessory('other', api.hap.uuid.generate('other-plugin:start'));
  platform.configureAccessory(unrelated);
  api.emit('didFinishLaunching');
  assert.deepEqual(api.unregistered, disabled);
  assert.deepEqual(api.registered.map(a => a.displayName), ['Cadillac Stop', 'Cadillac Lock']);
  assert.equal(platform.cached.get(unrelated.UUID), unrelated);
  api.emit('shutdown');
  const next = fixture();
  next.api.emit('didFinishLaunching');
  assert.equal(next.api.registered[0].UUID, disabled[0].UUID);
  assert.equal(next.api.registered[3].UUID, disabled[1].UUID);
  next.api.emit('shutdown');
});

const place = { id: 'home', name: 'Home', latitude: 12, longitude: 34 };
const presenceConfig = overrides => ({ credentialsFile: '/synthetic/private/credentials.json',
  presence: { enabled: true, locations: [place], ...overrides } });

function eventFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadillac-platform-events-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = presenceConfig({ source: 'events', exposeSwitch: true,
    locations: [{ id: 'home', name: 'Home' }], webhook: {
      tokenFile: path.join(directory, 'event.token'), stateFile: path.join(directory, 'state.json'),
    } });
  const result = fixture(config);
  t.after(() => result.api.emit('shutdown'));
  return { ...result, config };
}

test('event presence retains accessory IDs, persists crossings, and never opens an OnStar client', async t => {
  const before = clientCreations;
  const f = eventFixture(t);
  f.api.emit('didFinishLaunching');
  await f.platform.presenceReady;
  const mirror = f.api.registered.find(a => a.context.kind === 'presence-switch').getService(Service.Switch);
  const sensor = f.api.registered.find(a => a.context.kind === 'presence').getService(Service.OccupancySensor);
  const characteristic = mirror.getCharacteristic(C.On);
  assert.throws(() => characteristic.get(), { hapStatus: -70402 });
  assert.throws(() => characteristic.set(true), { hapStatus: -70404 });
  const arrived = { eventId: 'message-one', locationId: 'home', event: 'arrived',
    occurredAt: new Date(Date.now() - 2000).toISOString() };
  const departed = { ...arrived, eventId: 'message-two', event: 'departed',
    occurredAt: new Date(Date.now() - 1000).toISOString() };
  f.platform.presenceWebhook.options.onEvent(arrived);
  assert.equal(characteristic.get(), true);
  assert.equal(sensor.getCharacteristic(C.OccupancyDetected).value, 1);
  assert.equal(mirror.updates.filter(u => u.key === C.On).length, 0, 'first event is a silent baseline');
  f.platform.presenceWebhook.options.onEvent(departed);
  assert.equal(characteristic.get(), false);
  assert.deepEqual(mirror.updates.filter(u => u.key === C.On).map(u => u.value), [false]);
  f.api.emit('shutdown');
  assert.equal(f.platform.presenceWebhook.closed, true);
  const restarted = fixture(f.config);
  t.after(() => restarted.api.emit('shutdown'));
  for (const accessory of f.api.registered) restarted.platform.configureAccessory(accessory);
  restarted.api.emit('didFinishLaunching');
  await restarted.platform.presenceReady;
  assert.equal(restarted.api.registered.length, 0);
  assert.equal(restarted.api.unregistered.length, 0);
  assert.equal(characteristic.get(), false);
  assert.equal(restarted.platform.presenceMonitor.getState('home').available, true);
  const polling = fixture(presenceConfig({ exposeSwitch: true }));
  polling.api.emit('didFinishLaunching');
  assert.deepEqual(polling.api.registered.map(a => a.UUID), f.api.registered.map(a => a.UUID));
  polling.api.emit('shutdown');
  assert.equal(clientCreations, before);
});

test('Gmail mode checks the mailbox locally and stops polling on Homebridge shutdown', async t => {
  const before = clientCreations;
  const { config } = eventFixture(t);
  const { stateFile } = config.presence.webhook;
  let signal;
  t.mock.method(require('../lib/gmail'), 'openMailbox', () => ({
    list: async (_after, requestSignal) => { signal = requestSignal; return {}; },
  }));
  const f = fixture(presenceConfig({ source: 'gmail', locations: [{ id: 'home' }],
    gmail: { sessionFile: stateFile + '.oauth', stateFile, locationName: 'homebridge' } }));
  t.after(() => f.api.emit('shutdown'));
  f.api.emit('didFinishLaunching');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  assert.equal(f.platform.presenceWebhook, undefined);
  assert.equal(f.platform.presenceMonitor.getState('home').available, false);
  f.api.emit('shutdown');
  assert.equal(signal.aborted, true);
  assert.equal(clientCreations, before);
});

test('event listener failure leaves commands available and presence unavailable without leaking errors', async t => {
  const before = clientCreations;
  const f = eventFixture(t);
  nextWebhookError = new Error('private-listener-token-and-path');
  f.api.emit('didFinishLaunching');
  await f.platform.presenceReady;
  assert.equal(f.platform.presenceMonitor.getState('home').available, false);
  assert.equal(f.platform.presenceWebhook.closed, true);
  assert.equal(f.characteristic('lock').get(), false);
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings[0], /private-listener/);
  assert.equal(clientCreations, before);
});

test('shutdown during listener startup and runtime listener errors fail closed without a vehicle call', async t => {
  const before = clientCreations;
  const f = eventFixture(t);
  f.api.emit('didFinishLaunching');
  f.api.emit('shutdown');
  await f.platform.presenceReady;
  assert.equal(f.platform.presenceWebhook.closed, true);
  assert.equal(f.platform.presenceMonitor.getState('home').available, false);
  const other = eventFixture(t);
  other.api.emit('didFinishLaunching');
  await other.platform.presenceReady;
  other.platform.presenceWebhook.options.onError(new Error('private-error'));
  assert.equal(other.platform.presenceWebhook.closed, true);
  assert.equal(other.platform.presenceMonitor.getState('home').available, false);
  assert.equal(other.warnings.length, 1);
  assert.equal(clientCreations, before);
});

test('invalid controls or enabled presence configuration never removes cached accessories', () => {
  const before = clientCreations;
  for (const config of [
    { controls: { start: 'false' } }, { controls: [] }, { controls: null },
    { controls: { charging: true } }, { presence: { enabled: 'true' } },
    { presence: { enabled: true, locations: [{ ...place, latitude: 'private-coordinate' }] } },
    { presence: { enabled: true, locations: [place, place] } },
  ]) {
    const { api, platform, warnings } = fixture({ credentialsFile: '/synthetic/private/credentials.json', ...config });
    const a = new FakeAccessory('cached', api.hap.uuid.generate('homebridge-cadillac-onstar:start'));
    platform.configureAccessory(a);
    api.emit('didFinishLaunching');
    assert.deepEqual(api.registered, []);
    assert.deepEqual(api.updated, []);
    assert.deepEqual(api.unregistered, []);
    assert.equal(platform.cached.get(a.UUID), a);
    assert.equal(platform.controller, undefined);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /private-coordinate/);
    api.emit('shutdown');
  }
  assert.equal(clientCreations, before);
});

test('presence registers stable read-only status accessories and never polls from GET or manual writes', async () => {
  const { api, platform } = fixture(presenceConfig({ exposeSwitch: true }));
  const reads = [];
  platform.controller.getLocation = async () => { reads.push('location'); return { synthetic: true }; };
  api.emit('didFinishLaunching');
  const monitor = platform.presenceMonitor;
  assert.equal(monitor.starts, 1);
  platform.register();
  assert.equal(monitor.starts, 1);
  const [sensor, mirror] = platform.presenceAccessories.get('home');
  assert.throws(() => sensor.characteristic.get(), { hapStatus: -70402 });
  assert.throws(() => mirror.characteristic.get(), { hapStatus: -70402 });
  await assert.rejects(mirror.characteristic.write(true), { hapStatus: -70404 });
  await assert.rejects(mirror.characteristic.write(false), { hapStatus: -70404 });
  assert.deepEqual(reads, []);
  assert.deepEqual(await monitor.options.readLocation(), { synthetic: true });
  assert.deepEqual(reads, ['location']);
  const accessories = api.registered.slice(4);
  assert.deepEqual(accessories.map(a => a.displayName), ['Cadillac at Home', 'Cadillac at Home Switch']);
  assert.deepEqual(accessories.map(a => a.context), [
    { kind: 'presence', placeId: 'home' }, { kind: 'presence-switch', placeId: 'home' },
  ]);
  assert.equal(JSON.stringify(accessories.map(a => a.context)).includes('latitude'), false);
  api.emit('shutdown');
  assert.equal(monitor.closed, true);
});

test('presence baselines are silent, confirmed crossings notify, and stale GPS never becomes away', () => {
  const { api, platform } = fixture(presenceConfig({ exposeSwitch: true }));
  api.emit('didFinishLaunching');
  const [sensor, mirror] = platform.presenceAccessories.get('home');
  const state = { id: 'home', present: true, available: true, changed: false, baseline: true, observedAt: 1000 };
  const monitor = platform.presenceMonitor;
  const counts = () => [sensor, mirror].map(item => item.service.updates.filter(u => u.key === item.characteristicType).length);
  const initialCounts = counts();
  monitor.publish(state);
  assert.deepEqual(counts(), initialCounts);
  assert.equal(sensor.characteristic.value, 1);
  assert.equal(mirror.characteristic.value, true);
  assert.equal(sensor.characteristic.get(), 1);
  assert.equal(mirror.characteristic.get(), true);
  monitor.publish({ ...state, available: false, baseline: false, observedAt: 1000 });
  assert.deepEqual(counts(), initialCounts);
  assert.equal(sensor.characteristic.value, 1);
  assert.equal(mirror.characteristic.value, true);
  assert.equal(sensor.service.getCharacteristic(C.StatusFault).value, 1);
  assert.equal(sensor.service.getCharacteristic(C.StatusActive).value, false);
  assert.throws(() => sensor.characteristic.get(), { hapStatus: -70402 });
  monitor.publish({ ...state, present: false, observedAt: 2000 }); // recovery is a new baseline
  assert.deepEqual(counts(), initialCounts);
  assert.equal(sensor.characteristic.get(), 0);
  monitor.publish({ ...state, changed: true, baseline: false, observedAt: 3000 });
  assert.deepEqual(counts(), initialCounts.map(n => n + 1));
  assert.equal(sensor.characteristic.get(), 1);
  assert.equal(sensor.service.getCharacteristic(C.StatusFault).value, 0);
  api.emit('shutdown');
  const finalCounts = counts();
  monitor.publish({ ...state, present: false, changed: true, baseline: false, observedAt: 4000 });
  assert.deepEqual(counts(), finalCounts);
});

test('location diagnostics report health transitions without raw errors or telemetry', async () => {
  const { api, platform, warnings } = fixture(presenceConfig());
  const recovery = [];
  platform.log.info = message => recovery.push(message);
  api.emit('didFinishLaunching');
  const read = () => platform.presenceMonitor.options.readLocation();
  const sample = { latitude: 12, longitude: 34, observedAt: Date.now() };
  platform.controller.getLocation = async () => sample;
  assert.equal(await read(), sample);
  assert.deepEqual(warnings, []);
  assert.deepEqual(recovery, []);
  platform.controller.getLocation = async () => { throw Object.assign(new Error('private-account-url'), { code: 'BUSY' }); };
  await assert.rejects(read(), { code: 'BUSY' });
  assert.deepEqual(warnings, []);
  platform.controller.getLocation = async () => { throw Object.assign(new Error('private-account-url'), { code: 'LOCATION_PENDING' }); };
  await assert.rejects(read(), { code: 'LOCATION_PENDING' });
  assert.deepEqual(warnings, []);
  platform.controller.getLocation = async () => { throw new Error('private-account-url'); };
  await assert.rejects(read());
  await assert.rejects(read());
  assert.equal(warnings.length, 1);
  platform.controller.getLocation = async () => ({ ...sample, observedAt: 1 });
  await read();
  await read();
  assert.equal(warnings.length, 2);
  platform.controller.getLocation = async () => sample;
  await read();
  await read();
  assert.equal(recovery.length, 1);
  assert.doesNotMatch(JSON.stringify([...warnings, ...recovery]), /private-account|latitude|longitude|12|34/);
  api.emit('shutdown');
});

test('a silent presence baseline clears a cached HAP read fault without publishing a crossing', () => {
  const { api, platform } = fixture(presenceConfig({ exposeSwitch: true }));
  api.emit('didFinishLaunching');
  const accessories = platform.presenceAccessories.get('home');
  const counts = accessories.map(item => item.service.updates.length);
  for (const item of accessories) item.characteristic.statusCode = -70402;
  platform.presenceMonitor.publish({ id: 'home', present: true, available: true,
    changed: false, baseline: true, observedAt: 1000 });
  for (const [index, item] of accessories.entries()) {
    assert.equal(item.characteristic.statusCode, 0);
    const updates = item.service.updates.slice(counts[index]);
    assert.equal(updates.some(update => update.key === item.characteristicType), false);
  }
  api.emit('shutdown');
});

test('presence place renames retain identity; removed places and mirrors clean up only owned cache entries', () => {
  const original = fixture(presenceConfig({ exposeSwitch: true }));
  original.api.emit('didFinishLaunching');
  const cache = [...original.platform.cached.values()];
  original.api.emit('shutdown');
  const renamed = fixture(presenceConfig({ locations: [{ ...place, name: 'House' }] }));
  for (const a of cache) renamed.platform.configureAccessory(a);
  const foreign = new FakeAccessory('Foreign', renamed.api.hap.uuid.generate('other-plugin:presence:home'));
  foreign.context = { kind: 'presence', placeId: 'home' };
  renamed.platform.configureAccessory(foreign);
  renamed.api.emit('didFinishLaunching');
  const sensor = cache.find(a => a.context.kind === 'presence');
  const mirror = cache.find(a => a.context.kind === 'presence-switch');
  assert.equal(sensor.displayName, 'Cadillac at House');
  assert.ok(renamed.api.updated.includes(sensor));
  assert.deepEqual(renamed.api.unregistered, [mirror]);
  assert.equal(renamed.platform.cached.get(foreign.UUID), foreign);
  renamed.api.emit('shutdown');
  const disabled = fixture();
  for (const a of renamed.platform.cached.values()) disabled.platform.configureAccessory(a);
  disabled.api.emit('didFinishLaunching');
  assert.deepEqual(disabled.api.unregistered, [sensor]);
  assert.equal(disabled.platform.presenceMonitor, undefined);
  assert.equal(disabled.platform.cached.get(foreign.UUID), foreign);
  disabled.api.emit('shutdown');
});
