import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveAudio, normalizeBpm, frequencyBands } from '../src/audio.js'

test('capture requests one stereo track and rejects a second independent stream', async t => {
  let constraints
  const track = { getSettings: () => ({ channelCount: 2 }), addEventListener() {}, stop() {} }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async value => { constraints = value; return stream } } } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator })
  const live = new LiveAudio()
  live.context = { createMediaStreamSource: () => ({}) }
  live.init = async () => live.context
  live.analyze = () => ({})
  const entry = await live.capture(0, 'stereo-interface')
  assert.equal(entry.stream, stream)
  assert.deepEqual(constraints.audio.channelCount, { exact: 2 })
  assert.equal(constraints.audio.echoCancellation, false)
  assert.equal(live.inputs.size, 1)
  await assert.rejects(() => live.capture(1, 'another-interface'), /one stereo master stream/)
  let stopped = false
  track.getSettings = () => ({ channelCount: 1 })
  track.stop = () => { stopped = true }
  await assert.rejects(() => live.capture(0, 'mono-interface'), /input is mono/)
  assert.equal(stopped, true)
  assert.equal(live.inputs.get(0), entry)
})

test('BPM selects strongest candidate and normalizes octave ambiguity', () => {
  assert.deepEqual(normalizeBpm([{ tempo: 62, count: 8 }, { tempo: 90, count: 2 }]), { bpm: 124, confidence: 0.8 })
  assert.equal(normalizeBpm([{ tempo: 256, count: 4 }]).bpm, 128)
  assert.equal(normalizeBpm([]), null)
  assert.equal(normalizeBpm([{ tempo: NaN, count: 1 }, { tempo: 0, count: 4 }]), null)
})

test('three-band analysis is silent for silent input and bounded for signal', () => {
  assert.deepEqual(frequencyBands(new Uint8Array(1024), 48000, 2048), [0, 0, 0])
  assert.deepEqual(frequencyBands(new Uint8Array(1024).fill(255), 48000, 2048), [1, 1, 1])
  const bins = new Uint8Array(1024)
  bins[3] = 255
  const bands = frequencyBands(bins, 48000, 2048)
  assert.ok(bands[0] > 0)
  assert.equal(bands[1], 0)
  assert.equal(bands[2], 0)
})