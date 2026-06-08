# bebras-device-proxy

This project aims to provider a device proxy module from the Bebras API, implementing both the platform and task sides. This helps with some browser restrictions pages loaded in iframes.

It currently supports proxying :
* the Web Bluetooth API
* the WebSocket client

Note that the support might be partial as it mostly implements the parts of the APIs which were needed.

## Usage

### Platform

On the platform side:
* in TypeScript, import from `platform/index.ts`
* in JavaScript, import `dist/device-proxy-platform.js` into the page and the object `DeviceProxyPlatform` will export the functions

from which the functions:
* `deviceProxy` implements the handler for calls made by the task to `platform.deviceProxy`, and can be used directly to answer such calls
* `cleanup` stops any current connections made by the device proxy, and is meant to be called when switching tasks

The device proxy expects `window.task.deviceProxy` to be defined, and point to the task's deviceProxy API point.


### Task

On the task side:
* in TypeScript, import from `task/index.ts`
* in JavaScript, import `dist/device-proxy-task.js` into the page and the object `DeviceProxyTask` will export the functions

from which the functions:
* `deviceProxy` implements the handler for calls made by the platform to `task.deviceProxy`, and can be used directly to answer such calls
* `bluetooth` provides the Bluetooth proxy API
* `websocket` provides the WebSocket proxy API

The task module expects `window.platform.deviceProxy` to be defined, and point to the platform's deviceProxy API point.

Once the proxy added, the task can:

* replace `navigator.bluetooth.requestDevice` by `deviceProxy.bluetooth.requestDevice`
* replace `WebSocket` by `deviceProxy.websocket.WebSocket`
