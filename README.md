# Satoshi's Place

Satoshi's Place is an LNbits WebAssembly extension for paid collaborative pixel
walls. It is inspired by `satoshis.place`: an LNbits user creates public walls,
visitors choose pixels and colors, pay a Lightning invoice, and the paid invoice
event commits the graffiti to the wall.

<img width="1920" height="947" alt="image" src="https://github.com/user-attachments/assets/c7517f70-b143-4fff-89fb-3404bd8837d8" />

## Extension Details

- Extension ID: `satoshisplacewasm`
- Extension type: `wasm`
- Minimum LNbits version: `1.5.5`
- Admin route: `/ext/satoshisplacewasm`
- Public wall route: `/ext/satoshisplacewasm/walls/{wall_id}`
- WASM module: `wasm/module.wasm`

## Features

- Create multiple public pixel walls from the LNbits extension admin page.
- Configure wall name, description, width, height, receiving wallet, sats per
  pixel, and whether the wall accepts new graffiti.
- Share a public wall link with anyone.
- Public visitors paint by dragging across the canvas, choose a color, and pay a
  Lightning invoice for the selected pixels.
- Paid invoice events apply the selected pixels to the wall.
- Owners can copy public links, list walls, search walls, and delete walls.
- Canvas state is stored sparsely so blank walls and large one-color paints do
  not create oversized WASM responses.

## How It Works

1. The LNbits user opens `/ext/satoshisplacewasm`.
2. The user creates a wall and selects the wallet that will receive paint
   payments.
3. The extension stores the wall in owner-scoped WASM storage.
4. The owner shares the public wall URL.
5. A public visitor selects pixels and clicks **Pay to Paint**.
6. The extension creates a public Lightning invoice against the configured wall.
7. When LNbits emits the paid-invoice event, the WASM component validates the
   invoice metadata and applies the pixels.

Public visitors never write storage directly. Public routes only read the public
wall state and create invoices. The paid-invoice event is the authoritative
write path for graffiti.

## Payment Model

The invoice amount is:

```text
selected pixels * sats per pixel
```

The selected patch is encoded into invoice metadata so the paid event knows
which pixels to apply. The extension uses compact encodings for patch metadata:

- A short coordinate list for small selections.
- A color bitset for large same-color selections.

This keeps normal drawing flows under LNbits' invoice metadata limit while
avoiding an arbitrary pixel-count cap.

## Permissions

This extension requests:

- `ext.storage.read` to read owner walls and payment records.
- `ext.storage.write` to create/delete walls and apply paid graffiti.
- `ext.storage.read_public` to expose safe public wall fields.
- `wallet.list` so the admin can select a receiving wallet.
- `wallet.create_invoice_public` so public visitors can pay to paint configured
  walls without exposing wallet IDs.

## Public Data

Public wall responses include:

- Wall ID, name, and description.
- Width, height, price per pixel, enabled state.
- Sparse canvas state.
- Paint count, paid pixel count, and timestamps.

Public responses do not include wallet IDs, payment hashes, preimages, account
IDs, or owner-scoped metadata.

## Build

```bash
rustup target add wasm32-wasip2
cd dev
npm run build:wasm
```

The build writes:

```text
../wasm/module.wasm
```

Static UI changes in `static/` do not require a WASM rebuild, but LNbits or the
browser may need a hard refresh to pick up changed assets. Backend changes in
`dev/src/` require rebuilding `wasm/module.wasm`.

## Development Checks

Run from the extension repository root.

```bash
npm --prefix dev run check
node --check static/admin.js
node --check static/public.js
node --check static/lnbits-extension-sdk.js
```

## Runtime Notes

- Public WASM routes cannot write extension storage directly.
- Wall updates therefore happen from the paid-invoice event, not from the public
  paint request.
- If the public invoice modal says the payment listener disconnected, the page
  falls back to polling the public wall until the paid pixels appear.
- If LNbits is already running, restart or reload the extension after rebuilding
  `wasm/module.wasm`.
