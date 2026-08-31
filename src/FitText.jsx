import { useLayoutEffect, useRef, useState } from 'react'

// Renders one word per line. Reads the CSS font-size (set via vw, so it
// stays responsive) as the starting/max size, then shrinks each word
// independently until it fits the available width - a short word stays at
// full size while a long one shrinks on its own.
export default function FitText({ children, className }) {
  const containerRef = useRef(null)
  const wordRefs = useRef([])
  const words = typeof children === 'string' ? children.split(' ') : [children]
  const [sizes, setSizes] = useState(() => words.map(() => null))

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const fit = () => {
      const containerWidth = container.clientWidth
      const baseSize = parseFloat(getComputedStyle(container).fontSize)
      const newSizes = words.map((_, i) => {
        const el = wordRefs.current[i]
        if (!el) return baseSize
        let size = baseSize
        el.style.fontSize = `${size}px`
        while (el.scrollWidth > containerWidth && size > 4) {
          size -= 0.5
          el.style.fontSize = `${size}px`
        }
        return size
      })
      setSizes(newSizes)
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children])

  return (
    <span ref={containerRef} className={className}>
      {words.map((word, i) => (
        <span
          key={i}
          ref={(el) => {
            wordRefs.current[i] = el
          }}
          style={{ display: 'block', fontSize: sizes[i] ?? undefined, whiteSpace: 'nowrap' }}
        >
          {word}
        </span>
      ))}
    </span>
  )
}
