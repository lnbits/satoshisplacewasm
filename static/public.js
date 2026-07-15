const state = {
  wallId: '',
  wall: null,
  selected: new Map(),
  pendingPatch: [],
  paintDragging: false,
  pollTimer: null,
  invoicePollTimer: null,
  invoiceUnsubscribe: null,
  qrApp: null
}

const client = window.createLNbitsExtensionClient({
  extensionId: 'satoshisplacewasm'
})

const title = document.querySelector('#wall-title')
const subtitle = document.querySelector('#wall-subtitle')
const description = document.querySelector('#wall-description')
const canvas = document.querySelector('#wall-canvas')
const ctx = canvas.getContext('2d')
const colorInput = document.querySelector('#color-input')
const paintButton = document.querySelector('#paint-button')
const clearButton = document.querySelector('#clear-selection-button')
const copyWallButton = document.querySelector('#copy-wall-button')
const selectionCount = document.querySelector('#selection-count')
const selectionPrice = document.querySelector('#selection-price')
const wallSize = document.querySelector('#wall-size')
const wallPrice = document.querySelector('#wall-price')
const wallPainted = document.querySelector('#wall-painted')
const invoiceDialog = document.querySelector('#invoice-dialog')
const invoiceQrCode = document.querySelector('#invoice-qrcode')
const invoiceStatus = document.querySelector('#invoice-status')
const copyInvoiceButton = document.querySelector('#copy-invoice-button')

canvas.addEventListener('pointerdown', event => {
  state.paintDragging = true
  canvas.setPointerCapture(event.pointerId)
  paintAtEvent(event)
})

canvas.addEventListener('pointermove', event => {
  if (!state.paintDragging) return
  paintAtEvent(event)
})

canvas.addEventListener('pointerup', () => {
  state.paintDragging = false
})

canvas.addEventListener('pointercancel', () => {
  state.paintDragging = false
})

clearButton.addEventListener('click', () => {
  state.selected.clear()
  drawWall()
  updateSelection()
})

copyWallButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href)
    await client.notify('Wall link copied.', 'positive')
  } catch (_error) {
    await client.notify('Failed to copy wall link.', 'negative')
  }
})

paintButton.addEventListener('click', async () => {
  if (!state.wall || !state.selected.size) return
  setPaintLoading(true)
  try {
    const pixels = Array.from(state.selected.values())
    state.pendingPatch = pixels
    const invoice = await client.createPaintInvoice(state.wallId, {pixels})
    openInvoiceDialog(invoice)
    startInvoicePolling(invoice.paymentHash)
    await subscribeToPayment(invoice.paymentHash)
  } catch (error) {
    showError(error)
  } finally {
    setPaintLoading(false)
  }
})

copyInvoiceButton.addEventListener('click', async () => {
  const invoice = copyInvoiceButton.dataset.invoice || ''
  if (!invoice) return
  try {
    await navigator.clipboard.writeText(invoice)
    await client.notify('Invoice copied.', 'positive')
  } catch (_error) {
    await client.notify('Failed to copy invoice.', 'negative')
  }
})

for (const closeControl of document.querySelectorAll('[data-close-invoice]')) {
  closeControl.addEventListener('click', closeInvoiceDialog)
}

init().catch(showError)

async function init() {
  const context = await client.context()
  state.wallId = context.routeParams?.wallId || null
  await renderWall()
  state.pollTimer = window.setInterval(() => {
    renderWall().catch(error => console.warn('[satoshisplacewasm public] poll failed', error))
  }, 5000)
  window.addEventListener('beforeunload', cleanup)
}

async function renderWall() {
  if (!state.wallId) throw new Error('Open a valid wall link.')
  const response = await client.getWall(state.wallId)
  state.wall = response.wall
  title.textContent = state.wall.name
  subtitle.textContent = `${state.wall.pricePerPixel} sat${state.wall.pricePerPixel === 1 ? '' : 's'} per pixel`
  description.textContent = state.wall.description || ''
  wallSize.textContent = `${state.wall.width} x ${state.wall.height}`
  wallPrice.textContent = `${state.wall.pricePerPixel} sats / px`
  wallPainted.textContent = `${state.wall.paidPixels} px`
  paintButton.disabled = !state.wall.enabled || state.selected.size === 0
  drawWall()
  updateSelection()
}

function paintAtEvent(event) {
  if (!state.wall?.enabled) return
  event.preventDefault()
  const square = squareFromEvent(event)
  if (!square) return
  const pixel = {
    x: square.x,
    y: square.y,
    color: colorInput.value.toLowerCase()
  }
  state.selected.set(`${pixel.x},${pixel.y}`, pixel)
  drawWall()
  updateSelection()
}

function squareFromEvent(event) {
  if (!state.wall) return null
  const rect = canvas.getBoundingClientRect()
  const metrics = wallMetrics()
  const canvasX = ((event.clientX - rect.left) / rect.width) * canvas.width
  const canvasY = ((event.clientY - rect.top) / rect.height) * canvas.height
  const x = Math.floor((canvasX - metrics.offsetX) / metrics.scale)
  const y = Math.floor((canvasY - metrics.offsetY) / metrics.scale)
  if (x < 0 || y < 0 || x >= state.wall.width || y >= state.wall.height) return null
  return {x, y}
}

