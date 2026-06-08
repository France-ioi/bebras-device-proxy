/**
 * Task-side WebSocket proxy module.
 *
 * Provides a WebSocket-like API that the task can use as a drop-in
 * replacement for the standard WebSocket API. All operations are
 * proxied to the platform through `platformDeviceProxy`.
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from '../shared/base64';
import type { WebSocketProxyEvent } from '../shared/types';

// ─── Platform caller ────────────────────────────────────────────────────

type PlatformCaller = (method: string, args: any[]) => Promise<any>;

function makePlatformCaller(): PlatformCaller {
  return (method: string, args: any[]): Promise<any> => {
    return new Promise((resolve, reject) => {
      window.platform.deviceProxy(
        'websocket',
        method,
        args,
        (result) => resolve(result),
        (error) => reject(new Error(error.message ?? 'Unknown proxy error')),
      );
    });
  };
}

// ─── WebSocket proxy class ──────────────────────────────────────────────

/** ReadyState constants (matching the standard WebSocket values). */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export class WebSocketProxy {
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  /** @internal */ _wsId: string;

  private readonly callPlatform: PlatformCaller;

  private _url: string;
  private _protocol: string = '';
  private _readyState: number = CONNECTING;
  private _bufferedAmount: number = 0;

  private readonly _onopenListeners = new Set<Function>();
  private readonly _onmessageListeners = new Set<Function>();
  private readonly _oncloseListeners = new Set<Function>();
  private readonly _onerrorListeners = new Set<Function>();

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  // ── Read-only properties ────────────────────────────────────────────

  get url(): string { return this._url; }
  get protocol(): string { return this._protocol; }
  get readyState(): number { return this._readyState; }
  get bufferedAmount(): number { return this._bufferedAmount; }

  // ── Constructor ─────────────────────────────────────────────────────

  constructor(url: string, protocols?: string | string[]) {
    this._url = url;
    this._wsId = ''; // Will be set after open completes
    this.callPlatform = makePlatformCaller();

    // Initiate the connection on the platform
    this._initConnection(url, protocols);
  }

  private async _initConnection(url: string, protocols?: string | string[]): Promise<void> {
    try {
      const result = await this.callPlatform('open', [url, protocols]);
      if (result.error) {
        this._readyState = CLOSED;
        this._dispatch('error', new Event('error'));
        this._dispatch('close', new CloseEvent('close', {
          code: 1006,
          reason: result.message,
          wasClean: false,
        }));
        return;
      }
      // Store the assigned wsId and server-reported URL
      this._wsId = result.id;
      if (result.url) {
        this._url = result.url;
      }
      // Register in the global dispatch map
      _registerWebSocket(result.id, this);
    } catch (e: any) {
      this._readyState = CLOSED;
      this._dispatch('error', new Event('error'));
      this._dispatch('close', new CloseEvent('close', {
        code: 1006,
        reason: e.message ?? String(e),
        wasClean: false,
      }));
    }
  }

  // ── Send ────────────────────────────────────────────────────────────

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this._readyState !== OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }

    if (typeof data === 'string') {
      this.callPlatform('send', [this._wsId, data, false]);
    } else {
      const buffer = (data instanceof DataView ? data.buffer : data) as ArrayBuffer;
      this.callPlatform('send', [this._wsId, arrayBufferToBase64(buffer), true]);
    }
  }

  // ── Close ───────────────────────────────────────────────────────────

  close(code?: number, reason?: string): void {
    if (this._readyState === CLOSED || this._readyState === CLOSING) {
      return;
    }
    this._readyState = CLOSING;
    this.callPlatform('close', [this._wsId, code, reason]);
  }

  // ── Event listeners ─────────────────────────────────────────────────

  addEventListener(type: string, listener: Function): void {
    switch (type) {
      case 'open': this._onopenListeners.add(listener); break;
      case 'message': this._onmessageListeners.add(listener); break;
      case 'close': this._oncloseListeners.add(listener); break;
      case 'error': this._onerrorListeners.add(listener); break;
    }
  }

  removeEventListener(type: string, listener: Function): void {
    switch (type) {
      case 'open': this._onopenListeners.delete(listener); break;
      case 'message': this._onmessageListeners.delete(listener); break;
      case 'close': this._oncloseListeners.delete(listener); break;
      case 'error': this._onerrorListeners.delete(listener); break;
    }
  }

  removeAllEventListeners(type?: string): void {
    if (type === undefined || type === 'open') this._onopenListeners.clear();
    if (type === undefined || type === 'message') this._onmessageListeners.clear();
    if (type === undefined || type === 'close') this._oncloseListeners.clear();
    if (type === undefined || type === 'error') this._onerrorListeners.clear();
  }

  /** @internal */
  _dispatch(type: string, event: any): void {
    switch (type) {
      case 'open':
        this._readyState = OPEN;
        this.onopen?.(event);
        this._onopenListeners.forEach((fn) => fn(event));
        break;
      case 'message':
        this.onmessage?.(event);
        this._onmessageListeners.forEach((fn) => fn(event));
        break;
      case 'close':
        this._readyState = CLOSED;
        this.onclose?.(event);
        this._oncloseListeners.forEach((fn) => fn(event));
        break;
      case 'error':
        this.onerror?.(event);
        this._onerrorListeners.forEach((fn) => fn(event));
        break;
    }
  }
}

