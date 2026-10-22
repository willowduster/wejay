import { test, expect } from '@playwright/test'

async function fixtureInput(page) {
  await page.addInitScript(() => {
    globalThis.testAudioContexts = []
    const OriginalAudioContext = globalThis.AudioContext
    globalThis.AudioContext = class extends OriginalAudioContext {
      constructor(...args) { super(...args); globalThis.testAudioContexts.push(this) }
    }
    globalThis.testPeers = []
    const Original = globalThis.RTCPeerConnection
    globalThis.RTCPeerConnection = class extends Original {
      constructor(...args) { super(...args); globalThis.testPeers.push(this) }
    }
    navigator.mediaDevices.getUserMedia = async () => {
      if (!globalThis.testInput) {
        const context = new AudioContext({ sampleRate: 48000 })
        await context.resume()
        const buffer = context.createBuffer(2, 48000 * 8, 48000)
        for (let channel = 0; channel < 2; channel++) {
          const samples = buffer.getChannelData(channel)
          for (let index = 0; index < samples.length; index++) {
            const beat = (index / 48000) % 0.5
            samples[index] = 0.85 * Math.sin(2 * Math.PI * 90 * beat) * Math.exp(-beat * 22) + 0.08 * Math.sin(2 * Math.PI * (channel === 0 ? 330 : 660) * index / 48000)
          }
        }
        const source = context.createBufferSource()
        source.buffer = buffer
        source.loop = true
        const destination = context.createMediaStreamDestination()
        source.connect(destination)
        source.start()
        globalThis.testInput = { context, source, destination }
      }
      return globalThis.testInput.destination.stream.clone()
    }
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'fixture-interface', label: 'Test interface (120 BPM)' }]
  })
}

async function connectInput(page) {
  await page.getByRole('button', { name: 'Connect audio', exact: true }).click()
  await page.getByRole('button', { name: 'Connect stereo stream' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect stereo stream', exact: true })).toBeVisible()
}

test('idle booth remains flat, usable and free of playback controls on desktop and mobile', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'The Green Room' })).toBeVisible()
  await expect(page.locator('.channel')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Your stereo master' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Stereo streams 0 / 4' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(play|cue|sync|crossfade)$/i })).toHaveCount(0)
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('.bpm-value').first()).toContainText('BPM')
    expect(await page.locator('.channel').first().evaluate(element => element.getBoundingClientRect().width > 200)).toBe(true)
  }
})

test('live input detects 120 BPM, renders real spectrum and clears tempo on silence', async ({ page }) => {
  await fixtureInput(page)
  await page.goto('/')
  await connectInput(page)
  await expect(page.locator('.bpm-value.has-bpm').first()).toHaveText('120.0BPM', { timeout: 45000 })
  expect(await page.locator('canvas').first().evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let signalPixels = 0
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 150 && pixels[index + 1] > 70 && pixels[index + 3] > 100) signalPixels++
    return signalPixels > 100
  })).toBe(true)
  await page.evaluate(() => globalThis.testInput.source.stop())
  await expect(page.locator('.bpm-value.has-bpm')).toHaveCount(0, { timeout: 10000 })
  await page.getByRole('button', { name: 'Disconnect stereo stream' }).click()
  await expect(page.locator('.channel.active')).toHaveCount(0)
})

