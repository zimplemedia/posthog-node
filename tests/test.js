const { spy, stub } = require('sinon')
const bodyParser = require('body-parser')
const express = require('express')
const delay = require('delay')
const pify = require('pify')
const test = require('ava')
const axios = require('axios')
const PostHog = require('../index')
const { version } = require('../package')
const { mockSimpleFlagResponse } = require('./assets/mockFlagsResponse')

const noop = () => {}

const port = 6042

const createClient = (options) => {
    options = Object.assign(
        {
            host: `http://localhost:${port}`,
        },
        options
    )

    const client = new PostHog('key', options)
    client.flush = pify(client.flush.bind(client))
    client.flushed = true

    return client
}

test.before.cb((t) => {
    express()
        .use(bodyParser.json())
        .post('/batch', (req, res) => {
            const { api_key: apiKey, batch } = req.body

            if (!apiKey) {
                return res.status(400).json({
                    error: { message: 'missing api key' },
                })
            }

            const ua = req.headers['user-agent']
            if (ua !== `posthog-node/${version}`) {
                return res.status(400).json({
                    error: { message: 'invalid user-agent' },
                })
            }

            if (batch[0] === 'error') {
                return res.status(400).json({
                    error: { message: 'error' },
                })
            }

            if (batch[0] === 'timeout') {
                return setTimeout(() => res.end(), 5000)
            }

            res.json({})
        })
        .get('/api/feature_flag', (req, res) => {
            const authorization = req.headers['authorization']
            const apiKey = authorization.replace('Bearer ', '')

            // if the personal api key with the value "my very secret key for error"
            // we return a 502 response
            if (apiKey.includes('my very secret key for error')) {
                return res.status(502).json({
                    error: { message: 'internal server error' },
                })
            }

            return res.status(200).json(mockSimpleFlagResponse)
        })
        .post('/decide', (req, res) => {
            return res.status(200).json({
                featureFlags: ['enabled-flag'],
            })
        })
        .listen(port, t.end)
})

let requestSpy = spy(axios, 'request')

test.afterEach(() => {
    requestSpy.resetHistory()
})

function callsDecide(expectedData) {
    const config = {
        method: 'POST',
        url: 'http://localhost:6042/decide/',
        headers: {
            'Content-Type': 'application/json',
            'user-agent': 'posthog-node/1.2.0',
        },
    }
    if (expectedData) {
        config.data = JSON.stringify(expectedData)
    }
    return requestSpy.calledWith(config)
}

test('expose a constructor', (t) => {
    t.is(typeof PostHog, 'function')
})

test('require a api key', (t) => {
    t.throws(() => new PostHog(), { message: "You must pass your PostHog project's api key." })
})

test('create a queue', (t) => {
    const client = createClient()

    t.deepEqual(client.queue, [])
})

test('default options', (t) => {
    const client = new PostHog('key')

    t.is(client.apiKey, 'key')
    t.is(client.host, 'https://app.posthog.com')
    t.is(client.flushAt, 20)
    t.is(client.flushInterval, 10000)
})

test('remove trailing slashes from `host`', (t) => {
    const client = new PostHog('key', { host: 'http://google.com///' })

    t.is(client.host, 'http://google.com')
})

test('overwrite defaults with options', (t) => {
    const client = new PostHog('key', {
        host: 'a',
        flushAt: 1,
        flushInterval: 2,
    })

    t.is(client.host, 'a')
    t.is(client.flushAt, 1)
    t.is(client.flushInterval, 2)
})

test('keep the flushAt option above zero', (t) => {
    const client = createClient({ flushAt: 0 })

    t.is(client.flushAt, 1)
})

test('enqueue - add a message to the queue', (t) => {
    const client = createClient()

    const timestamp = new Date()
    client.enqueue('type', { timestamp }, noop)

    t.is(client.queue.length, 1)

    const item = client.queue.pop()

    // t.is(typeof item.message.messageId, 'string')
    // t.regex(item.message.messageId, /node-[a-zA-Z0-9]{32}/)
    t.deepEqual(item, {
        message: {
            timestamp,
            library: 'posthog-node',
            library_version: version,
            type: 'type',
            // messageId: item.message.messageId
        },
        callback: noop,
    })
})

