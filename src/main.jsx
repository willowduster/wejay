import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Activity, ArrowDownLeft, ArrowRight, AudioLines, Cable, Check, ChevronDown, ChevronRight, CircleHelp, Copy, DoorOpen, ExternalLink, Headphones, Link, LoaderCircle, LockKeyhole, LogIn, LogOut, Maximize2, MessageSquare, Mic2, Plus, Radio, RefreshCw, Send, Settings2, ShieldCheck, Signal, SlidersHorizontal, Unplug, Users, Volume2, VolumeX, Wifi, X } from 'lucide-react'
import Waveform from './Waveform'
import { audio } from './audio.js'
import { api, RoomConnection } from './session'
import './styles.css'

const accents = ['#c7f36b', '#f0a27d', '#91c7d3', '#c6a9da']
const initials = name => name?.split(' ').map(word => word[0]).slice(0, 2).join('').toUpperCase() || 'DJ'
const localMember = { id: 'local', name: 'You', streams: [{ active: false }] }

function IconButton({ title, children, className = '', ...props }) {
  return <button className={`icon-button ${className}`} title={title} aria-label={title} {...props}>{children}</button>
}

function Modal({ title, eyebrow, onClose, children, wide = false }) {
  const ref = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    const close = event => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', close)
    ref.current?.focus()
    return () => { document.removeEventListener('keydown', close); previous?.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`}><div className="modal-heading"><div><span className="eyebrow">{eyebrow || 'WEJAY STUDIO'}</span><h2>{title}</h2></div><IconButton title="Close dialog" onClick={onClose}><X size={19} /></IconButton></div>{children}</section></div>
}

function Channel({ member, slot, index, entry, bpm, own, onConnect, onDisconnect }) {
  const [signal, setSignal] = useState({ level: 0, alive: false })
  useEffect(() => {
    const timer = setInterval(() => {
      const sample = audio.sample(entry)
      setSignal({ level: sample.level, alive: !!entry && performance.now() - entry.lastSignal < 3000 })
    }, 180)
    return () => clearInterval(timer)
  }, [entry])
  const detected = signal.alive && bpm && performance.now() - bpm.detectedAt < 20000 ? bpm : null
  const active = !!entry
  const accent = accents[index % 4]
  const settings = entry?.stream.getAudioTracks()[0]?.getSettings()
  return <section className={`channel ${active ? 'active' : ''}`} style={{ '--channel': accent }}>
    <div className="channel-heading"><span className="channel-number">{String(index + 1).padStart(2, '0')}</span><div className="channel-title"><h3>{own ? 'Your stereo master' : `${member.name} · Stereo master`}</h3><span>{active ? (own ? entry.stream.getAudioTracks()[0]?.label || 'Audio interface' : 'Remote stereo stream') : own ? 'No stereo source connected' : 'Waiting for stereo source'}</span></div><span className={`small-status ${active ? 'green' : ''}`}><i />{active ? 'LIVE INPUT' : 'STANDBY'}</span>{active && own && <IconButton title="Disconnect stereo stream" onClick={() => onDisconnect(slot)}><Unplug size={15} /></IconButton>}</div>
    <div className="channel-body"><div className="bpm-block"><div className="micro-label">DETECTED TEMPO <span>AUTO</span></div><div className={`bpm-value ${detected ? 'has-bpm' : ''}`}>{detected ? detected.bpm.toFixed(1) : <span className="empty-bpm">––<small>.–</small></span>}<span className="bpm-unit">BPM</span></div><div className="bpm-confidence"><i className={detected ? 'green' : ''} />{detected ? `${detected.stable ? 'Stable' : 'Estimating'} · ${Math.round(detected.confidence * 100)}% confidence` : active ? signal.alive ? 'Listening for a beat…' : 'Waiting for signal' : 'Awaiting audio signal'}</div></div><div className="channel-specs"><span><Signal size={13} />{active ? `${settings?.channelCount || 2} CH` : '–– CH'}</span><span>{active ? `${Math.round((settings?.sampleRate || audio.context?.sampleRate || 48000) / 1000)} kHz` : '–– kHz'}</span><div className="level-meter">{Array.from({ length: 18 }, (_, meter) => <i key={meter} style={{ background: signal.level * 25 > meter ? meter > 15 ? '#e69d72' : accent : '#2a2d2c' }} />)}</div><span className="level-label">{signal.level > 0 ? `${Math.max(-60, Math.round(20 * Math.log10(signal.level)))} dB` : '−∞ dB'}</span></div></div>
    <div className="waveform-wrap"><div className="waveform-time"><span>LIVE</span><span>−10s</span><span>−5s</span><span>NOW</span></div><Waveform entry={entry} accent={accent} />{!active && <button className="waveform-connect" onClick={() => own && onConnect(slot)} disabled={!own}>{own ? <><Plus size={14} /> Connect audio source</> : <><Radio size={14} /> No incoming stream</>}</button>}</div>
    <div className="channel-bottom"><span><i className="frequency low" />LOW<i className="frequency mid" />MID<i className="frequency high" />HIGH</span><span>{active ? 'REALTIME AUDIO' : 'NO SIGNAL'}<span className="channel-dot" /></span></div>
  </section>
}

function App() {
  const [modal, setModal] = useState(null)
  const [user, setUser] = useState(null)
  const [config, setConfig] = useState(null)
  const [backend, setBackend] = useState('checking')
  const [room, setRoom] = useState(null)
  const [me, setMe] = useState('local')
  const [connection, setConnection] = useState('local')
  const [localInputs, setLocalInputs] = useState({})
  const [remoteInputs, setRemoteInputs] = useState({})
  const [bpms, setBpms] = useState({})
  const [devices, setDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [listening, setListening] = useState(false)
  const [metrics, setMetrics] = useState(null)
  const [messages, setMessages] = useState([])
  const [chat, setChat] = useState('')
  const [roomName, setRoomName] = useState('After Hours')
  const [joinCode, setJoinCode] = useState(new URLSearchParams(location.search).get('room') || '')
  const [guestName, setGuestName] = useState(localStorage.getItem('wejay-name') || '')
  const [roomList, setRoomList] = useState([])
  const [roomTab, setRoomTab] = useState('create')
  const [authTab, setAuthTab] = useState('signup')
  const [authIntent, setAuthIntent] = useState(false)
  const [auth, setAuth] = useState({ name: '', email: '', password: '' })
  const [copied, setCopied] = useState(false)
  const [clock, setClock] = useState(new Date())
  const session = useRef(null)
  const toastTimer = useRef(null)
  const chatEnd = useRef(null)
  const notify = text => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 5000) }
  const open = name => { setError(''); setBusy(false); setModal(name) }
  const fail = value => { setError(value instanceof Error ? value.message : value); setBusy(false) }

  useEffect(() => {
    api('/config').then(data => { setConfig(data); setBackend('online') }).catch(() => setBackend('offline'))
    api('/auth/me').then(data => setUser(data.user)).catch(() => {})
    if (new URLSearchParams(location.search).has('room')) { setRoomTab('join'); setModal('rooms') }
    const timer = setInterval(() => setClock(new Date()), 1000)
    return () => { clearInterval(timer); session.current?.close(); for (const slot of audio.inputs.keys()) audio.stop(slot) }
  }, [])
  useEffect(() => { if (messages.length && chatEnd.current?.parentElement) chatEnd.current.parentElement.scrollTop = chatEnd.current.parentElement.scrollHeight }, [messages])
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('auth') === 'success') { notify('Google account connected'); history.replaceState(null, '', location.pathname) }
    if (params.get('error')) { notify('Google sign-in failed. Please try again.'); history.replaceState(null, '', location.pathname) }
  }, [])

  const connectRoom = data => {
    session.current?.close()
    setRemoteInputs({}); setMetrics(null); setMessages([])
    setRoom(data.room); setMe(data.memberId); setConnection('connecting')
    sessionStorage.setItem(`wejay-room-${data.room.code}`, data.token)
    history.replaceState(null, '', `?room=${data.room.code}`)
    session.current = new RoomConnection({ room: data.room, token: data.token, iceServers: config?.iceServers, onState: (value, id) => { setRoom(value); setMe(id) }, onStatus: value => {
      setConnection(value)
      if (value === 'connected') for (const [slot, entry] of audio.inputs) session.current?.updateInput(slot, entry, entry.stream.getAudioTracks()[0]?.label)
    }, onMessage: value => setMessages(previous => [...previous.slice(-99), value]), onRemote: (key, value) => setRemoteInputs(previous => { const next = { ...previous }; if (value) next[key] = { ...next[key], ...value }; else delete next[key]; return next }), onError: notify, onMetrics: setMetrics })
    setModal(null); setBusy(false)
    notify(`Joined ${data.room.name}`)
  }

  const createOrJoin = async event => {
    event.preventDefault(); setError('')
    if (roomTab === 'create' && !user) { setAuthIntent(true); open('auth'); return }
    setBusy(true)
    try {
      await audio.init()
      if (roomTab === 'create') connectRoom(await api('/rooms', { method: 'POST', body: JSON.stringify({ name: roomName }) }))
      else {
        const code = joinCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
        localStorage.setItem('wejay-name', guestName)
        connectRoom(await api(`/rooms/${code}/join`, { method: 'POST', body: JSON.stringify({ name: guestName || user?.name || 'Guest DJ', token: sessionStorage.getItem(`wejay-room-${code}`) || '' }) }))
      }
    } catch (value) { fail(value) }
  }

  const showRooms = async () => { open('rooms'); try { setRoomList((await api('/rooms')).rooms || []) } catch { setRoomList([]) } }
  const showAudio = async () => {
    setSelectedDevice(''); setDevices([]); open('audio'); setBusy(true)
    try { const list = await audio.devices(); setDevices(list); setSelectedDevice(localInputs[0]?.deviceId || list[0]?.deviceId || ''); setBusy(false) } catch (value) { fail(value) }
  }

  const disconnect = async slot => {
    audio.stop(slot)
    setLocalInputs(previous => { const next = { ...previous }; delete next[slot]; return next })
    setBpms(previous => ({ ...previous, [slot]: null }))
    await session.current?.updateInput(slot, null)
    notify('Stereo stream disconnected')
  }

  const capture = async event => {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const slot = 0
      const entry = await audio.capture(slot, selectedDevice, value => setBpms(previous => ({ ...previous, [slot]: value })), () => disconnect(slot), notify)
      setLocalInputs(previous => ({ ...previous, [slot]: entry }))
      await session.current?.updateInput(slot, entry, entry.stream.getAudioTracks()[0]?.label)
      setModal(null); setBusy(false); notify('Stereo master connected. Listening for tempo.')
    } catch (value) { fail(value) }
  }

  const authenticate = async event => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const data = await api(`/auth/${authTab === 'signup' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(auth) })
      setUser(data.user); setBusy(false); setModal(authIntent ? 'rooms' : null); setAuthIntent(false); notify(`Welcome, ${data.user.name}`)
    } catch (value) { fail(value) }
  }

  const copyInvite = async () => {
    if (!room) { setRoomTab('create'); open('rooms'); return }
    try { await navigator.clipboard.writeText(`${location.origin}/?room=${room.code}`); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { notify('Copy the room link from the field below.') }
  }

  const leaveRoom = () => { session.current?.close(); session.current = null; setRoom(null); setMe('local'); setRemoteInputs({}); setMetrics(null); setMessages([]); setConnection('local'); history.replaceState(null, '', location.pathname); setModal(null); notify('Left the room. Local inputs remain connected.') }
  const members = room?.members?.length ? room.members : [{ ...localMember, name: user?.name || 'You' }]
  const ownMember = members.find(member => member.id === me) || members[0]
  const remoteMembers = members.filter(member => member.id !== me)
  const activeCount = Object.keys(localInputs).length + Object.values(remoteInputs).filter(value => value.entry).length
  const owner = room && room.owner === me
  const sendChat = event => { event.preventDefault(); if (!chat.trim()) return; if (!session.current || connection !== 'connected') { notify('Join a room to send a message.'); return }; session.current.send({ type: 'chat', text: chat.trim() }); setChat('') }

  return <div className="app-shell">
    <aside className="rail"><a className="brand-mark" href="/" aria-label="WeJay home"><AudioLines size={29} strokeWidth={2.4} /></a><nav><IconButton title="Live booth" className="selected" onClick={() => { setModal(null); document.querySelector('.workspace')?.scrollIntoView() }}><Radio size={21} /></IconButton><IconButton title="Browse rooms" onClick={showRooms}><Users size={21} /></IconButton><IconButton title="Audio inputs" onClick={() => showAudio()}><Cable size={21} /></IconButton></nav><div className="rail-bottom"><IconButton title="Session settings" onClick={() => open('settings')}><Settings2 size={20} /></IconButton><IconButton title="Connection information" onClick={() => open('about')}><CircleHelp size={20} /></IconButton><button className="avatar rail-avatar" aria-label="Your account" title="Your account" onClick={() => open(user ? 'account' : 'auth')}>{initials(user?.name || 'Guest DJ')}</button></div></aside>
    <div className="app-content"><header className="topbar"><a href="/" className="wordmark">wejay<span>.</span></a><div className="topbar-divider" /><span className="workspace-breadcrumb">Workspace <ChevronRight size={13} /><strong>The booth</strong></span><div className="topbar-right"><span className={`server-state ${backend === 'online' ? 'online' : ''}`}><i />{backend === 'online' ? 'All systems operational' : backend === 'checking' ? 'Connecting to studio' : 'Local studio'}</span><button className="account-button" onClick={() => open(user ? 'account' : 'auth')}><span className="avatar tiny">{initials(user?.name || 'Guest DJ')}</span><span>{user?.name || 'Guest DJ'}</span><ChevronDown size={14} /></button></div></header>
      <main className="workspace"><div className="workspace-heading"><div><div className="eyebrow"><span className="tiny-line" />THE SHARED DJ BOOTH</div><div className="room-title"><h1>{room?.name || 'The Green Room'}</h1><button className="room-switch" title="Change room" aria-label="Change room" onClick={showRooms}><ChevronDown size={20} /></button><span className={`room-badge ${connection === 'connected' ? 'is-live' : ''}`}><i />{connection === 'connected' ? 'LIVE ROOM' : connection === 'connecting' ? 'CONNECTING' : connection === 'disconnected' ? 'DISCONNECTED' : 'LOCAL SESSION'}</span></div><p className="room-subtitle">{room ? `Room ${room.code} · ${members.length} of 4 DJs in the booth` : 'Good music is better together.'}</p></div><div className="heading-actions"><button className="button secondary join-button" onClick={() => { setRoomTab('join'); showRooms() }}><DoorOpen size={16} />Join a room</button><button className="button primary" onClick={() => room ? open('invite') : (setRoomTab('create'), open('rooms'))}>{room ? <Link size={16} /> : <Plus size={17} />}{room ? 'Invite DJs' : 'Create room'}</button></div></div>
        <div className="session-toolbar"><div className="workspace-tabs"><button className="active"><AudioLines size={16} />Live booth <span>{String(activeCount).padStart(2, '0')}</span></button><button onClick={showRooms}><Users size={15} />Rooms</button></div><div className="toolbar-tools"><span className="privacy-pill"><ShieldCheck size={13} />NO RECORDING</span><IconButton title="Fullscreen booth" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => notify('Fullscreen unavailable in this browser.'))}><Maximize2 size={15} /></IconButton><IconButton title="Booth settings" onClick={() => open('settings')}><SlidersHorizontal size={16} /></IconButton></div></div>
        <div className="booth-layout"><div className="booth-main"><div className="section-heading"><h2>Stereo streams <span>{activeCount} / 4</span></h2><span className="auto-detect"><Activity size={13} />AUTO BPM DETECTION</span></div><div className="channels-grid"><Channel member={ownMember} slot={0} index={0} own entry={localInputs[0]} bpm={bpms[0]} onConnect={showAudio} onDisconnect={disconnect} />{remoteMembers.map((member, memberIndex) => <Channel key={member.id} member={member} slot={0} index={memberIndex + 1} entry={remoteInputs[`${member.id}:0`]?.entry} bpm={remoteInputs[`${member.id}:0`]?.bpm} />)}</div>
          <section className="inputs-section"><div className="section-heading"><h2>Your audio setup</h2><button className="text-button" onClick={() => showAudio()}><Settings2 size={13} />Configure stereo input</button></div><div className="equipment-row"><div className="equipment-image"><img src="https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=260&q=80" alt="Live DJ performance" /></div><div className="equipment-info"><span className="micro-label">AUDIO INTERFACE</span><h3>{Object.keys(localInputs).length ? 'Your equipment is connected' : 'Your booth. Your equipment.'}</h3><div className="equipment-status"><i className={Object.keys(localInputs).length ? 'green' : ''} />{localInputs[0] ? 'Stereo master connected · L / R' : 'No stereo stream connected'}</div></div><button className="button secondary" onClick={() => showAudio()}><Cable size={16} />Connect audio</button></div><div className="setup-foot"><span><ShieldCheck size={13} />Audio stays live. Nothing gets stored.</span><span><span className="small-dot" />{Object.keys(localInputs).length ? 'CAPTURING' : 'READY WHEN YOU ARE'}</span></div></section>
          <section className="connection-strip"><div className="connection-strip-icon"><Wifi size={20} /></div><div><span className="micro-label">AUDIO CONNECTION</span><strong>{metrics ? `${metrics.rtt} ms` : '–– ms'}<small>ROUND-TRIP</small></strong></div><div><span className="micro-label">TRANSPORT</span><strong>WebRTC<small>ENCRYPTED</small></strong></div><div><span className="micro-label">QUALITY TARGET</span><strong>320<small>KBPS / STREAM</small></strong></div><div className="connection-detail"><span className={`small-status ${metrics ? 'green' : ''}`}><i />{metrics ? 'PEER CONNECTED' : 'AWAITING PEERS'}</span><button className="text-button" onClick={() => open('about')}>Connection details<ArrowRight size={12} /></button></div></section>
        </div><aside className="session-sidebar"><section className="room-members"><div className="section-heading"><h2>In the booth <span>{members.length} / 4</span></h2><IconButton title="Invite a DJ" onClick={() => room ? open('invite') : (setRoomTab('create'), open('rooms'))}><Plus size={16} /></IconButton></div><div className="member-list">{Array.from({ length: 4 }, (_, index) => { const member = members[index]; return member ? <div key={member.id} className="member-row"><span className="avatar member-avatar" style={{ '--avatar-color': accents[index] }}>{initials(member.name)}</span><div><strong>{member.id === me ? user?.name || member.name : member.name}{member.id === me && <span className="you-label">YOU</span>}</strong><small>{member.id === room?.owner ? 'Room owner' : member.id === me && !room ? 'Local studio' : 'DJ'}</small></div><span className="member-signal"><AudioLines size={17} /><i className={member.id === me ? Object.keys(localInputs).length ? 'green' : '' : member.streams?.some(stream => stream.active) ? 'green' : ''} /></span></div> : <button key={index} className="empty-member" onClick={() => room ? open('invite') : (setRoomTab('create'), open('rooms'))}><span className="empty-avatar"><Plus size={16} /></span><span>Open booth<small>Invite a DJ</small></span><ArrowDownLeft size={14} /></button> })}</div><div className="room-access"><LockKeyhole size={13} /><span>{room?.locked ? 'Room is locked' : 'Open to invited DJs'}</span><button title={owner ? 'Change room access' : 'Room access settings'} aria-label="Room access settings" onClick={() => open('settings')}><Settings2 size={13} /></button></div></section>
            <section className="monitor-section"><div><Headphones size={19} /><div><strong>Session audio</strong><span>{listening ? 'Listening to remote DJs' : 'Monitoring off'}</span></div></div><button className={`monitor-toggle ${listening ? 'enabled' : ''}`} role="switch" aria-checked={listening} aria-label="Listen to session audio" title="Listen to remote DJs" onClick={async () => { await audio.init(); audio.setListening(!listening); setListening(!listening) }}><i /></button></section>
            <section className="chat-section"><div className="section-heading"><h2><MessageSquare size={15} />Booth chat</h2><span className="chat-count">{messages.length}</span></div><div className="chat-messages">{messages.length ? messages.map((message, index) => <div className="chat-message" key={index}><span className="avatar chat-avatar">{initials(message.name)}</span><div><div><strong>{message.name}</strong><time>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></div></div>) : <div className="chat-empty"><span><MessageSquare size={22} strokeWidth={1.4} /></span><p>The booth is quiet.</p><small>{room ? 'Say hello to the room.' : 'Join a room to start the conversation.'}</small></div>}<div ref={chatEnd} /></div><form className="chat-form" onSubmit={sendChat}><input aria-label="Message the booth" placeholder="Message the booth…" value={chat} maxLength={500} onChange={event => setChat(event.target.value)} /><IconButton title="Send message" type="submit" disabled={!chat.trim()}><Send size={16} /></IconButton></form></section>
          </aside></div>
        <div className="workspace-bottom"><span><span className="live-pulse" />LIVE SOUND. SHARED SPACE.</span><span>Built for the back-to-back.</span><span>WEJAY STUDIO <span className="version">BETA 01</span></span></div>
      </main><footer className="statusbar"><div><span className={`status-led ${connection === 'connected' ? 'green' : ''}`} />{connection === 'connected' ? 'Room connected' : connection === 'disconnected' ? 'Room disconnected' : 'Local session'}<span className="status-divider" />{members.length} DJ{members.length !== 1 ? 's' : ''}<span className="status-divider" />{activeCount} live input{activeCount !== 1 ? 's' : ''}</div><div><ShieldCheck size={12} /><span>End-to-end encrypted audio</span><span className="status-divider" /><time>{clock.toLocaleTimeString([], { hour12: false })}</time></div></footer>
    </div>
    {toast && <div className="toast" role="status"><Check size={16} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    {modal === 'audio' && <Modal title="Connect your stereo master" eyebrow="YOUR EQUIPMENT, LIVE" onClose={() => setModal(null)}><form onSubmit={capture}><label>Stereo audio source<select value={selectedDevice} onChange={event => setSelectedDevice(event.target.value)} disabled={busy || !devices.length}><option value="">{busy ? 'Requesting audio permission…' : 'Select a stereo input'}</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Audio input'}</option>)}</select></label><div className="capture-options"><span><Check size={14} />Stereo L / R</span><span><Check size={14} />48 kHz requested</span><span><Check size={14} />No voice processing</span></div><div className="info-note"><Cable size={17} /><p>Select the stereo master feed from your mixer, controller audio interface, or virtual audio cable.</p></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" type="submit" disabled={busy || !selectedDevice}>{busy ? <LoaderCircle className="spin" size={16} /> : <Radio size={16} />}Connect stereo stream</button><button className="text-button centered" type="button" disabled={busy} onClick={() => showAudio()}><RefreshCw size={13} />Refresh audio devices</button></form></Modal>}
    {modal === 'rooms' && <Modal title="Find your booth" onClose={() => setModal(null)}><div className="segmented"><button className={roomTab === 'create' ? 'active' : ''} onClick={() => { setRoomTab('create'); setError('') }}>Create room</button><button className={roomTab === 'join' ? 'active' : ''} onClick={() => { setRoomTab('join'); setError('') }}>Join room</button></div><form onSubmit={createOrJoin}>{roomTab === 'create' ? <><label>Room name<input value={roomName} maxLength={48} required onChange={event => setRoomName(event.target.value)} placeholder="After Hours" /></label><div className="room-capacity"><Users size={17} /><span>4 DJs<span>1 stereo stream each · L / R</span></span><ShieldCheck size={17} /></div>{!user && <p className="field-note">An account is required to host. Guests can join by invitation.</p>}</> : <><label>Room code<input className="code-input" autoComplete="off" value={joinCode} onChange={event => setJoinCode(event.target.value.toUpperCase())} maxLength={8} placeholder="ABC123" required /></label><label>Your DJ name<input value={guestName} onChange={event => setGuestName(event.target.value)} maxLength={32} placeholder={user?.name || 'Guest DJ'} required={!user} /></label></>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy} type="submit">{busy ? <LoaderCircle size={16} className="spin" /> : roomTab === 'create' ? <Plus size={16} /> : <DoorOpen size={16} />}{roomTab === 'create' ? user ? 'Create room' : 'Create an account to host' : 'Join the booth'}</button></form>{roomTab === 'join' && <div className="available-rooms"><div className="section-heading"><h3>Open rooms</h3><IconButton title="Refresh rooms" onClick={showRooms}><RefreshCw size={13} /></IconButton></div>{roomList.length ? roomList.map(item => <button key={item.code} onClick={() => setJoinCode(item.code)}><Radio size={16} /><span>{item.name}<small>{item.count} / 4 DJs</small></span><ChevronRight size={15} /></button>) : <span className="field-note">No open rooms right now.</span>}</div>}</Modal>}
    {modal === 'auth' && <Modal title={authTab === 'signup' ? 'Your next session starts here.' : 'Back in the booth.'} eyebrow="YOUR WEJAY ACCOUNT" onClose={() => setModal(null)}><div className="segmented"><button className={authTab === 'signup' ? 'active' : ''} onClick={() => { setAuthTab('signup'); setError('') }}>Create account</button><button className={authTab === 'login' ? 'active' : ''} onClick={() => { setAuthTab('login'); setError('') }}>Sign in</button></div><button className="button google full" disabled={!config?.googleEnabled} onClick={() => location.assign('/api/auth/google')}><span className="google-g">G</span>Continue with Google</button>{!config?.googleEnabled && <span className="field-note google-note">Google sign-in requires server configuration.</span>}<div className="or-divider"><span />or use your email<span /></div><form onSubmit={authenticate}>{authTab === 'signup' && <label>DJ name<input required value={auth.name} maxLength={32} onChange={event => setAuth({ ...auth, name: event.target.value })} autoComplete="nickname" placeholder="Your name behind the decks" /></label>}<label>Email<input type="email" required value={auth.email} onChange={event => setAuth({ ...auth, email: event.target.value })} autoComplete="email" placeholder="you@example.com" /></label><label>Password<input type="password" required minLength={10} maxLength={72} value={auth.password} onChange={event => setAuth({ ...auth, password: event.target.value })} autoComplete={authTab === 'signup' ? 'new-password' : 'current-password'} placeholder="At least 10 characters" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary full" disabled={busy} type="submit">{busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{authTab === 'signup' ? 'Create account' : 'Sign in'}</button></form></Modal>}
    {modal === 'invite' && <Modal title="Make it a back-to-back." eyebrow="INVITE TO THE BOOTH" onClose={() => setModal(null)}><div className="invite-code"><span className="micro-label">ROOM CODE</span><strong>{room?.code}</strong><span>{members.length} of 4 DJs connected</span></div><label>Shareable invite<input readOnly value={`${location.origin}/?room=${room?.code}`} onFocus={event => event.target.select()} /></label><button className="button primary full" onClick={copyInvite}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Invite link copied' : 'Copy invite link'}</button><div className="info-note"><DoorOpen size={17} /><p>No account needed to join. {room?.locked ? 'Your room is locked to new DJs.' : 'Anyone with the link can join an open booth.'}</p></div></Modal>}
    {modal === 'settings' && <Modal title="Session settings" onClose={() => setModal(null)}><div className="setting-row"><div><strong>Room access</strong><span>{room?.locked ? 'New DJs cannot join' : 'Allow new DJs to join'}</span></div><button role="switch" aria-label="Allow new DJs" aria-checked={!room?.locked} disabled={!owner} className={`monitor-toggle ${!room?.locked ? 'enabled' : ''}`} onClick={async () => { try { const data = await api(`/rooms/${room.code}`, { method: 'PATCH', body: JSON.stringify({ locked: !room.locked, token: session.current.token }) }); setRoom(data.room) } catch (value) { notify(value.message) } }}><i /></button></div>{!owner && <p className="field-note">Only the room owner can change access.</p>}<div className="setting-row"><div><strong>Local monitoring</strong><span>Off to prevent audio feedback</span></div><VolumeX size={19} /></div><div className="setting-row"><div><strong>Stream quality</strong><span>Stereo Opus · 320 kbps target</span></div><Signal size={19} /></div>{room && <button className="button danger full" onClick={leaveRoom}><LogOut size={16} />Leave room</button>}</Modal>}
    {modal === 'about' && <Modal title="Connection details" onClose={() => setModal(null)}><dl className="connection-facts"><div><dt>Signaling server</dt><dd>{backend === 'online' ? 'Connected' : 'Unavailable'}</dd></div><div><dt>Room connection</dt><dd>{connection}</dd></div><div><dt>Peer round-trip</dt><dd>{metrics ? `${metrics.rtt} ms` : 'No connected peers'}</dd></div><div><dt>Compression</dt><dd>Opus, stereo, up to 320 kbps</dd></div><div><dt>Encryption</dt><dd>DTLS-SRTP</dd></div><div><dt>Audio storage</dt><dd>None</dd></div><div><dt>NAT relay</dt><dd>{config?.turnConfigured ? 'TURN configured' : 'STUN only'}</dd></div></dl><p className="field-note">Opus is lossy, not lossless. Network, browser and hardware determine latency. Equipment needs an OS-visible audio input; software-only or output-only devices may need loopback routing.</p></Modal>}
    {modal === 'account' && <Modal title={user?.name || 'Your account'} onClose={() => setModal(null)}><div className="account-detail"><span className="avatar">{initials(user?.name)}</span><div><strong>{user?.name}</strong><span>{user?.email}</span></div></div><button className="button secondary full" onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); setUser(null); setModal(null); notify('Signed out') } catch (value) { fail(value) } }}><LogOut size={16} />Sign out</button>{error && <p className="form-error">{error}</p>}</Modal>}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)