test('account host and account-free guest exchange audio, auto BPM, chat and room locks', async ({ page, context, browser }) => {
  await fixtureInput(page)
  const response = await context.request.post('/api/auth/register', { data: { name: 'Browser Host', email: `test-${Date.now()}@example.invalid`, password: 'test-only-password-2026' } })
  expect(response.status()).toBe(201)
  await page.goto('/')
  await expect(page.locator('.account-button')).toContainText('Browser Host')
  await page.getByRole('button', { name: 'Create room', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Create room', exact: true }).last().click()
  await expect(page.locator('.room-badge')).toHaveText('LIVE ROOM')
  const code = new URL(page.url()).searchParams.get('room')
  await connectInput(page)
  const guestContext = await browser.newContext({ baseURL: 'http://localhost:5173' })
  const guest = await guestContext.newPage()
  const events = []
  guest.on('console', event => { if (event.type() === 'error') events.push(event.text()) })
  guest.on('pageerror', error => events.push(error.message))
  try {
    await fixtureInput(guest)
    await guest.goto(`/?room=${code}`)
    await guest.getByLabel('Your DJ name').fill('Guest Selector')
    await guest.getByRole('button', { name: 'Join the booth', exact: true }).click()
    await expect(guest.locator('.room-badge')).toHaveText('LIVE ROOM')
    await expect(guest.locator('.account-button')).toContainText('Guest DJ')
    await expect(guest.locator('.member-row')).toHaveCount(2)
    try {
      await expect(guest.locator('.channel.active'), JSON.stringify(events)).toHaveCount(1, { timeout: 20000 })
      await expect(guest.locator('.bpm-value.has-bpm').first(), JSON.stringify(events)).toHaveText('120.0BPM', { timeout: 45000 })
    }
    catch (error) {
      for (const [name, client] of [['host', page], ['guest', guest]]) console.log('PEER_DIAGNOSTIC', JSON.stringify(await client.evaluate(async name => { const { audio } = await import('/src/audio.js'); return { name, audio: audio.context?.state, remote: [...audio.remote.values()].map(entry => ({ sample: audio.sample(entry), bpm: entry.lastBpm, detector: !!entry.detector })), inputs: [...audio.inputs.values()].map(entry => ({ sample: audio.sample(entry), bpm: entry.lastBpm })), peers: await Promise.all(globalThis.testPeers.map(async peer => ({ connection: peer.connectionState, signaling: peer.signalingState, stats: [...(await peer.getStats()).values()].filter(item => item.type === 'inbound-rtp' || item.type === 'outbound-rtp').map(item => ({ type: item.type, bytes: item.bytesReceived || item.bytesSent, audioLevel: item.audioLevel, samples: item.totalSamplesReceived })), transceivers: peer.getTransceivers().map(item => ({ mid: item.mid, direction: item.currentDirection, track: item.sender.track?.readyState, receiver: item.receiver.track?.readyState, muted: item.receiver.track?.muted })) }))), toast: document.querySelector('.toast')?.textContent } }, name)))
      throw error
    }
    const peerStats = await guest.evaluate(async () => {
      const stats = await globalThis.testPeers[0].getStats()
      const inbound = [...stats.values()].filter(item => item.type === 'inbound-rtp' && item.kind === 'audio')
      return inbound.reduce((sum, item) => sum + item.bytesReceived, 0)
    })
    expect(peerStats).toBeGreaterThan(0)
    await expect.poll(() => guest.evaluate(() => {
      const context = globalThis.testAudioContexts.find(value => value.state === 'running')
      if (!context) return false
      if (!globalThis.testStereo) {
        const track = globalThis.testPeers[0].getReceivers()[0]?.track
        if (!track) return false
        const source = context.createMediaStreamSource(new MediaStream([track]))
        const splitter = context.createChannelSplitter(2)
        const analysers = [context.createAnalyser(), context.createAnalyser()]
        const silence = context.createGain()
        silence.gain.value = 0
        silence.connect(context.destination)
        source.connect(splitter)
        analysers.forEach((analyser, channel) => { analyser.fftSize = 4096; splitter.connect(analyser, channel); analyser.connect(silence) })
        globalThis.testStereo = { source, splitter, analysers, silence }
      }
      const powers = globalThis.testStereo.analysers.map(analyser => {
        const spectrum = new Float32Array(analyser.frequencyBinCount)
        analyser.getFloatFrequencyData(spectrum)
        return [330, 660].map(frequency => spectrum[Math.round(frequency * analyser.fftSize / context.sampleRate)])
      })
      return powers[0][0] > powers[0][1] + 10 && powers[1][1] > powers[1][0] + 10
    }), { message: 'Stereo must preserve distinct left/right test tones', timeout: 10000 }).toBe(true)
    for (const client of [page, guest]) {
      expect(await client.evaluate(() => globalThis.testPeers[0].getTransceivers().length)).toBe(1)
    }
    await connectInput(guest)
    await expect(page.locator('.channel.active')).toHaveCount(2)
    await expect(page.locator('.bpm-value.has-bpm')).toHaveCount(2, { timeout: 45000 })
    await guest.getByRole('textbox', { name: 'Message the booth' }).fill('Ready to spin')
    await guest.getByRole('button', { name: 'Send message' }).click()
    await expect(page.locator('.chat-messages')).toContainText('Ready to spin')
    await page.getByRole('button', { name: 'Booth settings' }).click()
    await page.getByRole('switch', { name: 'Allow new DJs' }).click()
    await expect(guest.locator('.room-access')).toContainText('Room is locked')
    const denied = await guestContext.request.post(`/api/rooms/${code}/join`, { data: { name: 'New DJ' } })
    expect(denied.status()).toBe(403)
  } finally { await guestContext.close() }
})