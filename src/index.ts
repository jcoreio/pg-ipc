/* eslint-disable @typescript-eslint/no-explicit-any */
import EventEmitter from 'events'
import StrictEventEmitter from 'strict-event-emitter-types'
import type { Client, Notification } from 'pg'

export interface PgIpcEvents {
  error: (error: any) => void
  connect: (client: Client) => void
  ready: () => void
}

type PgIpcEmitter = StrictEventEmitter<EventEmitter, PgIpcEvents>

type PgIpcOptions<T = any> = {
  log?: typeof console
  /**
   * Creates a new pg Client.  This will be called on start and
   */
  newClient: () => Client
  stringify?: (payload: T) => string
  parse?: (rawPayload: string) => T
  reconnect?: {
    initialDelay?: number
    maxDelay?: number
    maxRetries?: number
    factor?: number
  }
}

type ResolvedPgIpcOptions<T = any> = {
  log?: typeof console
  /**
   * Creates a new pg Client.  This will be called on start and
   */
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

type Listener<T = any> = (payload?: T) => any

function quoteIdentifier(id: string): string {
  return /^[_a-z][_a-z0-9$]*$/i.test(id) ? id : `"${id.replace(/"/g, '""')}"`
}

export default class PgIpc<T = any> extends (EventEmitter as {
  new (): PgIpcEmitter
}) {
  private client: Client | undefined
  private options: ResolvedPgIpcOptions<T>
  private subs: Map<string, Set<Listener<T>>> = new Map()
  private notifyQueue: ([string] | [string, string] | null)[] = []

  constructor({ log, newClient, stringify, parse, reconnect }: PgIpcOptions) {
    super()
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
    this.options = {
      log,
      newClient,
      stringify: stringify || ((payload) => JSON.stringify(payload)),
      parse: parse || ((raw) => JSON.parse(raw)),
      reconnect: {
        initialDelay: reconnect?.initialDelay ?? 10,
        maxDelay: reconnect?.maxDelay ?? 10000,
        maxRetries: reconnect?.maxRetries ?? Infinity,
        factor: reconnect?.factor ?? 2,
      },
    }
    this.reconnect()
  }

  private checkLength(channel: string): void {
    if (channel.length > 63) {
      throw new Error(
        `Channel is longer than 63 characters: ${JSON.stringify(
          channel
        )}.  @jcoreio/pg-ipc couldn't reliably call the correct listeners in this case because Postgres truncates channels longer than 63 characters.  Please truncate the channels you pass to @jcoreio/pg-ipc.`
      )
    }
  }

  private reconnectPromise: Promise<void> | undefined
  private ended = false

  private checkEnded(): void {
    if (this.ended) throw new Error(`PgIpc has been ended`)
  }

  async end(): Promise<void> {
    this.options.log?.debug('.end')
    this.checkEnded()
    this.ended = true
    await this.client?.end()
  }

  reconnect: () => Promise<void> = (): Promise<void> => {
    const doReconnect = async () => {
      this.options.log?.debug('.reconnect')
      this.checkEnded()
      if (this.client) {
        this.client.removeListener('notification', this.handleNotification)
        this.client.removeListener('error', this.handleError)
        this.client.end().catch((error) => {
          this.options.log?.error('failed to end previous client:', error)
        })
      }
      this.client = undefined
      const { initialDelay, maxDelay, maxRetries, factor } =
        this.options.reconnect
      let delay = initialDelay
      let retry = 0
      while (++retry <= maxRetries) {
        try {
          this.checkEnded()
          this.options.log?.debug('connecting...')
          const client = this.options.newClient()
          client.on('notification', this.handleNotification)
          client.on('error', this.handleError)
          await client.connect()
          this.options.log?.debug('connected')
          this.checkEnded()
          this.emit('connect', client)
          await this.replayListens(client)
          await this.replayNotifies(client)
          this.client = client
          this.emit('ready')
          break
        } catch (error) {
          this.options.log?.error('failed to connect:', error)
          this.emit('error', error)
          if (retry >= maxRetries) throw error
        }
        this.options.log?.debug('retrying in', delay, 'ms')
        await new Promise((resolve) => setTimeout(resolve, delay))
        this.checkEnded()
        delay = Math.max(
          initialDelay,
          Math.min(maxDelay, Math.round(delay * factor))
        )
      }
    }
    if (!this.reconnectPromise) {
      this.reconnectPromise = doReconnect().finally(
        () => (this.reconnectPromise = undefined)
      )
      this.reconnectPromise.catch(() => {
        // ignore
      })
    }
    return this.reconnectPromise
  }

  private async replayListens(client: Client): Promise<void> {
    const promises = []
    for (const channel of this.subs.keys()) {
      promises.push(client.query(`LISTEN ${quoteIdentifier(channel)};`))
      if (promises.length >= 1000) {
        await Promise.all(promises)
        promises.length = 0
        this.checkEnded()
      }
    }
  }

  private async replayNotifies(client: Client): Promise<void> {
    for (let i = 0; i < this.notifyQueue.length; i++) {
      const notification = this.notifyQueue[i]
      if (!notification) continue
      if (notification.length === 2) {
        const [channel, payload] = notification
        await client.query(`SELECT pg_notify($1, $2)`, [channel, payload])
      } else {
        const [channel] = notification
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
    this.options.log?.debug('.handleNotification', { channel, rawPayload })
    const listeners = this.subs.get(channel)
    try {
      if (listeners) {
        if (rawPayload) {
          const payload = this.options.parse(rawPayload)
          for (const listener of listeners) listener(payload)
        } else {
          for (const listener of listeners) listener()
        }
      }
    } catch (error) {
      this.emit('error', error)
    }
  }

  private handleError: (error: Error) => void = (error: Error) => {
    this.options.log?.error(error)
    this.emit('error', error)
    this.reconnect().catch(() => {
      // ignore
    })
  }

  async notify(channel: string, payload?: T): Promise<void> {
    this.options.log?.debug('.notify', { channel, payload })
    this.checkEnded()
    this.checkLength(channel)
    const { client } = this
    if (payload) {
      const stringified = this.options.stringify(payload)
      const enqueue = () => {
        this.options.log?.debug('enqueuing', channel, stringified)
        this.notifyQueue.push([channel, stringified])
      }
      if (!client) enqueue()
      else
        await client
          .query(`SELECT pg_notify($1, $2)`, [channel, stringified])
          .catch((error) => {
            this.options.log?.error('NOTIFY failed:', error.stack)
            enqueue()
          })
    } else {
      const enqueue = () => {
        this.options.log?.debug('enqueuing', channel)
        this.notifyQueue.push([channel])
      }
      if (!client) enqueue()
      else
        await client
          .query(`NOTIFY ${quoteIdentifier(channel)}`)
          .catch((error) => {
            this.options.log?.error('NOTIFY failed:', error.stack)
            enqueue()
          })
    }
  }

  async listen(channel: string, listener: Listener<T>): Promise<void> {
    this.options.log?.debug('.listen', { channel, listener })
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
    this.options.log?.debug('.unlisten', { channel, listener })
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
