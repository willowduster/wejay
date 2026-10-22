export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function normalizeBpm(candidates = []) {
  const sorted = candidates.filter(item => Number.isFinite(item.tempo) && item.tempo > 0 && item.count > 0).sort((left, right) => right.count - left.count)
  if (!sorted.length) return null
  let tempo = sorted[0].tempo
  while (tempo < 70) tempo *= 2
  while (tempo > 180) tempo /= 2
  const total = sorted.reduce((sum, item) => sum + item.count, 0)
  return { bpm: Math.round(tempo * 10) / 10, confidence: clamp(sorted[0].count / total, 0, 1) }
}

export function frequencyBands(bins, sampleRate, fftSize) {
  const result = [0, 0, 0], counts = [0, 0, 0]
  for (let index = 1; index < bins.length; index++) {
    const frequency = index * sampleRate / fftSize
    const band = frequency < 250 ? 0 : frequency < 2500 ? 1 : 2
    result[band] += (bins[index] / 255) ** 2
    counts[band]++
  }
  return result.map((sum, index) => Math.sqrt(sum / Math.max(1, counts[index])))
}

export class LiveAudio {
  constructor() { this.context = null; this.inputs = new Map(); this.remote = new Map(); this.listening = false }

  async init() {
    if (!this.context) this.context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
    await this.context.resume()
    return this.context
  }

  async devices() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Audio capture needs HTTPS or localhost in a supported browser.')
    const permission = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    permission.getTracks().forEach(track => track.stop())
    return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')
  }

  async capture(slot, deviceId, onBpm, onEnded, onError) {
    if (slot !== 0) throw new Error('Each DJ supplies one stereo master stream.')
    await this.init()
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: { exact: 2 }, sampleRate: { ideal: 48000 }, latency: { ideal: 0 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false })
    if (stream.getAudioTracks()[0]?.getSettings().channelCount === 1) {
      stream.getTracks().forEach(track => track.stop())
      throw new Error('This input is mono. Select a stereo master output from your mixer or audio interface.')
    }
    this.stop(slot)
    const source = this.context.createMediaStreamSource(stream)
    const entry = Object.assign(this.analyze(source, onBpm, onError), { stream, source, deviceId })
    this.inputs.set(slot, entry)
    stream.getAudioTracks()[0].addEventListener('ended', onEnded)
    return entry
  }

  analyze(source, onBpm, onError) {
    const analyser = this.context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.55
    source.connect(analyser)
    const silence = this.context.createGain()
    silence.gain.value = 0
    analyser.connect(silence).connect(this.context.destination)
    const entry = { analyser, silence, detector: null, closed: false, lastSignal: 0, lastBpm: null }
    import('realtime-bpm-analyzer').then(async ({ createRealtimeBpmAnalyzer }) => {
      if (entry.closed) return
      const detector = await createRealtimeBpmAnalyzer(this.context, { continuousAnalysis: true, stabilizationTime: 10000 })
      if (entry.closed) { detector.disconnect(); return }
      entry.detector = detector
      analyser.connect(detector.node)
      detector.node.connect(silence)
      const update = (data, stable) => {
        const value = normalizeBpm(data.bpm)
        if (value && performance.now() - entry.lastSignal < 2500) {
          entry.lastBpm = { ...value, stable, detectedAt: performance.now() }
          onBpm?.(entry.lastBpm)
        }
      }
      detector.on('bpm', data => update(data, false))
      detector.on('bpmStable', data => update(data, true))
      detector.on('error', event => onError?.(event.message))
    }).catch(error => onError?.(`BPM analysis unavailable: ${error.message}`))
    return entry
  }

  async addRemote(key, stream, onBpm, onError) {
    await this.init()
    this.removeRemote(key)
    const receiver = new Audio()
    receiver.srcObject = stream
    receiver.muted = true
    receiver.autoplay = true
    await receiver.play()
    const source = this.context.createMediaStreamSource(stream)
    const monitor = this.context.createGain()
    monitor.gain.value = this.listening ? 0.7 : 0
    source.connect(monitor).connect(this.context.destination)
    const entry = Object.assign(this.analyze(source, onBpm, onError), { stream, source, monitor, receiver })
    this.remote.set(key, entry)
    return entry
  }

  setListening(value) {
    this.listening = value
    this.remote.forEach(entry => entry.monitor.gain.setTargetAtTime(value ? 0.7 : 0, this.context.currentTime, 0.02))
  }

  sample(entry) {
    if (!entry?.analyser) return { bands: [0, 0, 0], level: 0 }
    const bins = new Uint8Array(entry.analyser.frequencyBinCount)
    entry.analyser.getByteFrequencyData(bins)
    const bands = frequencyBands(bins, this.context.sampleRate, entry.analyser.fftSize)
    const level = Math.max(...bands)
    if (level > 0.025) entry.lastSignal = performance.now()
    return { bands, level }
  }

  dispose(entry) {
    if (!entry) return
    entry.closed = true
    entry.detector?.disconnect()
    entry.source?.disconnect()
    entry.analyser?.disconnect()
    entry.silence?.disconnect()
    entry.monitor?.disconnect()
    if (entry.receiver) { entry.receiver.pause(); entry.receiver.srcObject = null }
  }

  stop(slot) {
    const entry = this.inputs.get(slot)
    if (!entry) return
    entry.stream.getTracks().forEach(track => track.stop())
    this.dispose(entry)
    this.inputs.delete(slot)
  }

  removeRemote(key) { this.dispose(this.remote.get(key)); this.remote.delete(key) }
}

export const audio = new LiveAudio()