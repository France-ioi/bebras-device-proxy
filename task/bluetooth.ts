/**
 * Task-side Bluetooth proxy module.
 *
 * Provides a Web Bluetooth-like API that the task can use as a drop-in
 * replacement for the standard Web Bluetooth API. All operations are
 * proxied to the platform through `platformDeviceProxy`.
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '../shared/base64';
import type { RequestDeviceOptions, ProxyEvent, CharacteristicValueEvent, DisconnectedEvent } from '../shared/types';

// ─── Global declarations ────────────────────────────────────────────────

declare global {
  interface Window {
    platform: {
      deviceProxy(
        category: string,
        method: string,
        args: any[],
        callback: (result: any) => void,
        errorCallback: (error: any) => void,
      ): void;
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

type PlatformCaller = (method: string, args: any[]) => Promise<any>;

function makePlatformCaller(): PlatformCaller {
  return (method: string, args: any[]): Promise<any> => {
    return new Promise((resolve, reject) => {
      window.platform.deviceProxy(
        'bluetooth',
        method,
        args,
        (result) => resolve(result),
        (error) => reject(new Error(error.message ?? 'Unknown proxy error')),
      );
    });
  };
}

// ─── CharacteristicProxy ────────────────────────────────────────────────

/**
 * Proxy for a BluetoothRemoteGATTCharacteristic.
 *
 * Provides `writeValue`, `writeValueWithResponse`,
 * `writeValueWithoutResponse`, `startNotifications`, `stopNotifications`,
 * and event listener support for `characteristicvaluechanged` events.
 */
export class CharacteristicProxy {
  readonly id: string;
  readonly uuid: string;
  private readonly callPlatform: PlatformCaller;
  private readonly listeners = new Map<string, Set<Function>>();

  constructor(id: string, uuid: string, callPlatform: PlatformCaller) {
    this.id = id;
    this.uuid = uuid;
    this.callPlatform = callPlatform;
  }

  // ── Write ────────────────────────────────────────────────────────────

  /**
   * Write data to the characteristic without expecting an acknowledgement
   * from the server (GATT "Write" without response).
   */
  async writeValue(data: ArrayBuffer | DataView): Promise<void> {
    const buffer = (data instanceof DataView ? data.buffer : data) as ArrayBuffer;
    const result = await this.callPlatform('writeValue', [
      this.id,
      arrayBufferToBase64(buffer),
    ]);
    if (result.error) throw new Error(result.message);
  }

  /**
   * Write data to the characteristic and wait for an acknowledgement
   * from the server (GATT "Write" with response).
   */
  async writeValueWithResponse(data: ArrayBuffer | DataView): Promise<void> {
    const buffer = (data instanceof DataView ? data.buffer : data) as ArrayBuffer;
    const result = await this.callPlatform('writeValueWithResponse', [
      this.id,
      arrayBufferToBase64(buffer),
    ]);
    if (result.error) throw new Error(result.message);
  }

  /**
   * Write data to the characteristic without waiting for an acknowledgement
   * from the server (GATT "Write Without Response").
   */
  async writeValueWithoutResponse(data: ArrayBuffer | DataView): Promise<void> {
    const buffer = (data instanceof DataView ? data.buffer : data) as ArrayBuffer;
    const result = await this.callPlatform('writeValueWithoutResponse', [
      this.id,
      arrayBufferToBase64(buffer),
    ]);
    if (result.error) throw new Error(result.message);
  }

  // ── Notifications ────────────────────────────────────────────────────

  /** Subscribe to characteristic value notifications (startNotifications). */
  async startNotifications(): Promise<void> {
    const result = await this.callPlatform('subscribe', [this.id]);
    if (result.error) throw new Error(result.message);
  }

  /** Unsubscribe from characteristic value notifications (stopNotifications). */
  async stopNotifications(): Promise<void> {
    const result = await this.callPlatform('unsubscribe', [this.id]);
    if (result.error) throw new Error(result.message);
  }

  // ── Event listeners ──────────────────────────────────────────────────

  addEventListener(type: string, listener: Function): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Function): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** @internal Dispatch an event to registered listeners. */
  _dispatch(type: string, event: any): void {
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }
}

// ─── ServiceProxy ───────────────────────────────────────────────────────

/**
 * Proxy for a BluetoothRemoteGATTService.
 *
 * Provides `getCharacteristic` to retrieve characteristics by UUID.
 */
