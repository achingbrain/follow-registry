'use strict'

const log = require('debug')('follow-registry')
const request = require('./request')
const createSeq = require('./seq.js')
const downloadManifest = require('./download-manifest')
const parallelBatch = require('it-parallel-batch')
const delay = require('delay')
const AbortController = require('abort-controller')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')

const fsSeqFile = () => {
  const seqFile = path.join(os.tmpdir(), 'registry-follow-seq.txt')

  return {
    async read () {
      try {
        return fs.readFile(seqFile, 'utf8')
      } catch (err) {
        log(err)
        return 0
      }
    },
    async write (data) {
      await fs.writeFile(seqFile, data, 'utf8')
    },
    async reset () {
      await fs.unlink(seqFile)
    }
  }
}

const defaultConfig = {
  ua: 'npm-registry-follower',
  replicator: 'https://replicate.npmjs.com/registry/_changes',
  registry: 'https://registry.npmjs.com',
  concurrency: 50,
  inactivityTimeout: 3600000,
  inactivityBackoff: 5000,
  metadataRetries: 5,
  metadataRetryBackoff: 5000,
  since: undefined,
  seq: fsSeqFile()
}

async function * streamChanges (config) {
  if (config.signal && config.signal.aborted) {
    return
  }

  while (true) {
    try {
      const resource = `${config.replicator}?${new URLSearchParams({
        since: await config.seq.read(),
        feed: 'continuous',
        heartbeat: 30000
      })}`

      log('fetching', resource)

      const controller = new AbortController()

      // abort if we don't receive updates for a while
      let timeout = setTimeout(() => {
        controller.abort()
      }, config.inactivityTimeout)
      timeout.unref()

      const response = await request(resource, {
        headers: {
          'user-agent': config.ua
        },
        signal: controller.signal
      })

      for await (const change of response.ndjson()) {
        if (!change.seq || !change.id) {
          log('Invalid change', change)
          continue
        }

        // update inactivity timeout
        clearTimeout(timeout)
        timeout = setTimeout(() => {
          controller.abort()
        }, config.inactivityTimeout)
        timeout.unref()

        // start processing
        const seq = change.seq
        config.seq.start(seq)

        yield async () => {
          return {
            packument: await downloadManifest(change, config.metadataRetries, config),
            seq,
            done: () => {
              log('writing seq', seq)
              return config.seq.finish(seq)
            }
          }
        }
      }
    } catch (err) {
      log(`Request error ${err}`)
      await delay(config.inactivityBackoff)
    }
  }
}

async function * followRegistry (config = {}) {
  config = {
    ...defaultConfig,
    ...config
  }

  config.seq = await createSeq(config)

  yield * parallelBatch(streamChanges(config), config.concurrency)
}

module.exports = followRegistry

module.exports.reset = async (config) => {
  config = {
    ...defaultConfig,
    ...config
  }

  config.seq = await createSeq(config)

  return config.seq.reset()
}

module.exports.seq = async (config) => {
  config = {
    ...defaultConfig,
    ...config
  }

  config.seq = await createSeq(config)

  return config.seq.read()
}
