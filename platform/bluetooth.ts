/**
 * Platform-side Bluetooth proxy module.
 *
 * Receives proxy calls from the task (via the Bebras API) and executes real
 * Web Bluetooth operations. Pushes events (characteristic value changes,
 * disconnections) back to the task through the `taskDeviceProxy` function.
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '../shared/base64';

// ─── Global declarations ────────────────────────────────────────────────

declare global {
  interface Window {
    task: {
      deviceProxy(
        category: string,
        method: string,
        args: any,
        success: (result: any) => void,
        error: (error: any) => void,
      ): void;
    };
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

/** Handle an incoming proxy call from the task. */
export type HandleBluetoothFn = (
  method: string,
  args: any[],
  callback: (result: any) => void,
  errorCallback: (error: any) => void,
) => void;

// ─── Internal state ─────────────────────────────────────────────────────

interface ServiceEntry {
  service: BluetoothRemoteGATTService;
  deviceId: string;
}

interface CharacteristicEntry {
  characteristic: BluetoothRemoteGATTCharacteristic;
  serviceId: string;
}

interface ProxyState {
  devices: Map<string, BluetoothDevice>;
  services: Map<string, ServiceEntry>;
  characteristics: Map<string, CharacteristicEntry>;
  /** charId → event listener (so we can remove it later). */
  characteristicListeners: Map<string, (ev: Event) => void>;
  nextId: number;
}

function genId(state: ProxyState, prefix: string): string {
  return `${prefix}-${state.nextId++}`;
}

/**
 * Remove all characteristics and services that belong to a given device,
 * and clean up their characteristic-value-changed listeners.
 */