test("enqueue - don't modify the original message", (t) => {
    const client = createClient()
    const message = { event: 'test' }

    client.enqueue('type', message)

    t.deepEqual(message, { event: 'test' })
})

test('enqueue - flush on first message', (t) => {
    const client = createClient({ flushAt: 2 })
    client.flushed = false
    spy(client, 'flush')

    client.enqueue('type', {})
    t.true(client.flush.calledOnce)

    client.enqueue('type', {})
    t.true(client.flush.calledOnce)

    client.enqueue('type', {})
    t.true(client.flush.calledTwice)
})

test('enqueue - flush the queue if it hits the max length', (t) => {
    const client = createClient({
        flushAt: 1,
        flushInterval: null,
    })

    stub(client, 'flush')

    client.enqueue('type', {})

    t.true(client.flush.calledOnce)
})

test('enqueue - flush after a period of time', async (t) => {
    const client = createClient({ flushInterval: 10 })
    stub(client, 'flush')

    client.enqueue('type', {})

    t.false(client.flush.called)
    await delay(20)

    t.true(client.flush.calledOnce)
})

test("enqueue - don't reset an existing timer", async (t) => {
    const client = createClient({ flushInterval: 10 })
    stub(client, 'flush')

    client.enqueue('type', {})
    await delay(5)
    client.enqueue('type', {})
    await delay(5)

    t.true(client.flush.calledOnce)
})

test('enqueue - skip when client is disabled', async (t) => {
    const client = createClient({ enable: false })
    stub(client, 'flush')

    const callback = spy()
    client.enqueue('type', {}, callback)
    await delay(5)

    t.true(callback.calledOnce)
    t.false(client.flush.called)
})

test("flush - don't fail when queue is empty", async (t) => {
    const client = createClient()

    await t.notThrows(() => client.flush())
})

test('flush - send messages', async (t) => {
    const client = createClient({ flushAt: 2 })

    const callbackA = spy()
    const callbackB = spy()
    const callbackC = spy()

    client.queue = [
        {
            message: 'a',
            callback: callbackA,
        },
        {
            message: 'b',
            callback: callbackB,
        },
        {
            message: 'c',
            callback: callbackC,
        },
    ]

    const data = await client.flush()
    t.deepEqual(Object.keys(data), ['api_key', 'batch'])
    t.deepEqual(data.batch, ['a', 'b'])
    t.true(callbackA.calledOnce)
    t.true(callbackB.calledOnce)
    t.false(callbackC.called)
})

test('flush - respond with an error', async (t) => {
    const client = createClient()
    const callback = spy()

    client.queue = [
        {
            message: 'error',
            callback,
        },
    ]

    await t.throwsAsync(() => client.flush(), { message: 'Bad Request' })
})

test('flush - time out if configured', async (t) => {
    const client = createClient({ timeout: 500 })
    const callback = spy()

    client.queue = [
        {
            message: 'timeout',
            callback,
        },
    ]
    await t.throwsAsync(() => client.flush(), { message: 'timeout of 500ms exceeded' })
})

test('flush - skip when client is disabled', async (t) => {
    const client = createClient({ enable: false })
    const callback = spy()

    client.queue = [
        {
            message: 'test',
            callback,
        },
    ]

    await client.flush()

    t.false(callback.called)
})

test('identify - enqueue a message', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    const message = { distinctId: 'id', properties: { fish: 'swim in the sea' } }
    client.identify(message, noop)

    const apiMessage = {
        distinctId: 'id',
        $set: { fish: 'swim in the sea' },
        event: '$identify',
        properties: { $lib: 'posthog-node', $lib_version: version },
    }

    t.true(client.enqueue.calledOnce)
    t.deepEqual(client.enqueue.firstCall.args, ['identify', apiMessage, noop])
})

test('identify - require a distinctId or alias', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    t.throws(() => client.identify(), { message: 'You must pass a message object.' })
    t.throws(() => client.identify({}), { message: 'You must pass a "distinctId".' })
    t.notThrows(() => client.identify({ distinctId: 'id' }))
})

test('capture - enqueue a message', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    const message = {
        distinctId: '1',
        event: 'event',
    }
    const apiMessage = {
        distinctId: '1',
        properties: { $lib: 'posthog-node', $lib_version: version },
        event: 'event',
    }

    client.capture(message, noop)

    t.true(client.enqueue.calledOnce)
    t.deepEqual(client.enqueue.firstCall.args, ['capture', apiMessage, noop])
})

