# Satoshi's Place

Satoshi's Place is an LNbits WebAssembly extension for paid collaborative pixel
walls. It is inspired by `satoshis.place`: users select pixels on a public wall,
pay a Lightning invoice, and the paid invoice event commits the graffiti.

## Extension Details

- Extension ID: `satoshisplacewasm`
- Extension type: `wasm`
- Minimum LNbits version: `1.5.5`
- Admin route: `/ext/satoshisplacewasm`
- Public wall route: `/ext/satoshisplacewasm/walls/{wall_id}`
- WASM module: `wasm/module.wasm`

## How It Works

1. An LNbits user opens the admin page and creates one or more walls.
2. Each wall has a receiving wallet, width, height, and sats-per-pixel price.
3. The owner shares the public wall link.
4. Public visitors select pixels and colors on the wall.
5. The extension creates a public Lightning invoice for the selected pixels.
6. When the invoice is paid, the paid-invoice event applies the pixels.

Public users never write storage directly. The current LNbits WASM runtime only
allows public invoice creation and public reads; the paid event performs the
authoritative wall update.

## Permissions

This extension requests:

- `ext.storage.read` and `ext.storage.write` for owner walls and paid graffiti
  records.
- `ext.storage.read_public` for public wall state.
- `wallet.list` so the admin can choose one of their wallets.
- `wallet.create_invoice_public` so visitors can pay to paint configured walls.

## Build

```bash
cd lnbits/extensions/satoshisplacewasm/dev
npm run build:wasm
```

The build writes `../wasm/module.wasm`.

Static UI changes in `static/` do not require a WASM rebuild, but LNbits or the
browser may need a hard refresh to pick up changed assets.