function drawWall() {
  if (!state.wall) return
  const {width, height, scale, offsetX, offsetY} = wallMetrics()
  ctx.fillStyle = '#101318'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const pixels = normalizeCanvas(state.wall.canvas)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      ctx.fillStyle = pixelColor(pixels, y * width + x)
      ctx.fillRect(offsetX + x * scale, offsetY + y * scale, scale, scale)
    }
  }
  for (const pixel of state.selected.values()) {
    ctx.fillStyle = pixel.color
    ctx.fillRect(offsetX + pixel.x * scale, offsetY + pixel.y * scale, scale, scale)
    ctx.strokeStyle = '#111318'
    ctx.lineWidth = 1
    ctx.strokeRect(offsetX + pixel.x * scale + 0.5, offsetY + pixel.y * scale + 0.5, scale - 1, scale - 1)
  }
}

function wallMetrics() {
  const width = Number(state.wall?.width || 1)
  const height = Number(state.wall?.height || 1)
  const scale = Math.max(1, Math.floor(Math.min(canvas.width / width, canvas.height / height)))
  const offsetX = Math.floor((canvas.width - width * scale) / 2)
  const offsetY = Math.floor((canvas.height - height * scale) / 2)
  return {width, height, scale, offsetX, offsetY}
}

function updateSelection() {
  const count = state.selected.size
  const price = count * Number(state.wall?.pricePerPixel || 0)
  selectionCount.textContent = `${count} pixel${count === 1 ? '' : 's'}`
  selectionPrice.textContent = `${price} sats`
  paintButton.disabled = !state.wall?.enabled || count === 0
}

function openInvoiceDialog(invoice) {
  if (!invoice?.paymentRequest || !invoice?.paymentHash) {
    throw new Error('Invalid invoice response.')
  }
  copyInvoiceButton.dataset.invoice = invoice.paymentRequest
  invoiceStatus.textContent = `Waiting for ${invoice.amount} sats`
  invoiceStatus.classList.remove('text-positive')
  renderQrCode(`lightning:${invoice.paymentRequest.toUpperCase()}`)
  invoiceDialog.hidden = false
}

function closeInvoiceDialog() {
  invoiceDialog.hidden = true
  cleanupPaymentSubscription()
  cleanupInvoicePolling()
  if (state.qrApp) {
    state.qrApp.unmount()
    state.qrApp = null
  }
  invoiceQrCode.innerHTML = ''
}

function renderQrCode(value) {
  if (!window.Vue || !window.QrcodeVue?.default) {
    throw new Error('QR code renderer is not available.')
  }
  if (state.qrApp) state.qrApp.unmount()
  invoiceQrCode.innerHTML = ''
  state.qrApp = window.Vue.createApp({
    render() {
      return window.Vue.h(window.QrcodeVue.default, {
        value,
        size: 260,
        margin: 3,
        level: 'Q',
        renderAs: 'svg',
        class: 'invoice-qrcode-svg'
      })
    }
  })
  state.qrApp.mount(invoiceQrCode)
}

async function subscribeToPayment(paymentHash) {
  cleanupPaymentSubscription()
  try {
    state.invoiceUnsubscribe = await client.subscribePayment(paymentHash, event => {
      if (event.event === 'payment.error') {
        invoiceStatus.textContent = 'Checking payment status'
        return
      }
      const payment = event.data || {}
      if (
        event.event === 'payment.settled' ||
        payment.pending === false ||
        ['success', 'settled', 'paid'].includes(String(payment.status || ''))
      ) {
        handleInvoicePaid()
      }
    })
  } catch (error) {
    console.warn('[satoshisplacewasm public] payment subscription unavailable', error)
    invoiceStatus.textContent = 'Checking payment status'
  }
}

function startInvoicePolling(_paymentHash) {
  cleanupInvoicePolling()
  state.invoicePollTimer = window.setInterval(async () => {
    try {
      await renderWall()
      if (pendingPatchPainted()) handleInvoicePaid()
    } catch (error) {
      console.warn('[satoshisplacewasm public] invoice poll failed', error)
    }
  }, 2000)
}

function pendingPatchPainted() {
  if (!state.wall || !state.pendingPatch.length) return false
  const width = Number(state.wall.width || 0)
  const pixels = normalizeCanvas(state.wall.canvas)
  return state.pendingPatch.every(pixel => {
    return pixelColor(pixels, pixel.y * width + pixel.x) === pixel.color
  })
}

function normalizeCanvas(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value
  return {}
}

function pixelColor(pixels, index) {
  const color = Array.isArray(pixels) ? pixels[index] : pixels[String(index)]
  return color || '#ffffff'
}

function cleanupPaymentSubscription() {
  if (!state.invoiceUnsubscribe) return
  state.invoiceUnsubscribe()
  state.invoiceUnsubscribe = null
}

function cleanupInvoicePolling() {
  if (!state.invoicePollTimer) return
  window.clearInterval(state.invoicePollTimer)
  state.invoicePollTimer = null
}

function handleInvoicePaid() {
  cleanupPaymentSubscription()
  cleanupInvoicePolling()
  invoiceStatus.textContent = 'Payment received'
  invoiceStatus.classList.add('text-positive')
  state.selected.clear()
  window.setTimeout(() => {
    closeInvoiceDialog()
    renderWall().catch(showError)
  }, 1200)
}

function setPaintLoading(loading) {
  paintButton.disabled = loading || !state.selected.size
  paintButton.setAttribute('aria-busy', loading ? 'true' : 'false')
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[satoshisplacewasm public]', message, error)
  client.notifyError(message).catch(notifyError => {
    console.error('[satoshisplacewasm public] failed to notify error', notifyError)
  })
}

function cleanup() {
  cleanupPaymentSubscription()
  cleanupInvoicePolling()
  window.clearInterval(state.pollTimer)
}