// ─── Global dispatch map ────────────────────────────────────────────────

const wsRegistry = new Map<string, WebSocketProxy>();

function _registerWebSocket(wsId: string, ws: WebSocketProxy): void {
  wsRegistry.set(wsId, ws);
}

function _unregisterWebSocket(wsId: string): void {
  wsRegistry.delete(wsId);
}

// ─── Main proxy factory ─────────────────────────────────────────────────

export interface TaskWebSocketProxy {
  /**
   * Handle an incoming event from the platform.
   *
   * The Bebras channel should call this when the platform invokes
   * `task.deviceProxy("websocket", "event", eventData)`.
   */
  handleEvent(event: WebSocketProxyEvent, errorCallback: (error: any) => void): void;
}

/**
 * Create the task-side WebSocket proxy.
 */
export function createWebSocketProxy(): TaskWebSocketProxy {
  function handleEvent(event: WebSocketProxyEvent, errorCallback: (error: any) => void): void {
    const ws = wsRegistry.get(event.wsId);
    if (!ws) {
      // Connection not found — might have been closed already
      return;
    }

    switch (event.name) {
      case 'open':
        ws._dispatch('open', new Event('open'));
        break;
      case 'message': {
        let data: string | ArrayBuffer;
        if (event.isBinary) {
          data = base64ToArrayBuffer(event.data);
        } else {
          data = event.data;
        }
        ws._dispatch('message', new MessageEvent('message', { data }));
        break;
      }
      case 'close':
        _unregisterWebSocket(event.wsId);
        ws._dispatch('close', new CloseEvent('close', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        }));
        break;
      case 'error':
        ws._dispatch('error', new Event('error'));
        break;
      default:
        errorCallback(new Error(`Unknown WebSocket event type: ${(event as any).name}`));
    }
  }

  return { handleEvent };
}

// ─── Singleton proxy ────────────────────────────────────────────────────

const proxy = createWebSocketProxy();

// ─── handleWebSocket ────────────────────────────────────────────────────

/**
 * Handle an incoming WebSocket-category call from the platform.
 *
 * Routes by method (second argument):
 * - `"event"` → delegates to `handleEvent`.
 * - anything else → returns an error via `errorCallback`.
 */
export function handleWebSocket(
  method: string,
  args: any,
  callback: (result: any) => void,
  errorCallback: (error: any) => void,
): void {
  if (method === 'event') {
    proxy.handleEvent(args as WebSocketProxyEvent, errorCallback);
  } else {
    errorCallback({ message: `Unknown WebSocket proxy method: ${method}` });
  }
}

export { proxy as websocketProxy };
export { WebSocketProxy as WebSocket };

export default createWebSocketProxy;
