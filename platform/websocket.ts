/**
 * Platform-side WebSocket proxy module.
 *
 * Receives proxy calls from the task (via the Bebras API) and creates/manages
 * real WebSocket connections. Pushes events (open, message, close, error)
 * back to the task through the `taskDeviceProxy` function.
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
export type HandleWebSocketFn = (
  method: string,
  args: any[],
  callback: (result: any) => void,
  errorCallback: (error: any) => void,
) => void;

// ─── Internal state ─────────────────────────────────────────────────────

interface ProxyState {
  connections: Map<string, WebSocket>;
  nextId: number;
}

function genId(state: ProxyState): string {
  return `ws-${state.nextId++}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface PlatformWebSocketProxy {
  handleWebSocket: HandleWebSocketFn;
  cleanup(): void;
}

/**
 * Create the platform-side WebSocket proxy.
 */
export function createPlatformWebSocketProxy(): PlatformWebSocketProxy {
  const state: ProxyState = {
    connections: new Map(),
    nextId: 1,
  };

  /** Push a one-way event to the task. */
  function pushEvent(event: any): void {
    window.task.deviceProxy('websocket', 'event', event, () => {}, () => {});
  }

  /** Reset all proxy state (close connections). */
  function cleanup(): void {
    for (const ws of state.connections.values()) {
      ws.close();
    }
    state.connections.clear();
    state.nextId = 1;
  }

  // ── Method handlers ─────────────────────────────────────────────────

  function handleOpen(args: any[], callback: (result: any) => void): void {
    const [url, protocols] = args;

    if (!url || typeof url !== 'string') {
      callback({ error: true, message: 'url is required' });
      return;
    }

    let ws: WebSocket;
    try {
      ws = protocols != null
        ? new WebSocket(url, protocols)
        : new WebSocket(url);
    } catch (e: any) {
      callback({ error: true, message: e.message ?? String(e) });
      return;
    }

    const wsId = genId(state);
    state.connections.set(wsId, ws);

    ws.addEventListener('open', () => {
      pushEvent({ name: 'open', wsId });
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        pushEvent({ name: 'message', wsId, data: arrayBufferToBase64(data), isBinary: true });
      } else if (typeof data === 'string') {
        pushEvent({ name: 'message', wsId, data, isBinary: false });
      } else {
        // Blob — read as ArrayBuffer then forward
        data.arrayBuffer().then((buf: ArrayBuffer) => {
          pushEvent({ name: 'message', wsId, data: arrayBufferToBase64(buf), isBinary: true });
        });
      }
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      state.connections.delete(wsId);
      pushEvent({
        name: 'close',
        wsId,
        code: ev.code,
        reason: ev.reason,
        wasClean: ev.wasClean,
      });
    });

    ws.addEventListener('error', () => {
      // On error, the browser will also fire a close event, so we don't
      // remove the connection here — the close handler will do that.
      pushEvent({ name: 'error', wsId });
    });

    callback({ id: wsId, url: ws.url });
  }

  function handleSend(args: any[], callback: (result: any) => void): void {
    const [wsId, data, isBinary] = args;
    const ws = state.connections.get(wsId);
    if (!ws) {
      callback({ error: true, message: 'WebSocket not found' });
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      callback({ error: true, message: 'WebSocket is not open' });
      return;
    }
    if (isBinary) {
      ws.send(base64ToArrayBuffer(data));
    } else {
      ws.send(data);
    }
    callback({ sent: true });
  }

  function handleClose(args: any[], callback: (result: any) => void): void {
    const [wsId, code, reason] = args;
    const ws = state.connections.get(wsId);
    if (!ws) {
      callback({ error: true, message: 'WebSocket not found' });
      return;
    }
    if (code != null && reason != null) {
      ws.close(code, reason);
    } else if (code != null) {
      ws.close(code);
    } else {
      ws.close();
    }
    callback({ closed: true });
  }

  function handleReadyState(args: any[], callback: (result: any) => void): void {
    const [wsId] = args;
    const ws = state.connections.get(wsId);
    if (!ws) {
      callback({ error: true, message: 'WebSocket not found' });
      return;
    }
    callback({ readyState: ws.readyState });
  }

  function handleUrl(args: any[], callback: (result: any) => void): void {
    const [wsId] = args;
    const ws = state.connections.get(wsId);
    if (!ws) {
      callback({ error: true, message: 'WebSocket not found' });
      return;
    }
    callback({ url: ws.url });
  }

  const methodHandlers: Record<string, (args: any[], callback: (result: any) => void) => void> = {
    open: handleOpen,
    send: handleSend,
    close: handleClose,
    readyState: handleReadyState,
    url: handleUrl,
  };

  /** Handle a single WebSocket proxy method call from the task. */
  function handleWebSocket(
    method: string,
    args: any[],
    callback: (result: any) => void,
    errorCallback: (error: any) => void,
  ): void {
    try {
      const handler = methodHandlers[method];
      if (handler) {
        handler(args, callback);
      } else {
        errorCallback(`Unknown WebSocket proxy method: ${method}`);
      }
    } catch (e: any) {
      errorCallback(e.message ?? String(e));
    }
  }

  return { handleWebSocket, cleanup };
}

export default createPlatformWebSocketProxy;
