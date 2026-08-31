import { useLayoutEffect, useRef, useState } from 'react'

// Keeps text on a single line, shrinking its font-size (from the container's
// own CSS font-size, read via getComputedStyle) until it fits the available
// width. Unlike FitText, this never wraps onto multiple lines - for titles
// that must stay one line but whose content length varies (e.g. long
// country names).
export default function FitTextLine({ children, className }) {
  const containerRef = useRef(null)
  const textRef = useRef(null)
  const [size, setSize] = useState(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const text = textRef.current
    if (!container || !text) return

    const fit = () => {
      const containerWidth = container.clientWidth
      const baseSize = parseFloat(getComputedStyle(container).fontSize)
      let s = baseSize
      text.style.fontSize = `${s}px`
      while (text.scrollWidth > containerWidth && s > 4) {
        s -= 0.5
        text.style.fontSize = `${s}px`
      }
      setSize(s)
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    return () => observer.disconnect()
  }, [children])

  return (
    <span ref={containerRef} className={className} style={{ display: 'block', width: '100%', minWidth: 0, overflow: 'hidden' }}>
      <span ref={textRef} style={{ display: 'inline-block', whiteSpace: 'nowrap', fontSize: size ?? undefined }}>
        {children}
      </span>
    </span>
  )
}