test('capture - enqueue a message with groups', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    const message = {
        distinctId: '1',
        event: 'event',
        groups: { company: 'id: 5' },
    }
    const apiMessage = {
        distinctId: '1',
        properties: { $groups: { company: 'id: 5' }, $lib: 'posthog-node', $lib_version: version },
        event: 'event',
    }

    client.capture(message, noop)

    t.true(client.enqueue.calledOnce)
    t.deepEqual(client.enqueue.firstCall.args, ['capture', apiMessage, noop])
})

test('capture - require event and either distinctId or alias', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    t.throws(() => client.capture(), { message: 'You must pass a message object.' })
    t.throws(() => client.capture({}), { message: 'You must pass a "distinctId".' })
    t.throws(() => client.capture({ distinctId: 'id' }), { message: 'You must pass an "event".' })
    t.notThrows(() => {
        client.capture({
            distinctId: 'id',
            event: 'event',
        })
    })
})

test('alias - enqueue a message', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    const message = {
        distinctId: 'id',
        alias: 'id',
    }
    const apiMessage = {
        properties: { distinct_id: 'id', alias: 'id', $lib: 'posthog-node', $lib_version: version },
        event: '$create_alias',
        distinct_id: 'id',
    }

    client.alias(message, noop)

    t.true(client.enqueue.calledOnce)
    t.deepEqual(client.enqueue.firstCall.args, ['alias', apiMessage, noop])
})

test('alias - require alias and distinctId', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    t.throws(() => client.alias(), { message: 'You must pass a message object.' })
    t.throws(() => client.alias({}), { message: 'You must pass a "distinctId".' })
    t.throws(() => client.alias({ distinctId: 'id' }), { message: 'You must pass a "alias".' })
    t.notThrows(() => {
        client.alias({
            distinctId: 'id',
            alias: 'id',
        })
    })
})

test('groupIdentify - enqueue a message', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    const message = {
        groupType: 'company',
        groupKey: 'id:5',
        properties: { foo: 'bar' },
    }
    const apiMessage = {
        properties: {
            $group_type: 'company',
            $group_key: 'id:5',
            $group_set: { foo: 'bar' },
            $lib: 'posthog-node',
            $lib_version: version,
        },
        event: '$groupidentify',
        distinctId: '$company_id:5',
    }

    client.groupIdentify(message, noop)

    t.true(client.enqueue.calledOnce)
    t.deepEqual(client.enqueue.firstCall.args, ['capture', apiMessage, noop])
})

test('groupIdentify - require groupType and groupKey', (t) => {
    const client = createClient()
    stub(client, 'enqueue')

    t.throws(() => client.groupIdentify(), { message: 'You must pass a message object.' })
    t.throws(() => client.groupIdentify({}), { message: 'You must pass a "groupType".' })
    t.throws(() => client.groupIdentify({ groupType: 'company' }), { message: 'You must pass a "groupKey".' })
    t.notThrows(() => {
        client.groupIdentify({
            groupType: 'company',
            groupKey: 'id:5',
        })
    })
})

test('isErrorRetryable', (t) => {
    const client = createClient()

    t.false(client._isErrorRetryable({}))

    // ETIMEDOUT is retryable as per `is-retry-allowed` (used by axios-retry in `isNetworkError`).
    t.true(client._isErrorRetryable({ code: 'ETIMEDOUT' }))

    // ECONNABORTED is not retryable as per `is-retry-allowed` (used by axios-retry in `isNetworkError`).
    t.false(client._isErrorRetryable({ code: 'ECONNABORTED' }))

    t.true(client._isErrorRetryable({ response: { status: 500 } }))
    t.true(client._isErrorRetryable({ response: { status: 429 } }))

    t.false(client._isErrorRetryable({ response: { status: 200 } }))
})

test('allows messages > 32 kB', (t) => {
    const client = createClient()

    const event = {
        distinctId: 1,
        event: 'event',
        properties: {},
    }
    for (var i = 0; i < 10000; i++) {
        event.properties[i] = 'a'
    }

    t.notThrows(() => {
        client.capture(event, noop)
    })
})

