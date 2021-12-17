# @jcoreio/pg-ipc

[![CircleCI](https://circleci.com/gh/jcoreio/pg-ipc.svg?style=svg)](https://circleci.com/gh/jcoreio/pg-ipc)
[![Coverage Status](https://codecov.io/gh/jcoreio/pg-ipc/branch/master/graph/badge.svg)](https://codecov.io/gh/jcoreio/pg-ipc)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
[![npm version](https://badge.fury.io/js/%40jcoreio%2Fpg-ipc.svg)](https://badge.fury.io/js/%40jcoreio%2Fpg-ipc)

Safer postgres pubsub with auto reconnect, channel length checks, and notify queue during reconnect

# Why another package?

Other packages I've seen have problems, for example:

- They don't handle reconnection
- They silently accept channels that are too long, and don't receive messages because Postgres truncates channels to 63 characters
- They reserve some channel names

`@jcoreio/pg-ipc` solves all of these problems:

- It automatically reconnects with exponential backoff, and replays `LISTEN`s on reconnect
- It throws errors when you listen or notify on a channel name that's too long
- It doesn't reserve any channel names
- It queues notify calls that fail and replays them on reconnect

# Table of Contents

<!-- toc -->

- [@jcoreio/pg-ipc](#jcoreiopg-ipc)
- [Why another package?](#why-another-package)
- [Table of Contents](#table-of-contents)
- [API](#api)
  - [`class PgIpc<T = any>`](#class-pgipct--any)
    - [`constructor(options: PgIpcOptions)`](#constructoroptions-pgipcoptions)
    - [`.listen(channel: string, listener: Listener<T>): Promise<void>`](#listenchannel-string-listener-listenert-promisevoid)
    - [`.unlisten(channel: string, listener: Listener<T>): Promise<void>`](#unlistenchannel-string-listener-listenert-promisevoid)
    - [`.notify(channel: string, payload?: T): Promise<void>`](#notifychannel-string-payload-t-promisevoid)
    - [Event `'error'`](#event-error)
    - [Event `'warning'`](#event-warning)
    - [Event `'connecting'`](#event-connecting)
    - [Event `'connected'`](#event-connected)
    - [Event `'disconneted'`](#event-disconneted)
    - [Event `'ready'`](#event-ready)
    - [Event `'end'`](#event-end)

<!-- tocstop -->

# API

## `class PgIpc<T = any>`

`T` is the parsed payload type.

```js
import PgIpc from '@jcoreio/pg-ipc'
```

### `constructor(options: PgIpcOptions)`

```ts
type PgIpcOptions<
  /**
   * Payload type
   */
  T = any
> = {
  /**
   * Creates a new pg Client.  This will be called on every connection attempt
   */
  newClient: () => Client
  /**
   * Pass an object with some or all console methods to enable logging
   */
  log?: Partial<typeof console>
  /**
   * Only use this if you compiled postgres with a custom NAMEDATALEN to allow longer channel names.
   * Default: 63
   */
  maxChannelLength?: number
  /**
   * Converts payloads to strings.  Default: JSON.stringify
   */
  stringify?: (payload: T) => string
  /**
   * Parses raw payloads from Postgres notifications.  Default: JSON.parse
   */
  parse?: (rawPayload: string) => T
  /**
   * Reconnect exponential backoff options
   */
  reconnect?: {
    /**
     * The delay before the first reconnect attempt, in milliseconds
     * Default: maxDelay / 10 or 1000.
     */
    initialDelay?: number
    /**
     * The maximum delay between reconnect attempts, in milliseconds
     * Default: initialDelay * 10 or 10000.
     */
    maxDelay?: number
    /**
     * The maximum number of times to try to reconnect before giving up and emitting an error.
     * Default: Infinity (never stop retrying)
     */
    maxRetries?: number
    /**
     * The factor to multiply the reconnect delay by after each failure.  Default: 2
     */
    factor?: number
  }
}
```

### `.listen(channel: string, listener: Listener<T>): Promise<void>`

Registers the given `listener` to listen to the given `channel`.

The listener will be called with the `channel` and maybe the parsed `payload` (but if `NOTIFY` was called without a payload, it will only be called with the `channel`)

```ts
type Listener<T = any> = (channel: string, payload?: T) => any
```

The returned promise will resolve once the `LISTEN` query has completed (if the channel is not already subscribed), or reject if the channel name is too long or the `LISTEN` query fails.
However, `PgIpc` will store the listener in memory and retry the `LISTEN` on reconnect if it failed.

### `.unlisten(channel: string, listener: Listener<T>): Promise<void>`

Unregisters the given `listener` from the given `channel`.

The returned promise will resolve once the `UNLISTEN` query has completed (if necessary, but if there are other listeners on the channel it won't `UNLISTEN` until they're all removed), or reject if the `UNLISTEN` query fails.

### `.notify(channel: string, payload?: T): Promise<void>`

Sends a notification to Postgres.

The returned promise will resolve once the `NOTIFY` query has completed. If your `options.stringify` threw an error, it will reject and emit an `'error'`.
If the query fails, it will reject and emit a `'warning'`, and enqueue the notification to retry upon reconnect.

### Event `'error'`

Emitted with one argument, the `Error` that occurred.

Emitted if an error occurs:

- All `maxRetries` connect attempts fail
- `parse` throws an error on a raw notification payload from Postgres
- A listener throws an error

### Event `'warning'`

Emitted with one argument, the `Error` that occurred

Emitted if a less severe error occurs:

- The postgres client emits an `'error'`

### Event `'connecting'`

Emitted when `PgIpc` is about to try to connect

Emitted with one argument, the postgres `Client`

### Event `'connected'`

Emitted when `PgIpc` successfully connected (but before replaying `LISTEN` and `NOTIFY` queries)

Emitted with one argument, the postgres `Client`

### Event `'disconneted'`

Emitted when the client disconnects.

### Event `'ready'`

Emitted when `PgIpc` finishes replaying `LISTEN` and `NOTIFY` queries after connecting.

### Event `'end'`

Emitted when `PgIpc` is ended by your code or all `maxRetries` connection attempts failed.
