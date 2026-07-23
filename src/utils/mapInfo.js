function addLine(container, text, style) {
  const line = document.createElement('div')
  line.style.cssText = style
  line.textContent = String(text || '')
  container.appendChild(line)
}

export function createMapInfoContent(item, timeRange) {
  const container = document.createElement('div')
  container.style.paddingRight = '8px'
  if (item?.itineraryColor?.solid) {
    container.style.borderLeft = `3px solid ${item.itineraryColor.solid}`
    container.style.paddingLeft = '8px'
  }
  addLine(container, item?.title, 'font-weight:600;color:#111111')
  addLine(
    container,
    item?.locationName || item?.address || '',
    'font-size:12px;color:#475569;margin-top:4px',
  )
  addLine(container, timeRange, 'font-size:12px;color:#475569;margin-top:4px')
  return container
}