export class ServiceProxy {
  readonly id: string;
  readonly uuid: string;
  private readonly callPlatform: PlatformCaller;
  private readonly registerCharacteristic: (char: CharacteristicProxy) => void;

  constructor(
    id: string,
    uuid: string,
    callPlatform: PlatformCaller,
    registerCharacteristic: (char: CharacteristicProxy) => void,
  ) {
    this.id = id;
    this.uuid = uuid;
    this.callPlatform = callPlatform;
    this.registerCharacteristic = registerCharacteristic;
  }

  /**
   * Get a characteristic by UUID from this service.
   */
  async getCharacteristic(uuid: string): Promise<CharacteristicProxy> {
    const result = await this.callPlatform('getCharacteristic', [this.id, uuid]);
    if (result.error) throw new Error(result.message);
    const char = new CharacteristicProxy(result.id, result.uuid, this.callPlatform);
    this.registerCharacteristic(char);
    return char;
  }
}

// ─── GattServerProxy ────────────────────────────────────────────────────

/**
 * Proxy for a BluetoothRemoteGATTServer.
 *
 * Provides `connect`, `disconnect`, `getPrimaryService`, and tracks the
 * `connected` state locally (updated after each connect/disconnect call
 * and on disconnection events).
 */
export class GattServerProxy {
  private readonly deviceId: string;
  private readonly callPlatform: PlatformCaller;
  private readonly registerCharacteristic: (char: CharacteristicProxy) => void;
  private _connected = false;

  constructor(
    deviceId: string,
    callPlatform: PlatformCaller,
    registerCharacteristic: (char: CharacteristicProxy) => void,
  ) {
    this.deviceId = deviceId;
    this.callPlatform = callPlatform;
    this.registerCharacteristic = registerCharacteristic;
  }

  /** Whether the GATT server is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** @internal */
  _setConnected(value: boolean): void {
    this._connected = value;
  }

  /**
   * Connect to the GATT server.
   * Returns `this` so it can be chained (e.g. `device.gatt.connect().getPrimaryService(uuid)`).
   */
  async connect(): Promise<GattServerProxy> {
    const result = await this.callPlatform('connect', [this.deviceId]);
    if (result.error) throw new Error(result.message);
    this._connected = true;
    return this;
  }

  /**
   * Disconnect from the GATT server.
   */
  async disconnect(): Promise<void> {
    const result = await this.callPlatform('disconnect', [this.deviceId]);
    if (result.error) throw new Error(result.message);
    this._connected = false;
  }

  /**
   * Get a primary service by UUID.
   */
  async getPrimaryService(uuid: string): Promise<ServiceProxy> {
    const result = await this.callPlatform('getService', [this.deviceId, uuid]);
    if (result.error) throw new Error(result.message);
    return new ServiceProxy(
      result.id,
      result.uuid,
      this.callPlatform,
      this.registerCharacteristic,
    );
  }
}

// ─── DeviceProxy ────────────────────────────────────────────────────────

/**
 * Proxy for a BluetoothDevice.
 *
 * Provides access to the GATT server and supports the
 * `gattserverdisconnected` event.
 */
export class DeviceProxy {
  readonly id: string;
  readonly name: string | null;
  readonly gatt: GattServerProxy;

  private readonly disconnectedListeners = new Set<Function>();
  /** charId → CharacteristicProxy, for event dispatching. */
  private readonly characteristics = new Map<string, CharacteristicProxy>();

  constructor(
    id: string,
    name: string | null,
    gatt: GattServerProxy,
  ) {
    this.id = id;
    this.name = name;
    this.gatt = gatt;
  }

  // ── Event listeners ──────────────────────────────────────────────────

  addEventListener(type: string, listener: Function): void {
    if (type === 'gattserverdisconnected') {
      this.disconnectedListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: Function): void {
    if (type === 'gattserverdisconnected') {
      this.disconnectedListeners.delete(listener);
    }
  }

  /** @internal */
  _dispatchDisconnect(): void {
    this.gatt._setConnected(false);
    this.disconnectedListeners.forEach((fn) => fn());
  }

  /** @internal Register a characteristic for event dispatching. */
  _registerCharacteristic(char: CharacteristicProxy): void {
    this.characteristics.set(char.id, char);
  }

  /** @internal Get a characteristic by ID for event dispatching. */
  _getCharacteristic(charId: string): CharacteristicProxy | undefined {
    return this.characteristics.get(charId);
  }

  /** @internal Forget all registered characteristics (their IDs are invalidated on disconnect). */
  _clearCharacteristics(): void {
    this.characteristics.clear();
  }
}

// ─── Main proxy factory ─────────────────────────────────────────────────

export interface TaskBluetoothProxy {
  /**
   * Request a Bluetooth device (shows the device picker).
   *
   * @param options  Request options with filters.
   * @returns        A DeviceProxy with a `.gatt` server.
   */
  requestDevice(options: RequestDeviceOptions): Promise<DeviceProxy>;

