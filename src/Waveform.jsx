import { useEffect, useRef } from 'react'
import { audio } from './audio.js'

export default function Waveform({ entry, compact = false, accent = '#c7f36b' }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    let frame, lastSample = 0
    const history = []
    const draw = now => {
      const rect = canvas.getBoundingClientRect()
      const ratio = devicePixelRatio || 1
      if (canvas.width !== Math.round(rect.width * ratio) || canvas.height !== Math.round(rect.height * ratio)) {
        canvas.width = rect.width * ratio; canvas.height = rect.height * ratio
      }
      const context = canvas.getContext('2d')
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      const width = rect.width, height = rect.height, center = height / 2
      context.clearRect(0, 0, width, height)
      if (now - lastSample > 35) {
        history.push(entry ? audio.sample(entry).bands : [0, 0, 0])
        if (history.length > Math.ceil(width / 3)) history.shift()
        lastSample = now
      }
      context.strokeStyle = '#ffffff06'
      context.lineWidth = 1
      for (let position = 0; position < width; position += 44) { context.beginPath(); context.moveTo(position, 0); context.lineTo(position, height); context.stroke() }
      for (let position = 16; position < height; position += 24) { context.beginPath(); context.moveTo(0, position); context.lineTo(width, position); context.stroke() }
      context.strokeStyle = entry ? `${accent}55` : '#ffffff18'
      context.beginPath(); context.moveTo(0, center); context.lineTo(width, center); context.stroke()
      const colors = ['#dd975f', '#bd839d', '#7dbbbd']
      history.forEach((bands, index) => {
        const position = width - (history.length - index) * 3
        bands.forEach((value, band) => {
          context.fillStyle = colors[band]
          const bar = Math.max(0.4, value * height * (0.85 - band * 0.16))
          context.fillRect(position, center - bar / 2, 2, bar)
        })
      })
      if (entry) { context.fillStyle = accent; context.fillRect(width - 2, 0, 1, height) }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [entry, compact, accent])
  return <canvas ref={ref} className={`waveform ${compact ? 'compact' : ''}`} aria-label="Live three-color frequency waveform" />
}