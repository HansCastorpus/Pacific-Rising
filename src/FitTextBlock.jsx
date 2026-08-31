import { useLayoutEffect, useRef, useState } from 'react'

// Lets text wrap normally (unlike FitText/FitTextLine, which force a single
// line per word or overall), but shrinks the font-size until the wrapped
// text's height fits inside the container's own fixed CSS height. Used
// where a sibling element's position must never move regardless of how
// long this text is - the container's height staying fixed is what
// guarantees that, this just keeps the text from overflowing it.
export default function FitTextBlock({ children, className }) {
  const containerRef = useRef(null)
  const [size, setSize] = useState(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const fit = () => {
      const maxHeight = container.clientHeight
      const baseSize = parseFloat(getComputedStyle(container).fontSize)
      let s = baseSize
      container.style.fontSize = `${s}px`
      while (container.scrollHeight > maxHeight && s > 4) {
        s -= 0.5
        container.style.fontSize = `${s}px`
      }
      setSize(s)
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    return () => observer.disconnect()
  }, [children])

  return (
    <span ref={containerRef} className={className} style={{ fontSize: size ?? undefined }}>
      {children}
    </span>
  )
}
