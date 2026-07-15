import {storage, system, wallet} from './lnbits-sdk.js'

const WALLS_TABLE = 'place_walls'
const PAYMENTS_TABLE = 'place_payments'
const WALL_SEARCH_FIELDS = ['name', 'description']
const DEFAULT_COLOR = '#ffffff'
const MAX_WALL_PIXELS = 16384
const MAX_INVOICE_PATCH_BYTES = 3500
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function listPlaceWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function createPlaceWall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const walletId = requiredText(request.walletId ?? request.wallet_id, 'walletId', 128)
    const walletName = cleanText(request.walletName ?? request.wallet_name, 120)
    const width = normalizeInteger(request.width, 64, 8, 128)
    const height = normalizeInteger(request.height, 64, 8, 128)
    if (width * height > MAX_WALL_PIXELS) {
      throw new Error(`Wall area must be at most ${MAX_WALL_PIXELS} pixels.`)
    }
    const now = system.now()
    const wall = {
      id: cleanId(request.id) || makeRandomId('wall'),
      name: cleanText(request.name, 80) || 'Satoshi wall',
      description: cleanText(request.description, 280),
      wallet_id: walletId,
      wallet_name: walletName || walletId,
      width,
      height,
      price_per_pixel: normalizeInteger(request.pricePerPixel ?? request.price_per_pixel, 1, 1, 100000),
      enabled: request.enabled !== false,
      canvas_json: '[]',
      paint_count: 0,
      paid_pixels: 0,
      created_at: now,
      updated_at: now
    }
    storage.set(WALLS_TABLE, wall)
    system.log(`satoshisplacewasm: created wall ${wall.id}`)
    return {wall: ownerWall(wall), publicUrl: `/satoshisplacewasm/walls/${wall.id}`}
  })
}

export function listPlaceWalls(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const rowsPerPage = normalizePageSize(request.rowsPerPage)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(WALLS_TABLE, {
      search: cleanText(request.search, 256),
      searchFields: WALL_SEARCH_FIELDS,
      sortBy: normalizeWallSortBy(request.sortBy),
      descending: request.descending === true || request.descending === 'true',
      limit: rowsPerPage,
      offset: (page - 1) * rowsPerPage
    })
    return {walls: response.data.map(ownerWall), total: response.total}
  })
}

export function deletePlaceWall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const wallId = requiredText(request.wallId ?? request.wall_id, 'wallId', 128)
    getWall(wallId)
    const payments = storage.getPaginated(PAYMENTS_TABLE, {
      filters: {wall_id: wallId},
      sortBy: 'created_at',
      descending: false,
      limit: 500,
      offset: 0
    }).data
    payments.forEach(payment => storage.delete(PAYMENTS_TABLE, payment.id))
    storage.delete(WALLS_TABLE, wallId)
    system.log(`satoshisplacewasm: deleted wall ${wallId}`)
    return {deleted: true, wallId}
  })
}

export function getPublicPlaceWall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const wallId = requiredText(request.wallId ?? request.wall_id, 'wallId', 128)
    const wall = getPublicWall(wallId)
    return {wall: publicWall(wall)}
  })
}

export function createPlacePaintInvoice(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const wallId = requiredText(request.wallId ?? request.wall_id, 'wallId', 128)
    const wall = getPublicWall(wallId)
    if (wall.enabled !== true) throw new Error('This wall is not accepting graffiti.')
    const patch = normalizePatch(request.pixels ?? request.patch, wall)
    const patchPayload = encodePatchPayload(patch, wall)
    if (patchPayload.length > MAX_INVOICE_PATCH_BYTES) {
      throw new Error('Paint fewer pixels in one invoice.')
    }
    const amount = patch.length * Number(wall.price_per_pixel || 1)
    const invoice = wallet.createInvoicePublic({
      sourceId: wall.id,
      amount,
      currency: 'sat',
      memo: `${patch.length} pixel${patch.length === 1 ? '' : 's'} on ${wall.name}`,
      extra: {
        wall_id: wall.id,
        patch_json: patchPayload,
        amount: String(amount)
      }
    })
    return {
      paymentHash: invoice.paymentHash,
      paymentRequest: invoice.paymentRequest,
      checkingId: invoice.checkingId,
      amount,
      pixelCount: patch.length
    }
  })
}

