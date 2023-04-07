/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events'
import StrictEventEmitter from 'strict-event-emitter-types'
import type { Client, Notification } from 'pg'
import { VError } from 'verror'

export interface PgIpcEvents {
  error: (error: any) => void
  warning: (error: any) => void
  connecting: (client: Client) => void
  connected: (client: Client) => void
  disconnected: () => void
  ready: () => void
  end: () => void
}

export type PgIpcOptions<
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

type ResolvedPgIpcOptions<T = any> = {
  maxChannelLength: number
  newClient: () => Client
  stringify: (payload: T) => string
  parse: (rawPayload: string) => T
  reconnect: {
    initialDelay: number
    maxDelay: number
    maxRetries: number
    factor: number
  }
}

export type Listener<T = any> = (channel: string, payload?: T) => any

const quoteIdentifier = (id: string): string => `"${id.replace(/"/g, '""')}"`

type PgIpcEmitter = StrictEventEmitter<EventEmitter, PgIpcEvents>

export default class PgIpc<T = any> extends (EventEmitter as {
  new (): PgIpcEmitter
}) {
  private client: Client | undefined
  private log: Partial<typeof console> | undefined
  private options: ResolvedPgIpcOptions<T>
  private subs: Map<string, Set<Listener<T>>> = new Map()
  private notifyQueue: ([string] | [string, string] | null)[] = []

  constructor({
    log,
    newClient,
    maxChannelLength,
    stringify,
    parse,
    reconnect,
  }: PgIpcOptions<T>) {
    super()
    if (
      maxChannelLength != null &&
      (!Number.isInteger(maxChannelLength) || maxChannelLength <= 0)
    ) {
      throw new Error(
        `options.maxChannelLength must be an integer > 0 if given`
      )
    }
    if (
      reconnect?.initialDelay != null &&
      (!Number.isFinite(reconnect.initialDelay) || reconnect.initialDelay <= 0)
    ) {
      throw new Error(
        `options.reconnect.initialDelay must be a finite number > 0 if given`
      )
    }
    if (
      reconnect?.maxDelay != null &&
      (!Number.isFinite(reconnect.maxDelay) || reconnect.maxDelay <= 0)
    ) {
      throw new Error(
        `options.reconnect.maxDelay must be a finite number > 0 if given`
      )
    }
    if (
      reconnect?.maxRetries != null &&
      (!Number.isInteger(reconnect.maxRetries) || reconnect.maxRetries <= 0)
    ) {
      throw new Error(
        `options.reconnect.maxRetries must be an integer > 0 if given`
      )
    }
    if (
      reconnect?.factor != null &&
      (!Number.isFinite(reconnect.factor) || reconnect.factor <= 1)
    ) {
      throw new Error(
        `options.reconnect.factor must be a finite number > 1 if given`
      )
    }
    this.log = log
    this.options = {
      newClient,
      stringify: stringify || ((payload) => JSON.stringify(payload)),
      parse: parse || ((raw) => JSON.parse(raw)),
      maxChannelLength: maxChannelLength ?? 63,
      reconnect: {
        initialDelay:
          reconnect?.initialDelay ??
          (reconnect?.maxDelay && Math.round(reconnect.maxDelay / 10)) ??
          1000,
        maxDelay:
          reconnect?.maxDelay ??
          (reconnect?.initialDelay && reconnect.initialDelay * 10) ??
          10000,
        maxRetries: reconnect?.maxRetries ?? Infinity,
        factor: reconnect?.factor ?? 2,
      },
    }
    this.connect()
  }

  private checkLength(channel: string): void {
    const { maxChannelLength } = this.options
    if (channel.length > maxChannelLength) {
      throw new Error(
        `Channel is longer than ${maxChannelLength} characters: ${JSON.stringify(
          channel
        )}.  @jcoreio/pg-ipc couldn't reliably call the correct listeners in this case because Postgres truncates channels longer than ${maxChannelLength} characters.  Please truncate the channels you pass to @jcoreio/pg-ipc.`
      )
    }
  }

  private connectPromise: Promise<void> | undefined
  private ended = false

  private checkEnded(): void {
    if (this.ended) throw new Error(`PgIpc has been ended`)
  }

  async end(): Promise<void> {
    try {
      this.log?.debug?.('.end')
      this.checkEnded()
      this.ended = true
      await this.client?.end()
    } finally {
      this.emit('end')
    }
  }

  private warning(error: Error) {
    this.log?.warn?.(error)
    this.emit('warning', error)
  }

  connect: () => Promise<void> = (): Promise<void> => {
    this.log?.debug?.('.connect')
    const removeListeners = (client: Client) => {
      client.removeListener('notification', this.handleNotification)
      client.removeListener('error', this.handleError)
    }
    const doConnect = async () => {
      this.checkEnded()
      const prevClient = this.client
      this.client = undefined
      if (prevClient) {
        removeListeners(prevClient)
        prevClient.end().catch((error) => {
          this.log?.error?.('failed to end previous client:', error)
        })
      }
      const { initialDelay, maxDelay, maxRetries, factor } =
        this.options.reconnect
      let connectRetry = 0
      let connectDelay = initialDelay
      while (++connectRetry <= maxRetries) {
        this.checkEnded()
        try {
          this.log?.debug?.('connecting...')
          const client = this.options.newClient()
          client.on('notification', this.handleNotification)
          client.on('error', this.handleError)
          let connected = false
          client.once('end', () => {
            this.log?.debug?.('client ended')
            if (this.client === client) this.client = undefined
            removeListeners(client)
            if (connected && !this.ended) {
              this.emit('disconnected')
              this.connect().catch(() => {
                /**/
              })
            }
          })
          this.emit('connecting', client)
          await client.connect()
          connected = true
          this.log?.debug?.('connected')
          this.checkEnded()
          this.emit('connected', client)
          await this.replayListens(client)
          await this.replayNotifies(client)
          this.client = client
          this.emit('ready')
          break
        } catch (error: any) {
          if (connectRetry >= maxRetries) {
            const verror = new VError(
              error,
              `all ${maxRetries} connect attempts failed`
            )
            this.emit('error', verror)
            this.end().catch(() => {
              /**/
            })
            throw verror
          }
          this.warning(
            new VError(error, `connect attempt ${connectRetry} failed`)
          )
        }
        this.log?.debug?.('retrying in', connectDelay, 'ms')
        await new Promise((resolve) => setTimeout(resolve, connectDelay))
        this.checkEnded()
        connectDelay = Math.max(
          initialDelay,
          Math.min(maxDelay, Math.round(connectDelay * factor))
        )
      }
    }
    if (!this.connectPromise) {
      this.connectPromise = doConnect().finally(
        () => (this.connectPromise = undefined)
      )
      this.connectPromise.catch(() => {
        // ignore
      })
    }
    return this.connectPromise
  }

  private async replayListens(client: Client): Promise<void> {
    const promises = []
    for (const channel of this.subs.keys()) {
      this.log?.debug?.('replaying listen', {
        channel,
      })
      promises.push(client.query(`LISTEN ${quoteIdentifier(channel)};`))
      if (promises.length >= 1000) {
        await Promise.all(promises)
        promises.length = 0
        this.checkEnded()
      }
    }
    if (promises.length) {
      await Promise.all(promises)
      this.checkEnded()
    }
  }

  private async replayNotifies(client: Client): Promise<void> {
    for (let i = 0; i < this.notifyQueue.length; i++) {
      const notification = this.notifyQueue[i]
      if (!notification) continue
      if (notification.length === 2) {
        const [channel, payload] = notification
        this.log?.debug?.('replaying notify', {
          channel,
          payload,
        })
        await client.query(`SELECT pg_notify($1, $2)`, [channel, payload])
      } else {
        const [channel] = notification
        this.log?.debug?.('replaying notify', {
          channel,
        })
        await client.query(`NOTIFY ${quoteIdentifier(channel)}`)
      }
      this.notifyQueue[i] = null
      this.checkEnded()
    }
    this.notifyQueue.length = 0
  }

  private handleNotification: (msg: Notification) => void = ({
    channel,
    payload: rawPayload,
  }: Notification) => {
    if (this.ended) return
    this.log?.debug?.('.handleNotification', {
      channel,
      rawPayload,
    })
    const listeners = this.subs.get(channel)
    try {
      if (listeners) {
        if (rawPayload) {
          const payload = this.options.parse(rawPayload)
          for (const listener of listeners) listener(channel, payload)
        } else {
          for (const listener of listeners) listener(channel)
        }
      }
    } catch (error) {
      this.emit('error', error)
    }
  }

  private handleError: (error: Error) => void = (error: Error) => {
    this.warning(new VError(error, 'client error'))
  }

  async notify(channel: string, payload?: T): Promise<void> {
    this.log?.debug?.('.notify', {
      channel,
      payload,
    })
    this.checkEnded()
    this.checkLength(channel)
    const { client } = this
    if (payload) {
      const stringified = this.options.stringify(payload)
      const enqueue = () => {
        this.log?.debug?.('enqueuing', {
          channel,
          stringified,
        })
        this.notifyQueue.push([channel, stringified])
      }
      if (!client) enqueue()
      else
        await client
          .query(`SELECT pg_notify($1, $2)`, [channel, stringified])
          .catch((error) => {
            this.warning(
              new VError(error, 'NOTIFY failed, will retry upon reconnection')
            )
            enqueue()
          })
    } else {
      const enqueue = () => {
        this.log?.debug?.('enqueuing', {
          channel,
        })
        this.notifyQueue.push([channel])
      }
      if (!client) enqueue()
      else
        await client
          .query(`NOTIFY ${quoteIdentifier(channel)}`)
          .catch((error) => {
            this.warning(
              new VError(error, 'NOTIFY failed, will retry upon reconnection')
            )
            enqueue()
          })
    }
  }

  async listen(channel: string, listener: Listener<T>): Promise<void> {
    this.log?.debug?.('.listen', {
      channel,
      listener,
    })
    this.checkEnded()
    this.checkLength(channel)
    let listeners = this.subs.get(channel)
    const subscribe = !listeners
    if (!listeners) {
      listeners = new Set()
      this.subs.set(channel, listeners)
    }
    listeners.add(listener)
    if (subscribe) {
      await this.client?.query(`LISTEN ${quoteIdentifier(channel)};`)
    }
  }

  async unlisten(channel: string, listener: Listener<T>): Promise<void> {
    this.log?.debug?.('.unlisten', {
      channel,
      listener,
    })
    this.checkEnded()
    const listeners = this.subs.get(channel)
    if (!listeners?.has(listener)) return
    listeners.delete(listener)
    if (!listeners.size) {
      this.subs.delete(channel)
      await this.client?.query(`UNLISTEN ${quoteIdentifier(channel)};`)
    }
  }
}