test('feature flags - require personalApiKey', async (t) => {
    const client = createClient()

    await t.throwsAsync(() => client.isFeatureEnabled('simpleFlag', 'some id'), {
        message: 'You have to specify the option personalApiKey to use feature flags.',
    })

    client.shutdown()
})

test('feature flags - require key, distinctId, defaultValue', async (t) => {
    const client = createClient({ personalApiKey: 'my very secret key' })

    await t.throwsAsync(() => client.isFeatureEnabled(), { message: 'You must pass a "key".' })
    await t.throwsAsync(() => client.isFeatureEnabled(null), { message: 'You must pass a "key".' })
    await t.throwsAsync(() => client.isFeatureEnabled('my-flag'), { message: 'You must pass a "distinctId".' })
    await t.throwsAsync(() => client.isFeatureEnabled('my-flag', 'some-id', 'default-value'), {
        message: '"defaultResult" must be a boolean.',
    })
    await t.throwsAsync(() => client.isFeatureEnabled('my-flag', 'some-id', false, 'foobar'), {
        message: 'You must pass an object for "groups".',
    })

    client.shutdown()
})

test.serial('feature flags - isSimpleFlag', async (t) => {
    const client = createClient({ personalApiKey: 'my very secret key' })

    const isEnabled = await client.isFeatureEnabled('simpleFlag', 'some id')

    t.is(isEnabled, true)
    t.is(callsDecide({ groups: {}, distinct_id: 'some id', token: 'key' }), false)

    client.shutdown()
})

test.serial('feature flags - complex flags', async (t) => {
    const client = createClient({ personalApiKey: 'my very secret key' })

    const expectedEnabledFlag = await client.isFeatureEnabled('enabled-flag', 'some id')
    const expectedDisabledFlag = await client.isFeatureEnabled('disabled-flag', 'some id')

    t.is(expectedEnabledFlag, true)
    t.is(expectedDisabledFlag, false)
    t.is(callsDecide({ groups: {}, distinct_id: 'some id', token: 'key' }), true)

    client.shutdown()
})

test.serial('feature flags - group analytics', async (t) => {
    const client = createClient({ personalApiKey: 'my very secret key' })

    const expectedEnabledFlag = await client.isFeatureEnabled('enabled-flag', 'some id', false, { company: 'id:5' })

    t.is(expectedEnabledFlag, true)
    t.is(callsDecide({ groups: { company: 'id:5' }, distinct_id: 'some id', token: 'key' }), true)

    client.shutdown()
})

test.serial('feature flags - default override', async (t) => {
    const client = createClient({ personalApiKey: 'my very secret key' })

    let flagEnabled = await client.isFeatureEnabled('i-dont-exist', 'some id')
    t.is(flagEnabled, false)

    flagEnabled = await client.isFeatureEnabled('i-dont-exist', 'some id', true)
    t.is(flagEnabled, true)

    client.shutdown()
})

test('feature flags - simple flag calculation', async (t) => {
    const client = createClient({ personalApiKey: 'my very secret key' })

    // This tests that the hashing + mathematical operations across libs are consistent
    let flagEnabled = client.featureFlagsPoller._isSimpleFlagEnabled({
        key: 'a',
        distinctId: 'b',
        rolloutPercentage: 42,
    })
    t.is(flagEnabled, true)

    flagEnabled = client.featureFlagsPoller._isSimpleFlagEnabled({ key: 'a', distinctId: 'b', rolloutPercentage: 40 })
    t.is(flagEnabled, false)

    client.shutdown()
})

test('feature flags - handles errrors when flag reloads', async (t) => {
    const client = createClient({ personalApiKey: 'my very secret key for error' })

    t.notThrows(() => client.featureFlagsPoller.loadFeatureFlags(true))

    client.shutdown()
})

test('feature flags - ignores logging errors when posthog:node is not set', async (t) => {
    t.is(process.env.DEBUG, undefined)

    const logger = spy(console, 'log')

    const client = createClient({ personalApiKey: 'my very secret key for error' })

    t.notThrows(() => client.featureFlagsPoller.loadFeatureFlags(true))

    t.is(logger.called, false)

    client.shutdown()
    logger.restore()
})
