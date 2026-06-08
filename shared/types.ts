export interface BluetoothRequestDeviceFilter {
  services?: string[];
  name?: string;
  namePrefix?: string;
}

export interface RequestDeviceOptions {
  filters: BluetoothRequestDeviceFilter[];
}

export interface CharacteristicValueEvent {
  name: 'onCharacteristicValue';
  charId: string;
  value: string;
}

export interface DisconnectedEvent {
  name: 'onDisconnected';
  deviceId: string;
}

// ─── WebSocket proxy events ─────────────────────────────────────────────

export interface WebSocketOpenEvent {
  name: 'open';
  wsId: string;
}

export interface WebSocketMessageEvent {
  name: 'message';
  wsId: string;
  data: string;
  isBinary: boolean;
}

export interface WebSocketCloseEvent {
  name: 'close';
  wsId: string;
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface WebSocketErrorEvent {
  name: 'error';
  wsId: string;
}

export type WebSocketProxyEvent =
  | WebSocketOpenEvent
  | WebSocketMessageEvent
  | WebSocketCloseEvent
  | WebSocketErrorEvent;

// ─── Combined proxy events ──────────────────────────────────────────────

export type ProxyEvent = CharacteristicValueEvent | DisconnectedEvent;
export type DeviceProxyEvent = ProxyEvent | WebSocketProxyEvent;