import { createPlatformBluetoothProxy } from './bluetooth';
import { createPlatformWebSocketProxy } from './websocket';

const bluetoothProxy = createPlatformBluetoothProxy();
const websocketProxy = createPlatformWebSocketProxy();

export function handleDeviceProxy(
  category: string,
  method: string,
  args: any[],
  callback: (result: any) => void,
  errorCallback: (error: any) => void,
): void {
  if (category === 'bluetooth') {
    bluetoothProxy.handleBluetooth(method, args, callback, errorCallback);
  } else if (category === 'websocket') {
    websocketProxy.handleWebSocket(method, args, callback, errorCallback);
  } else {
    errorCallback({ message: `Unknown proxy category: ${category}` });
  }
}

export function cleanup(): void {
  bluetoothProxy.cleanup();
  websocketProxy.cleanup();
}

export default {deviceProxy: handleDeviceProxy, cleanup};
