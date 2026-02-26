import { describe, it } from 'mocha'
import { expect } from 'chai'
import { Client } from 'pg'
import PgIpc, { PgIpcOptions } from '../src'
import EventEmitter from 'events'
import emitted from 'p-event'
// @ts-expect-error no type defs
import { createProxy } from 'node-tcp-proxy'
import assert from 'assert'
import { inspect } from 'util'
// @ts-expect-error no type defs
import execa from '@jcoreio/toolchain/util/execa.cjs'
import defaultenv from 'defaultenv'

let pgPort = parseInt(process.env.DB_PORT || '5432')
const DEBUG = /(^|\b)pg-ipc(\b|$)/.test(process.env.DEBUG || '')

class MockClient extends EventEmitter {
  ended = false
  deferConnect: boolean
  rejectConnect: boolean
  rejectQuery: boolean
  queries: [query: string, params?: unknown[]][] = []

  connectPromise:
    | undefined
    | {
        resolve: () => void
        reject: (error: Error) => void
      }

  constructor({
    deferConnect = false,
    rejectConnect = false,
    rejectQuery = false,
  }: {
    deferConnect?: boolean
    rejectConnect?: boolean
    rejectQuery?: boolean
  } = {}) {
    super()
    this.deferConnect = deferConnect
    this.rejectConnect = rejectConnect
    this.rejectQuery = rejectQuery
  }

  checkEnded() {
    if (this.ended) throw new Error(`MockClient already ended`)
  }

  async connect() {
    this.checkEnded()
    this.emit('connecting', this)
    if (this.deferConnect) {
      await new Promise<void>(
        (resolve, reject) => (this.connectPromise = { resolve, reject })
      )
    }
    if (this.rejectConnect) {
      const error = new Error('connection failed')
      this.emit('error', error)
      this.end().catch(() => {
        /**/
      })
      throw error
    } else {
      this.emit('connected', this)
      this.emit('ready')
    }
  }
  async end() {
    this.checkEnded()
    this.ended = true
    this.emit('end')
  }
  async query(...args: [query: string, params?: unknown[]]) {
    if (this.rejectQuery) {
      const error = new Error('connection failed')
      this.emit('error', error)
      this.end().catch(() => {
        /**/
      })
      throw error
    }
    this.queries.push(args)
    this.emit('query', ...args)
  }
}

async function during<R>(p: Promise<R>, ...effects: (() => any)[]): Promise<R> {
  const teardown = effects.map((e) => e())
  return p.finally(() => {
    for (const c of teardown) {
      if (typeof c === 'function') c()
    }
  })
}

function forbidEvent(
  e: EventEmitter,
  name: string,
  { filter = () => true }: { filter?: (...args: any[]) => boolean } = {}
): () => () => void {
  return () => {
    let event: any = null
    const handler = (...args: any[]) => {
      if (filter(...args)) event = args
    }
    e.on(name, handler)
    return () => {
      e.off(name, handler)
      if (event) {
        throw new Error(
          `expected ${inspect(e)} not to emit ${name}, but got ${JSON.stringify(event)}`
        )
      }
    }
  }
}

before(async () => {
  if (process.env.CI) return
  defaultenv(['env/local.js'])
  pgPort = parseInt(process.env.DB_PORT || '5432')
  await execa('docker', ['compose', 'up', '-d'], { stdio: 'inherit' })
})

