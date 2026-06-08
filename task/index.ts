/**
 * Task-side entry point for the device proxy.
 *
 * This is the endpoint registered with the Bebras channel for
 * `platform.deviceProxy(...)` calls. It routes incoming calls by category
 * and delegates to the appropriate handler.
 *
 * ## Usage
 *
 * ```ts
 * import { handleDeviceProxy } from './task/index.js';
 *
 * channel.bind('deviceProxy', function (trans, params) {
 *   handleDeviceProxy(
 *     params.category,
 *     params.method,
 *     params.args,
 *     (result) => trans.complete(result),
 *     (error)  => trans.error(error.message),
 *   );
 * });
 * ```
 */

import { handleBluetooth, bluetoothProxy } from './bluetooth';
import { handleWebSocket, WebSocketProxy } from './websocket';

/**
 * Handle an incoming deviceProxy call from the platform.
 *
 * Routes by category (first argument):
 * - `"bluetooth"` → delegates to the Bluetooth proxy handler.
 * - `"websocket"` → delegates to the WebSocket proxy handler.
 * - anything else → returns an error via `errorCallback`.
 */
export function handleDeviceProxy(
  category: string,
  method: string,
  args: any,
  callback?: (result: any) => void,
  errorCallback?: (error: any) => void,
): void {
  if (category === 'bluetooth') {
    handleBluetooth(method, args, callback ?? (() => {}), errorCallback ?? (() => {}));
  } else if (category === 'websocket') {
    handleWebSocket(method, args, callback ?? (() => {}), errorCallback ?? (() => {}));
  } else {
    errorCallback && errorCallback({ message: `Unknown proxy category: ${category}` });
  }
}

export default {deviceProxy: handleDeviceProxy, bluetooth: bluetoothProxy, websocket: { WebSocket: WebSocketProxy }};