export function recordPlacePayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    const paymentHash = eventPaymentHash(event)
    const extensionExtra = event.extra?.extra_satoshisplacewasm || event.payment?.extra?.extra_satoshisplacewasm || {}
    const wallId = cleanText(
      extensionExtra.wall_id || event.extra?.wall_id || event.payment?.extra?.wall_id,
      128
    )
    const patchJson = cleanText(
      extensionExtra.patch_json || event.extra?.patch_json || event.payment?.extra?.patch_json,
      20000
    )
    if (!paymentHash) throw new Error('paymentHash is required.')
    if (!wallId) throw new Error('wall_id is required.')

    const existing = storage.get(PAYMENTS_TABLE, paymentHash, null)
    if (existing && existing.status === 'paid') {
      return {payment: publicPayment(existing), status: 'paid'}
    }

    const wall = getWall(wallId)
    const patch = normalizePatch(decodePatchPayload(patchJson, wall), wall)
    const amount = patch.length * Number(wall.price_per_pixel || 1)
    const paidSat = Math.abs(Number(event.amount || event.payment?.amount || 0)) / 1000
    if (paidSat && Math.trunc(paidSat) !== amount) {
      const payment = recordPayment(paymentHash, wallId, patch, amount, 'amount-mismatch', null)
      return {payment: publicPayment(payment), status: 'amount-mismatch'}
    }

    const canvas = applyPatch(wall, patch)
    const now = system.now()
    const updatedWall = {
      ...wall,
      canvas_json: JSON.stringify(canvas),
      paint_count: Number(wall.paint_count || 0) + 1,
      paid_pixels: Number(wall.paid_pixels || 0) + patch.length,
      updated_at: now
    }
    storage.set(WALLS_TABLE, updatedWall)
    const payment = recordPayment(paymentHash, wallId, patch, amount, 'paid', now)
    return {wall: publicWall(updatedWall), payment: publicPayment(payment), status: 'paid'}
  })
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ok: false, error: message})
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object.')
  }
  return parsed
}

function getWall(wallId) {
  const wall = storage.get(WALLS_TABLE, wallId, null)
  if (!wall) throw new Error('Wall not found.')
  return wall
}

function getPublicWall(wallId) {
  const wall = storage.getPublic(WALLS_TABLE, wallId, null)
  if (!wall) throw new Error('Wall not found.')
  return wall
}

function recordPayment(paymentHash, wallId, patch, amount, status, paidAt) {
  const now = system.now()
  const existing = storage.get(PAYMENTS_TABLE, paymentHash, null)
  const payment = {
    id: paymentHash,
    wall_id: wallId,
    pixel_count: patch.length,
    amount,
    patch_json: existing?.patch_json || JSON.stringify(patch),
    status,
    created_at: existing?.created_at || now,
    paid_at: paidAt || existing?.paid_at || null
  }
  storage.set(PAYMENTS_TABLE, payment)
  return payment
}

function applyPatch(wall, patch) {
  const canvas = wallCanvasMap(wall)
  for (const pixel of patch) {
    canvas[String(pixel.y * Number(wall.width) + pixel.x)] = pixel.color
  }
  return canvas
}

function wallCanvasMap(wall) {
  const width = Number(wall.width || 0)
  const height = Number(wall.height || 0)
  const total = width * height
  let canvas = null
  try {
    canvas = JSON.parse(wall.canvas_json || '[]')
  } catch (_error) {
    canvas = null
  }
  const result = {}
  if (Array.isArray(canvas)) {
    for (let index = 0; index < Math.min(total, canvas.length); index += 1) {
      const color = normalizeColor(canvas[index] || DEFAULT_COLOR)
      if (color !== DEFAULT_COLOR) result[String(index)] = color
    }
    return result
  }
  if (!canvas || typeof canvas !== 'object') return result
  for (const [rawIndex, rawColor] of Object.entries(canvas)) {
    const index = Number(rawIndex)
    if (!Number.isInteger(index) || index < 0 || index >= total) continue
    const color = normalizeColor(rawColor || DEFAULT_COLOR)
    if (color !== DEFAULT_COLOR) result[String(index)] = color
  }
  return result
}

function normalizePatch(value, wall) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Select at least one pixel.')
  const width = Number(wall.width || 0)
  const height = Number(wall.height || 0)
  const bySquare = new Map()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid pixel.')
    const x = normalizeInteger(raw.x, -1, 0, width - 1)
    const y = normalizeInteger(raw.y, -1, 0, height - 1)
    bySquare.set(`${x},${y}`, {x, y, color: normalizeColor(raw.color)})
  }
  return Array.from(bySquare.values())
}

function encodePatchPayload(patch, wall) {
  const compact = patch
    .map(pixel => {
      const x = pixel.x.toString(36)
      const y = pixel.y.toString(36)
      return `${x},${y},${pixel.color.slice(1)}`
    })
    .join(';')
  const bitset = encodePatchBitsets(patch, wall)
  return bitset.length < compact.length ? bitset : compact
}

function encodePatchBitsets(patch, wall) {
  const width = Number(wall.width || 0)
  const height = Number(wall.height || 0)
  const total = width * height
  const byteCount = Math.ceil(total / 8)
  const byColor = new Map()
  for (const pixel of patch) {
    if (!byColor.has(pixel.color)) byColor.set(pixel.color, new Uint8Array(byteCount))
    const bytes = byColor.get(pixel.color)
    const index = pixel.y * width + pixel.x
    bytes[Math.floor(index / 8)] |= 1 << (index % 8)
  }
  const groups = Array.from(byColor.entries()).map(([color, bytes]) => {
    return `${color.slice(1)}:${encodeBase64(bytes)}`
  })
  return `v2|${groups.join(';')}`
}