  /**
   * Handle an incoming event from the platform.
   *
   * The Bebras channel should call this when the platform invokes
   * `task.deviceProxy("bluetooth", "event", eventData)`.
   */
  handleEvent(event: ProxyEvent, errorCallback: (error: any) => void): void;
}

/**
 * Create the task-side Bluetooth proxy.
 */
export function createBluetoothProxy(): TaskBluetoothProxy {
  const callPlatform = makePlatformCaller();

  /** Active devices, keyed by device ID. */
  const devices = new Map<string, DeviceProxy>();

  // ── Internal: register a characteristic across all devices ──────────
  function registerCharacteristic(char: CharacteristicProxy): void {
    if (currentDevice) {
      currentDevice._registerCharacteristic(char);
    }
  }

  let currentDevice: DeviceProxy | null = null;

  // ── Public API ──────────────────────────────────────────────────────

  async function requestDevice(options: RequestDeviceOptions): Promise<DeviceProxy> {
    const result = await callPlatform('requestDevice', [options.filters]);
    if (result.error) throw new Error(result.message);

    const gatt = new GattServerProxy(result.id, callPlatform, registerCharacteristic);
    const device = new DeviceProxy(result.id, result.name, gatt);
    devices.set(result.id, device);
    currentDevice = device;

    return device;
  }

  // ── Event handlers ─────────────────────────────────────────────────

  function handleOnCharacteristicValue(event: CharacteristicValueEvent): void {
    for (const dev of devices.values()) {
      const char = dev._getCharacteristic(event.charId);
      if (char) {
        const buffer = base64ToArrayBuffer(event.value);
        char._dispatch('characteristicvaluechanged', {
          target: { value: new DataView(buffer) },
        });
        return;
      }
    }
    // characteristic not found, ignore
  }

  function handleOnDisconnected(event: DisconnectedEvent): void {
    const dev = devices.get(event.deviceId);
    if (dev) {
      dev._dispatchDisconnect();
      // Keep the device in the registry and keep currentDevice pointing at it:
      // the API performs automatic reconnections on the same device object
      // without calling requestDevice() again, so characteristics fetched
      // after the reconnection must still be registered and dispatched.
      // Only the characteristic IDs from before the disconnect are stale (the
      // platform invalidated them in its cleanup), so clear those.
      dev._clearCharacteristics();
    }
  }

  const eventHandlers: Record<string, (event: ProxyEvent) => void> = {
    onCharacteristicValue: handleOnCharacteristicValue as (event: ProxyEvent) => void,
    onDisconnected: handleOnDisconnected as (event: ProxyEvent) => void,
  };

  function handleEvent(event: ProxyEvent, errorCallback: (error: any) => void): void {
    const handler = eventHandlers[event.name];
    if (handler) {
      handler(event);
    } else {
      errorCallback(new Error(`Unknown event type: ${(event as any).name}`));
    }
  }

  return { requestDevice, handleEvent };
}

// ─── Singleton proxy ────────────────────────────────────────────────────

const proxy = createBluetoothProxy();

// ─── handleBluetooth ────────────────────────────────────────────────────

/**
 * Handle an incoming Bluetooth-category call from the platform.
 *
 * Routes by method (second argument):
 * - `"event"` → delegates to `handleEvent`.
 * - anything else → returns an error via `errorCallback`.
 */
export function handleBluetooth(
  method: string,
  args: any,
  callback: (result: any) => void,
  errorCallback: (error: any) => void,
): void {
  if (method === 'event') {
    proxy.handleEvent(args as ProxyEvent, errorCallback);
  } else {
    errorCallback({ message: `Unknown Bluetooth proxy method: ${method}` });
  }
}

export { proxy as bluetoothProxy };

export default createBluetoothProxy;
