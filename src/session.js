import { audio } from './audio.js'

export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Server unavailable (${response.status})`)
  return data
}

export function preferMusic(sdp) {
  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, payload, params) => {
    if (!params.includes('useinbandfec')) return line
    const clean = params.split(';').filter(part => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(part.trim())).join(';')
    return `a=fmtp:${payload} ${clean};stereo=1;sprop-stereo=1;maxaveragebitrate=320000;usedtx=0`
  })
}

export class RoomConnection {
  constructor({ room, token, iceServers, onState, onStatus, onMessage, onRemote, onError, onMetrics }) {
    Object.assign(this, { room, token, iceServers, onState, onStatus, onMessage, onRemote, onError, onMetrics })
    this.peers = new Map()
    this.streamSlots = new Map()
    this.closed = false
    this.connect()
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${this.room.code}/ws?token=${encodeURIComponent(this.token)}`)
    this.socket.onopen = () => this.onStatus('connected')
    this.socket.onerror = () => this.onError('Room connection interrupted. Rejoin to reconnect.')
    this.socket.onclose = () => { if (!this.closed) this.onStatus('disconnected') }
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data)
      this.receive(message).catch(error => this.onError(error.message))
    }
    this.statsTimer = setInterval(() => this.readStats(), 3000)
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  async receive(message) {
    if (message.type === 'state') {
      this.me = message.you
      this.onState(message.room, message.you)
      const ids = new Set(message.room.members.map(member => member.id))
      for (const [id, peer] of this.peers) {
        if (!ids.has(id)) { peer.pc.close(); this.peers.delete(id); audio.removeRemote(`${id}:0`); this.onRemote(`${id}:0`, null) }
      }
      for (const member of message.room.members) {
        if (member.id === this.me) continue
        this.streamSlots.set(member.id, member.streams || [])
        if (!this.peers.has(member.id)) this.createPeer(member.id)
        for (let slot = 0; slot < 1; slot++) {
          const entry = this.peers.get(member.id).receivers.get(slot)
          const active = member.streams?.[slot]?.active
          if (entry && active && !audio.remote.has(`${member.id}:${slot}`)) this.attachRemote(member.id, slot, entry)
          if (!active && audio.remote.has(`${member.id}:${slot}`)) { audio.removeRemote(`${member.id}:${slot}`); this.onRemote(`${member.id}:${slot}`, null) }
        }
      }
    } else if (message.type === 'signal') {
      const peer = this.peers.get(message.from) || this.createPeer(message.from)
      const data = message.data
      if (data.description) {
        const collision = data.description.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable')
        peer.ignoreOffer = !peer.polite && collision
        if (peer.ignoreOffer) return
        await peer.pc.setRemoteDescription(data.description)
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate)
        if (data.description.type === 'offer') {
          peer.senders = []
          for (const [slot, transceiver] of peer.pc.getTransceivers().slice(0, 1).entries()) {
            transceiver.direction = 'sendrecv'
            const entry = audio.inputs.get(slot)
            await transceiver.sender.replaceTrack(entry?.stream.getAudioTracks()[0] || null)
            peer.senders.push(transceiver.sender)
          }
          const answer = await peer.pc.createAnswer()
          await peer.pc.setLocalDescription({ type: 'answer', sdp: preferMusic(answer.sdp) })
          this.send({ type: 'signal', to: message.from, data: { description: peer.pc.localDescription } })
        }
      } else if (data.candidate && !peer.ignoreOffer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate)
        else peer.candidates.push(data.candidate)
      }
    } else if (message.type === 'chat') this.onMessage(message)
    else if (message.type === 'error') this.onError(message.error)
  }

  createPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers || [], bundlePolicy: 'max-bundle' })
    const peer = { pc, polite: this.me > id, initiator: this.me < id, makingOffer: false, ignoreOffer: false, candidates: [], receivers: new Map(), senders: [] }
    this.peers.set(id, peer)
    if (peer.initiator) peer.senders = [0].map(slot => {
      const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' })
      const opus = RTCRtpSender.getCapabilities?.('audio')?.codecs.filter(codec => codec.mimeType.toLowerCase() === 'audio/opus')
      if (opus?.length && transceiver.setCodecPreferences) transceiver.setCodecPreferences(opus)
      const entry = audio.inputs.get(slot)
      if (entry) transceiver.sender.replaceTrack(entry.stream.getAudioTracks()[0])
      return transceiver.sender
    })
    pc.onnegotiationneeded = async () => {
      if (!peer.initiator || pc.signalingState !== 'stable') return
      try {
        peer.makingOffer = true
        const offer = await pc.createOffer()
        await pc.setLocalDescription({ type: 'offer', sdp: preferMusic(offer.sdp) })
        this.send({ type: 'signal', to: id, data: { description: pc.localDescription } })
      } catch (error) { this.onError(`Audio negotiation: ${error.message}`) }
      finally { peer.makingOffer = false }
    }
    pc.onicecandidate = event => { if (event.candidate) this.send({ type: 'signal', to: id, data: { candidate: event.candidate } }) }
    pc.ontrack = event => {
      const slot = pc.getTransceivers().indexOf(event.transceiver)
      if (slot !== 0) return
      const stream = new MediaStream([event.track])
      peer.receivers.set(slot, stream)
      event.track.onunmute = () => { if (this.streamSlots.get(id)?.[slot]?.active) this.attachRemote(id, slot, stream) }
      if (this.streamSlots.get(id)?.[slot]?.active) this.attachRemote(id, slot, stream)
    }
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.onError('A peer connection failed. Check your network or TURN configuration.') }
    return peer
  }

  async attachRemote(id, slot, stream) {
    const key = `${id}:${slot}`
    if (audio.remote.has(key)) return
    const entry = await audio.addRemote(key, stream, value => this.onRemote(key, { bpm: value }), this.onError)
    this.onRemote(key, { entry })
  }

  async updateInput(slot, entry, label = '') {
    if (slot !== 0) throw new Error('Each DJ supplies one stereo master stream.')
    for (const peer of this.peers.values()) {
      const sender = peer.senders[slot]
      if (!sender) continue
      await sender.replaceTrack(entry?.stream.getAudioTracks()[0] || null)
      if (entry) {
        const parameters = sender.getParameters()
        if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = 320000; await sender.setParameters(parameters).catch(() => {}) }
      }
    }
    this.send({ type: 'input', slot, active: !!entry, label })
  }

  async readStats() {
    const measurements = []
    for (const peer of this.peers.values()) {
      const stats = await peer.pc.getStats().catch(() => null)
      stats?.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) measurements.push({ rtt: report.currentRoundTripTime * 1000 })
      })
    }
    this.onMetrics(measurements.length ? { rtt: Math.round(measurements.reduce((sum, item) => sum + (item.rtt || 0), 0) / measurements.length), peers: measurements.length } : null)
  }

  close() {
    this.closed = true
    clearInterval(this.statsTimer)
    this.socket?.close()
    this.peers.forEach(peer => peer.pc.close())
    this.peers.clear()
    for (const key of audio.remote.keys()) audio.removeRemote(key)
  }
}