describe('PgIpc', function () {
  this.timeout(5000)

  const teardown: (() => any)[] = []

  afterEach(async () => {
    try {
      await Promise.all(teardown.map((t) => t()))
    } finally {
      teardown.length = 0
    }
  })

  const newClient = ({ port = pgPort }: { port?: number } = {}) => {
    const client = new Client({
      host: 'localhost',
      port,
      user: 'postgres',
      password: 'password',
      database: 'postgres',
    })
    let ended = false
    teardown.push(async () => {
      if (!ended) await client.end()
    })
    client.once('end', () => (ended = true))
    return client
  }

  const newIpc = (options: PgIpcOptions) => {
    const ipc = new PgIpc({ log: DEBUG ? console : undefined, ...options })
    let ended = false
    ipc.once('end', () => (ended = true))
    teardown.push(async () => {
      if (!ended) await ipc.end()
    })
    return ipc
  }

  const newProxy = (from: number, toHost: string, toPort: number) => {
    const proxy = createProxy(from, toHost, toPort)
    let ended = false
    teardown.push(async () => {
      if (!ended) proxy.end()
    })
    return Object.create(proxy, {
      end: {
        value: () => {
          ended = true
          return proxy.end()
        },
      },
    })
  }

  it(`options validation`, async function () {
    const newClient = () => new MockClient()

    for (const maxChannelLength of [NaN, -Infinity, Infinity, -1, 0]) {
      expect(() => newIpc({ newClient, maxChannelLength })).to.throw(
        'options.maxChannelLength must be an integer > 0 if given'
      )
    }
    for (const initialDelay of [NaN, -Infinity, Infinity, -1, 0]) {
      expect(() => newIpc({ newClient, reconnect: { initialDelay } })).to.throw(
        'options.reconnect.initialDelay must be a finite number > 0 if given'
      )
    }
    for (const maxDelay of [NaN, -Infinity, Infinity, -1, 0]) {
      expect(() => newIpc({ newClient, reconnect: { maxDelay } })).to.throw(
        'options.reconnect.maxDelay must be a finite number > 0 if given'
      )
    }
    for (const maxRetries of [NaN, -Infinity, Infinity, -1, 0, 1.1]) {
      expect(() => newIpc({ newClient, reconnect: { maxRetries } })).to.throw(
        'options.reconnect.maxRetries must be an integer > 0 if given'
      )
    }
    for (const factor of [NaN, -Infinity, Infinity, -1, 0, 1]) {
      expect(() => newIpc({ newClient, reconnect: { factor } })).to.throw(
        'options.reconnect.factor must be a finite number > 1 if given'
      )
    }
    await newIpc({
      newClient,
      maxChannelLength: 127,
      reconnect: {
        initialDelay: 1,
        maxDelay: 1,
        maxRetries: 1,
        factor: 1.1,
      },
    }).end()
  })
  it(`channel length validation`, async function () {
    const ipc = newIpc({ newClient })
    await expect(
      ipc.listen('a'.repeat(64), () => {
        /* no-op */
      })
    ).to.be.rejected
    await expect(ipc.notify('a'.repeat(64), 'a')).to.be.rejected

    const ipc2 = newIpc({ newClient, maxChannelLength: 127 })
    await ipc2.notify('a'.repeat(127), 'a')
    await expect(ipc2.notify('a'.repeat(128), 'a')).to.be.rejected
  })
  it(`doesn't allow any actions after .end`, async function () {
    const ipc = newIpc({ newClient: () => new MockClient() })
    await ipc.end()
    await expect(ipc.end()).to.be.rejected
    await expect(ipc.connect()).to.be.rejected
    await expect(
      ipc.listen('a', () => {
        /* no-op */
      })
    ).to.be.rejected
    await expect(
      ipc.unlisten('a', () => {
        /* no-op */
      })
    ).to.be.rejected
    await expect(ipc.notify('a', 'a')).to.be.rejected
  })
  it('basic test', async function () {
    const emitter = new EventEmitter()
    const ipc = newIpc({ newClient })
    await ipc.listen('foo', (...args) => emitter.emit('foo', ...args))
    await ipc.listen('bar', (...args) => emitter.emit('bar', ...args))

    const payload = { a: 1 }
    const [actual] = await Promise.all([
      emitted(emitter, 'foo', { multiArgs: true }),
      ipc.notify('foo', payload),
    ])
    expect(actual).to.deep.equal(['foo', payload])

    const payload2 = { a: 2 }
    const [actual2] = await during(
      Promise.all([
        emitted(emitter, 'bar', { multiArgs: true }),
        ipc.notify('bar', payload2),
      ]),
      forbidEvent(emitter, 'foo')
    )
    expect(actual2).to.deep.equal(['bar', payload2])
  })
  it(`payloadless notifications`, async function () {
    const emitter = new EventEmitter()
    const ipc = newIpc({ newClient })
    await ipc.listen('foo', (...args) => emitter.emit('foo', ...args))

    const [actual] = await Promise.all([
      emitted(emitter, 'foo', { multiArgs: true }),
      ipc.notify('foo'),
    ])
    expect(actual).to.deep.equal(['foo'])
  })
  it(`restores listeners after connect`, async function () {
    const emitter = new EventEmitter()
    const proxy = newProxy(pgPort + 1, 'localhost', pgPort)
    const ipc = newIpc({
      newClient: () => newClient({ port: pgPort + 1 }),
    })
    await ipc.listen('foo', (...args) => emitter.emit('foo', ...args))

    await emitted(ipc, 'ready')
    await Promise.all([emitted(ipc, 'disconnected'), proxy.end()])
    newProxy(pgPort + 1, 'localhost', pgPort)

    const payload = { a: 1 }
    const [actual] = await Promise.all([
      emitted(emitter, 'foo', { multiArgs: true }),
      ipc.notify('foo', payload),
    ])
    expect(actual).to.deep.equal(['foo', payload])
  })
  it(`multiple listeners on same topic`, async function () {
    let client: MockClient | undefined
    const ipc = newIpc({
      newClient: () => (client = new MockClient()),
    })

    const emitter = new EventEmitter()
    const f1 = (...args: [channel: string, message?: string]) =>
      emitter.emit('f1', ...args)
    const f2 = (...args: [channel: string, message?: string]) =>
      emitter.emit('f2', ...args)

    assert(client)
    await Promise.all([
      emitted(client, 'query', {
        filter: (q) => q.startsWith(`LISTEN """foo"`),
      }),
      ipc.listen('"foo', f1),
    ])
    await during(ipc.listen('"foo', f2), forbidEvent(client, 'query'))
    const payload = { a: 1 }
    await Promise.all([
      emitted(emitter, 'f1'),
      emitted(emitter, 'f2'),
      // eslint-disable-next-line @typescript-eslint/await-thenable
      client.emit('notification', {
        channel: '"foo',
        payload: JSON.stringify(payload),
      }),
    ])
    await during(ipc.unlisten('"foo', f1), forbidEvent(client, 'query'))
    await during(ipc.unlisten('"foo', f1), forbidEvent(client, 'query'))
    await during(
      Promise.all([
        emitted(emitter, 'f2'),
        // eslint-disable-next-line @typescript-eslint/await-thenable
        client.emit('notification', {
          channel: '"foo',
          payload: JSON.stringify(payload),
        }),
      ]),
      forbidEvent(emitter, 'f1')
    )
    await Promise.all([
      emitted(client, 'query', {
        filter: (q) => q.startsWith(`UNLISTEN """foo"`),
      }),
      ipc.unlisten('"foo', f2),
    ])
  })
  it(`notification after end`, async function () {
    let client: MockClient | undefined
    const ipc = newIpc({
      newClient: () => (client = new MockClient()),
    })
    assert(client)
    await ipc.end()
    await during(
      (async () => {
        client.emit('notification', { channel: 'a', payload: '{}' })
        await new Promise((resolve) => setTimeout(resolve, 1000))
      })(),
      forbidEvent(ipc, 'error')
    )
  })
  it(`connection backoff`, async function () {
    const ipc = newIpc({
      newClient: () => new MockClient({ rejectConnect: true }),
      reconnect: {
        initialDelay: 100,
      },
    })

    let t = Date.now()
    await emitted(ipc, 'connecting')
    expect(Date.now() - t).to.be.closeTo(100, 10)
    t = Date.now()
    await emitted(ipc, 'connecting')
    expect(Date.now() - t).to.be.closeTo(200, 20)
    t = Date.now()
    await emitted(ipc, 'connecting')
    expect(Date.now() - t).to.be.closeTo(400, 40)
  })
  it(`maxRetries`, async function () {
    const ipc = newIpc({
      newClient: () => new MockClient({ rejectConnect: true }),
      reconnect: {
        maxRetries: 3,
        initialDelay: 10,
      },
    })

    await expect(emitted(ipc, 'ready')).to.be.rejectedWith(
      /all 3 connect attempts failed/
    )
  })
  it(`error thrown by listener`, async function () {
    const ipc = newIpc({ newClient })
    await ipc.listen('foo', () => {
      throw new Error('listener')
    })
    const [error] = await Promise.all([
      emitted(ipc, 'error'),
      ipc.notify('foo', {}),
    ])
    expect(error.message).to.equal('listener')
  })
  it(`stringify/parse`, async function () {
    const emitter = new EventEmitter()
    const ipc = newIpc({ newClient, stringify: (s) => s, parse: (s) => s })
    await ipc.listen('foo', (...args) => emitter.emit('foo', ...args))
    const expected = '{teszt}'
    await Promise.all([
      emitted(emitter, 'foo', {
        multiArgs: true,
        filter: ([channel, payload]) =>
          channel === 'foo' && payload === expected,
      }),
      ipc.notify('foo', expected),
    ])
  })
  it(`replays failed notify after connect`, async function () {
    let connectCount = 0
    let client: MockClient | undefined
    const ipc = newIpc({
      newClient: () =>
        (client = new MockClient({
          deferConnect: true,
          rejectQuery: connectCount++ === 0,
        })),
    })
    assert(client)
    if (!client.connectPromise) await emitted(client, 'connecting')
    client.connectPromise?.resolve()
    await emitted(ipc, 'ready')
    ;[client] = await Promise.all([
      emitted(ipc, 'connecting'),
      ipc.notify('foo', { foo: 1 }),
    ])
    assert(client)
    await Promise.all([
      // eslint-disable-next-line @typescript-eslint/await-thenable
      client.connectPromise?.resolve(),
      emitted(client, 'query', {
        multiArgs: true,
        filter: ([, vars]) => vars[0] === 'foo',
      }),
    ])
  })
  it(`replays failed payloadless notify after connect`, async function () {
    let connectCount = 0
    let client: MockClient | undefined
    const ipc = newIpc({
      newClient: () =>
        (client = new MockClient({
          deferConnect: true,
          rejectQuery: connectCount++ === 0,
        })),
    })
    assert(client)
    if (!client.connectPromise) await emitted(client, 'connecting')
    client.connectPromise?.resolve()
    await emitted(ipc, 'ready')
    ;[client] = await Promise.all([
      emitted(ipc, 'connecting'),
      ipc.notify('foo'),
    ])
    assert(client)
    await Promise.all([
      // eslint-disable-next-line @typescript-eslint/await-thenable
      client.connectPromise?.resolve(),
      emitted(client, 'query', {
        filter: (query) => query.includes('foo'),
      }),
    ])
  })
})
