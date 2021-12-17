/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { Client } from 'pg'
import PgIpc from '../src'
import EventEmitter from 'events'
import emitted from 'p-event'

class MockClient extends EventEmitter {
  ended = false
  queries = []

  checkEnded() {
    if (this.ended) throw new Error(`MockClient already ended`)
  }

  async connect() {
    this.checkEnded()
    this.emit('connect')
  }
  async end() {
    this.checkEnded()
    this.emit('end')
  }
  async query(...args) {
    this.queries.push(args)
    this.emit('query', ...args)
  }
}

async function during<R>(p: Promise<R>, ...effects: (() => any)[]): Promise<R> {
  const cleanup = effects.map((e) => e())
  return p.finally(() => {
    for (const c of cleanup) {
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
    let event = null
    const handler = (...args: any[]) => {
      if (filter(...args)) event = args
    }
    e.on(name, handler)
    return () => {
      e.off(name, handler)
      if (event) {
        throw new Error(
          `expected ${e} not to emit ${name}, but got ${JSON.stringify(event)}`
        )
      }
    }
  }
}

describe('PgIpc', function () {
  this.timeout(5000)

  const clients = new Set()
  const ipcs = new Set()

  afterEach(async () => {
    try {
      await Promise.all([
        ...[...clients].map((c) => c.end()),
        ...[...ipcs].map((i) => i.end()),
      ])
    } finally {
      clients.clear()
      ipcs.clear()
    }
  })

  const newClient = () => {
    const client = new Client({
      host: 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      user: 'postgres',
      password: 'password',
      database: 'postgres',
    })
    clients.add(client)
    return Object.create(client, {
      end: {
        value: () => {
          clients.delete(client)
          return client.end()
        },
      },
    })
  }

  class TestIpc extends PgIpc {
    end() {
      ipcs.delete(this)
      return super.end()
    }
  }

  const newIpc = (options: PgIpcOptions) => {
    const ipc = new TestIpc(options)
    ipcs.add(ipc)
    return ipc
  }

  it(`options validation`, async function () {
    const newClient = () => new MockClient()

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
  })
  it(`doesn't allow any actions after .end`, async function () {
    const ipc = newIpc({ newClient: new MockClient() })
    await ipc.end()
    await expect(ipc.end()).to.be.rejected
    await expect(ipc.reconnect()).to.be.rejected
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
    const ipc = newIpc({ newClient, log: console })
    ipc.listen('foo', (payload) => emitter.emit('foo', payload))
    ipc.listen('bar', (payload) => emitter.emit('bar', payload))

    const payload = { a: 1 }
    const [actual] = await Promise.all([
      emitted(emitter, 'foo'),
      ipc.notify('foo', payload),
    ])
    expect(actual).to.deep.equal(payload)

    const payload2 = { a: 2 }
    const [actual2] = await Promise.all([
      Promise.race([
        emitted(emitter, 'bar'),
        emitted(emitter, 'foo').then(() =>
          Promise.reject('expected foo listener not to be called')
        ),
      ]),
      ipc.notify('bar', payload2),
    ])
    expect(actual2).to.deep.equal(payload2)
  })
  it(`payloadless notifications`, async function () {
    const emitter = new EventEmitter()
    const ipc = newIpc({ newClient, log: console })
    ipc.listen('foo', (payload) => emitter.emit('foo', payload))

    const [actual] = await Promise.all([
      emitted(emitter, 'foo'),
      ipc.notify('foo'),
    ])
    expect(actual).to.equal(undefined)
  })
  it(`restores listeners after reconnect`, async function () {
    const emitter = new EventEmitter()
    let client
    const ipc = newIpc({
      newClient: () => (client = newClient()),
      log: console,
    })
    ipc.listen('foo', (payload) => emitter.emit('foo', payload))

    await emitted(ipc, 'ready')
    await Promise.all([
      emitted(ipc, 'error'),
      (async () => {
        await client.end()
        client.emit('error', new Error('fake'))
      })(),
    ])

    const payload = { a: 1 }
    const [actual] = await Promise.all([
      emitted(emitter, 'foo'),
      ipc.notify('foo', payload),
    ])
    expect(actual).to.deep.equal(payload)
  })
  it(`multiple listeners on same topic`, async function () {
    let client
    const ipc = newIpc({
      newClient: () => (client = new MockClient()),
      log: console,
    })

    const emitter = new EventEmitter()
    const f1 = (payload) => emitter.emit('f1', payload)
    const f2 = (payload) => emitter.emit('f2', payload)

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
    let client
    const ipc = newIpc({
      newClient: () => (client = new MockClient()),
      log: console,
    })
    await ipc.end()
    await during(
      (async () => {
        client.emit('notification', { channel: 'a', payload: '{}' })
        await new Promise((resolve) => setTimeout(resolve, 1000))
      })(),
      forbidEvent(ipc, 'error')
    )
  })
})