function decodePatchPayload(value, wall) {
  const text = cleanText(value, 20000)
  if (!text) return []
  if (text.startsWith('[')) return JSON.parse(text)
  if (text.startsWith('v2|')) return decodePatchBitsets(text.slice(3), wall)
  return text.split(';').map(item => {
    const [rawX, rawY, rawColor] = item.split(',')
    return {
      x: Number.parseInt(rawX, 36),
      y: Number.parseInt(rawY, 36),
      color: `#${rawColor || ''}`
    }
  })
}

function decodePatchBitsets(value, wall) {
  const width = Number(wall.width || 0)
  const height = Number(wall.height || 0)
  const total = width * height
  const patch = []
  for (const group of value.split(';')) {
    if (!group) continue
    const [rawColor, rawBytes] = group.split(':')
    const color = `#${rawColor || ''}`
    const bytes = decodeBase64(rawBytes || '')
    for (let index = 0; index < total; index += 1) {
      if ((bytes[Math.floor(index / 8)] || 0) & (1 << (index % 8))) {
        patch.push({x: index % width, y: Math.floor(index / width), color})
      }
    }
  }
  return patch
}

function encodeBase64(bytes) {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += BASE64_ALPHABET[first >> 2]
    output += BASE64_ALPHABET[((first & 3) << 4) | ((second || 0) >> 4)]
    output += index + 1 < bytes.length ? BASE64_ALPHABET[((second & 15) << 2) | ((third || 0) >> 6)] : '='
    output += index + 2 < bytes.length ? BASE64_ALPHABET[third & 63] : '='
  }
  return output
}

function decodeBase64(value) {
  const clean = cleanText(value, 12000).replace(/=+$/, '')
  const bytes = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const code = BASE64_ALPHABET.indexOf(char)
    if (code < 0) continue
    buffer = (buffer << 6) | code
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 255)
    }
  }
  return bytes
}

function normalizeColor(value) {
  const color = cleanText(value, 7).toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new Error('Pixel color must be #rrggbb.')
  return color
}

function ownerWall(wall) {
  return {
    ...publicWall(wall, false),
    walletId: wall.wallet_id || '',
    walletName: wall.wallet_name || ''
  }
}

function publicWall(wall, includeCanvas = true) {
  const view = {
    id: wall.id,
    name: wall.name || '',
    description: wall.description || '',
    width: Number(wall.width || 0),
    height: Number(wall.height || 0),
    pricePerPixel: Number(wall.price_per_pixel || 1),
    enabled: wall.enabled === true,
    paintCount: Number(wall.paint_count || 0),
    paidPixels: Number(wall.paid_pixels || 0),
    createdAt: Number(wall.created_at || 0),
    updatedAt: Number(wall.updated_at || 0)
  }
  if (includeCanvas) view.canvas = wallCanvasMap(wall)
  return view
}

function publicPayment(payment) {
  return {
    id: payment.id,
    wallId: payment.wall_id,
    pixelCount: Number(payment.pixel_count || 0),
    amount: Number(payment.amount || 0),
    status: payment.status || '',
    paidAt: Number(payment.paid_at || 0)
  }
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  if (!Number.isInteger(number)) throw new Error('value must be an integer.')
  if (number < min) throw new Error(`value must be at least ${min}.`)
  if (number > max) throw new Error(`value must be at most ${max}.`)
  return number
}

function normalizePageSize(value) {
  const size = Number(value || 10)
  if (!Number.isInteger(size) || size <= 0) return 10
  return Math.min(size, 100)
}

function normalizePage(value) {
  const page = Number(value || 1)
  if (!Number.isInteger(page) || page <= 0) return 1
  return page
}

function normalizeWallSortBy(value) {
  return (
    {
      name: 'name',
      pricePerPixel: 'price_per_pixel',
      paintCount: 'paint_count',
      paidPixels: 'paid_pixels',
      createdAt: 'created_at'
    }[value] || 'created_at'
  )
}

function requiredText(value, name, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(`${name} is required.`)
  return text
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanId(value) {
  const id = cleanText(value, 128)
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : ''
}

function makeRandomId(prefix) {
  const response = system.id(prefix)
  return response?.id || response || `${prefix}_${system.now()}`
}

function eventPaymentHash(event) {
  return (
    cleanText(event.paymentHash, 128) ||
    cleanText(event.payment_hash, 128) ||
    cleanText(event.payment?.payment_hash, 128) ||
    cleanText(event.payment?.paymentHash, 128) ||
    cleanText(event.checking_id, 128) ||
    cleanText(event.payment?.checking_id, 128)
  )
}