function cleanupDevice(state: ProxyState, deviceId: string): void {
  // Remove characteristic listeners and entries for this device's services
  for (const [charId, entry] of state.characteristics) {
    if (entry.serviceId && state.services.has(entry.serviceId)) {
      const svcEntry = state.services.get(entry.serviceId)!;
      if (svcEntry.deviceId === deviceId) {
        const listener = state.characteristicListeners.get(charId);
        if (listener) {
          entry.characteristic.removeEventListener('characteristicvaluechanged', listener);
          state.characteristicListeners.delete(charId);
        }
        state.characteristics.delete(charId);
      }
    }
  }

  // Remove services for this device
  for (const [serviceId, svcEntry] of state.services) {
    if (svcEntry.deviceId === deviceId) {
      state.services.delete(serviceId);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface PlatformBluetoothProxy {
  handleBluetooth: HandleBluetoothFn;
  cleanup(): void;
}

/**
 * Create the platform-side Bluetooth proxy.
 */
export function createPlatformBluetoothProxy(): PlatformBluetoothProxy {
  const state: ProxyState = {
    devices: new Map(),
    services: new Map(),
    characteristics: new Map(),
    characteristicListeners: new Map(),
    nextId: 1,
  };

  /** Push a one-way event to the task. */
  function pushEvent(event: any): void {
    window.task.deviceProxy('bluetooth', 'event', event, () => {}, () => {});
  }

  /** Reset all proxy state (devices, services, characteristics, listeners). */
  function cleanup(): void {
    for (const deviceId of state.devices.keys()) {
      cleanupDevice(state, deviceId);
    }
    state.devices.clear();
    state.nextId = 1;
  }

  // ── Method handlers ─────────────────────────────────────────────────

  async function handleRequestDevice(args: any[], callback: (result: any) => void): Promise<void> {
    const [filters] = args;
    const device = await navigator.bluetooth.requestDevice({
      filters,
    });
    const deviceId = genId(state, 'dev');
    state.devices.set(deviceId, device);

    // Forward disconnection events to the task
    device.addEventListener('gattserverdisconnected', () => {
      pushEvent({ name: 'onDisconnected', deviceId });
      cleanupDevice(state, deviceId);
    });

    callback({ id: deviceId, name: device.name ?? null });
  }

  async function handleConnect(args: any[], callback: (result: any) => void): Promise<void> {
    const [deviceId] = args;
    const device = state.devices.get(deviceId);
    if (!device) {
      callback({ error: true, message: 'Device not found' });
      return;
    }
    if (!device.gatt) {
      callback({ error: true, message: 'Device does not support GATT' });
      return;
    }
    await device.gatt.connect();
    callback({ connected: true });
  }

  async function handleDisconnect(args: any[], callback: (result: any) => void): Promise<void> {
    const [deviceId] = args;
    const device = state.devices.get(deviceId);
    if (!device) {
      callback({ error: true, message: 'Device not found' });
      return;
    }
    device.gatt?.disconnect();
    callback({ disconnected: true });
  }

  async function handleIsConnected(args: any[], callback: (result: any) => void): Promise<void> {
    const [deviceId] = args;
    const device = state.devices.get(deviceId);
    if (!device) {
      callback({ error: true, message: 'Device not found' });
      return;
    }
    callback({ connected: device.gatt?.connected ?? false });
  }

  async function handleGetService(args: any[], callback: (result: any) => void): Promise<void> {
    const [deviceId, serviceUuid] = args;
    const device = state.devices.get(deviceId);
    if (!device?.gatt) {
      callback({ error: true, message: 'Device not found or not connected' });
      return;
    }
    const service = await device.gatt.getPrimaryService(serviceUuid);
    const serviceId = genId(state, 'svc');
    state.services.set(serviceId, { service, deviceId });
    callback({ id: serviceId, uuid: service.uuid });
  }

  async function handleGetCharacteristic(args: any[], callback: (result: any) => void): Promise<void> {
    const [serviceId, charUuid] = args;
    const serviceEntry = state.services.get(serviceId);
    if (!serviceEntry) {
      callback({ error: true, message: 'Service not found' });
      return;
    }
    const characteristic = await serviceEntry.service.getCharacteristic(charUuid);
    const charId = genId(state, 'chr');
    state.characteristics.set(charId, { characteristic, serviceId });
    callback({ id: charId, uuid: characteristic.uuid });
  }

  async function handleWriteValue(args: any[], callback: (result: any) => void): Promise<void> {
    const [charId, dataBase64] = args;
    const entry = state.characteristics.get(charId);
    if (!entry) {
      callback({ error: true, message: 'Characteristic not found' });
      return;
    }
    await entry.characteristic.writeValue(base64ToArrayBuffer(dataBase64));
    callback({ written: true });
  }

  async function handleWriteValueWithResponse(args: any[], callback: (result: any) => void): Promise<void> {
    const [charId, dataBase64] = args;
    const entry = state.characteristics.get(charId);
    if (!entry) {
      callback({ error: true, message: 'Characteristic not found' });
      return;
    }
    await entry.characteristic.writeValueWithResponse(base64ToArrayBuffer(dataBase64));
    callback({ written: true });
  }

  async function handleSubscribe(args: any[], callback: (result: any) => void): Promise<void> {
    const [charId] = args;
    const entry = state.characteristics.get(charId);
    if (!entry) {
      callback({ error: true, message: 'Characteristic not found' });
      return;
    }

    // Remove any previous listener for this characteristic
    const prev = state.characteristicListeners.get(charId);
    if (prev) {
      entry.characteristic.removeEventListener('characteristicvaluechanged', prev);
    }

    await entry.characteristic.startNotifications();

    // Create a new listener that forwards values to the task
    const listener = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      if (target.value) {
        pushEvent({
          name: 'onCharacteristicValue',
          charId,
          value: arrayBufferToBase64(target.value.buffer as ArrayBuffer),
        });
      }
    };
    entry.characteristic.addEventListener('characteristicvaluechanged', listener);
    state.characteristicListeners.set(charId, listener);

    callback({ subscribed: true });
  }

  async function handleUnsubscribe(args: any[], callback: (result: any) => void): Promise<void> {
    const [charId] = args;
    const entry = state.characteristics.get(charId);
    if (!entry) {
      callback({ error: true, message: 'Characteristic not found' });
      return;
    }

    await entry.characteristic.stopNotifications();

    const listener = state.characteristicListeners.get(charId);
    if (listener) {
      entry.characteristic.removeEventListener('characteristicvaluechanged', listener);
      state.characteristicListeners.delete(charId);
    }

    callback({ unsubscribed: true });
  }

  const methodHandlers: Record<string, (args: any[], callback: (result: any) => void) => Promise<void>> = {
    requestDevice: handleRequestDevice,
    connect: handleConnect,
    disconnect: handleDisconnect,
    isConnected: handleIsConnected,
    getService: handleGetService,
    getCharacteristic: handleGetCharacteristic,
    writeValue: handleWriteValue,
    writeValueWithResponse: handleWriteValueWithResponse,
    subscribe: handleSubscribe,
    unsubscribe: handleUnsubscribe,
  };

  /** Handle a single Bluetooth proxy method call from the task. */
  async function handleBluetooth(
    method: string,
    args: any[],
    callback: (result: any) => void,
    errorCallback: (error: any) => void,
  ): Promise<void> {
    try {
      const handler = methodHandlers[method];
      if (handler) {
        await handler(args, callback);
      } else {
        errorCallback({ message: `Unknown Bluetooth proxy method: ${method}` });
      }
    } catch (e: any) {
      // Bluetooth errors are propagated through the normal callback as
      // structured error objects (not through errorCallback).
      callback({ error: true, message: e.message ?? String(e) });
    }
  }

  return { handleBluetooth, cleanup };
}

export default createPlatformBluetoothProxy;
