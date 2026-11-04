# Scanning products: QR codes, barcodes, labels and the Scan Product page

Step 15. Everything here lives in the existing Inventory Service and Organization Portal (`/scan`, `/products/<id>/codes`).

## What a code is

Every product can have:

| Code | Where it comes from | Used for |
| :--- | :--- | :--- |
| **Impex label code**, e.g. `IMX-7K2M9QW4ZR3P` | Generated once per product (button *Generate QR code & barcode*). Random: it does **not** contain the SKU or the product id. | Printed on labels as a **QR code** and a **Code 128** barcode. Both contain exactly this text. |
| **Manufacturer / supplier barcode**, e.g. `5901234123457` | Registered by the administrator (typed, or scanned into the box). | Scanning goods that already carry a barcode. |
| **SKU** | The product's SKU. | Typing, or any label that prints the SKU as a barcode. |

Rules (also enforced by the database):

* A code is **per organization**. Two organizations may use the same SKU or the same barcode text for different products; inside one organization a code can identify **one** product only (`UNIQUE (organization_id, value)`).
* The label code is **independent of the SKU**. Renaming a SKU never changes or moves a code, and giving the old SKU to a new product does not give it the old product's labels. Manufacturer barcodes are attached to the product, never to the SKU.
* A code is **retired, never deleted or re-pointed** (a database trigger refuses both). A retired barcode stays reserved for its product, cannot silently go to another one, and scanning it answers "retired". The Impex label code cannot be retired because printed labels depend on it.
* If a barcode of product A and the SKU of product B are ever the same text, scanning it is **ambiguous**: the portal says so instead of guessing. (Registering such a barcode is refused up front; the check at scan time covers a SKU that is created or renamed later.)
* Codes use letters, digits and `. _ : / + -` (up to 64 characters, no spaces). Matching is case-insensitive.
* A scanned QR code is **text**. If it looks like a link (`https://…`, `javascript:…`, `data:…`) it is refused and never opened, fetched or followed, by the browser or the service.

## What scanning does (and does not) do

1. The scan only **looks the product up** (`GET /api/v1/inventory/scan/resolve?code=…`, read-only). The organization comes from the signed-in administrator's token, never from the request, so another organization's product is "not found", exactly like a code that does not exist.
2. The page shows the product (name, SKU, unit), stock per warehouse, **total** and **available** stock (available = in active warehouses only), and *Stock In / Stock Out / Transfer*.
3. Pressing an action opens the normal Step 14 form for that product. **Review** shows a plain summary (*"Remove 5 pcs of Steel bolt from MAIN?"*); only **Confirm** sends the request, with an `Idempotency-Key`. A double click or a retry applies once. Negative stock and fractions of indivisible units (pcs, box, …) are refused exactly as before.
4. Nothing changes inventory merely because a code was scanned.

Duplicate protection: the same code arriving twice within 1.5 s (a double Enter, a sticky trigger) is ignored; a camera, which sees the same label on every frame, is ignored for 4 s and stops itself after the first code.

## Labels

*Products → Codes* opens **Codes & labels**: generate the code, see the label (product name, SKU, QR code, Code 128 barcode and the code in text), choose the number of copies (1-24) and press **Print label**. Only the label is printed (the header and controls are hidden). Set the paper size to your label size in the browser's print dialog. Labels are drawn 72 mm wide; scale in the print dialog if your label stock differs. Generated QR codes use error-correction level M.

## Desktop and hardware scanners

USB and Bluetooth scanners in **keyboard-emulation (HID) mode** work with no software: keep the cursor in the *Scan or type…* box (it is focused when the page opens and after each scan) and scan. Configure the scanner to send **Enter** after the code (most do by default); a **Tab** suffix or a leading AIM identifier (`]C0`, `]Q1`, `]E0`) is also stripped. Typing a SKU or barcode by hand and pressing Enter or *Look up* is the same thing. The same box is used on the *Codes & labels* page to register a barcode by scanning it.

A scanner's Enter pressed while the *Confirm* question is showing does nothing (only an actual press on **Confirm** counts).

## Camera scanning

Press **Use camera**, then **Start camera**. The browser asks for permission **only then**. Decoding happens inside the browser tab (the browser's built-in `BarcodeDetector` where it exists, otherwise [`@zxing/browser`](https://github.com/zxing-js/library), pure JavaScript): **no video or image is ever sent to the server**; only the text of the code that was read is looked up. The camera is switched off when a code is read, when you press *Stop camera* / *Hide camera*, and when you leave the page. Formats: QR, Code 128, Code 39/93, EAN-13/8, UPC-A/E, ITF, Codabar.

Clear messages are shown for: permission blocked, page not served over HTTPS, browser without camera support, no camera, camera in use.

### The HTTPS requirement (important for phones)

Browsers expose the camera **only to secure contexts**: pages served over **`https://`**, or from **`localhost`**. Therefore

* `http://localhost:3001` on the same computer works.
* `http://192.168.1.20:3001` from a phone on the local network does **not**: the page loads, but the browser refuses the camera and the portal says *"The camera needs a secure (HTTPS) connection"*. (The text boxes and hardware scanners still work.)
* In **production** the portal must be served over HTTPS (TLS terminated by your load balancer or reverse proxy, with a real certificate). The portal marks its session cookie `Secure` automatically when the request arrives as HTTPS (`X-Forwarded-Proto: https`); make your proxy send that header.

**Local testing from a phone** (any of these):

1. *Bundled optional HTTPS proxy (recommended).*
   ```powershell
   docker compose --profile https up -d https-proxy
   # export the certificate authority the proxy created, and install it on the phone
   docker compose cp https-proxy:/data/caddy/pki/authorities/local/root.crt ./impex-local-root.crt
   ```
   Find your computer's LAN address (`ipconfig`, e.g. `192.168.1.20`), make sure Windows Firewall allows inbound TCP **3443**, and open **`https://192.168.1.20:3443`** on the phone (same Wi-Fi).
   *Android:* Settings → Security → Encryption & credentials → Install a certificate → **CA certificate** → pick `impex-local-root.crt`. *iPhone:* send the file to the phone (AirDrop/e-mail), open it, Settings → *Profile Downloaded* → Install, then Settings → General → About → **Certificate Trust Settings** → enable it. Without installing it you can still tap through the browser's certificate warning on most phones, which is fine for a quick test.
   This proxy is **for local testing only**. Remove the root certificate from the phone afterwards.
2. *A tunnel with a real certificate* (for example `cloudflared tunnel --url http://localhost:3001` or `ngrok http 3001`) gives a public `https://` address to the portal. Remember it is reachable from the internet while it runs: stop it when done.
3. *Chrome on Android, development only:* `chrome://flags/#unsafely-treat-insecure-origin-as-secure` → add `http://192.168.1.20:3001` → relaunch.

DEMO_MODE and the login flow are unchanged by any of this.

## Testing procedure

See "Mobile and desktop test procedure" at the end of the Step 15 report, or run the automated checks:

```powershell
docker compose run --rm --no-deps inventory-service sh -c "pip install -q -r requirements-dev.txt && python -m pytest -q"
docker build --target test -t impex-dashboard-test ./frontend/dashboard ; docker run --rm impex-dashboard-test
python scripts/verify_scanning.py          # live end-to-end check (creates and removes its own throwaway data)
```

## Manual checklist

Desktop with a keyboard-emulation scanner (or just type in the box):

1. Products → *Codes* on a product → **Generate QR code & barcode** → label appears; **Print label** shows only the label.
2. Open **Scan Product**. The cursor is already in the box. Scan the printed label (or type the code, or the SKU) + Enter → the product, its units, stock by warehouse, total and available appear. *Stock history is unchanged.*
3. Scan it twice quickly → one lookup. Scan a different label → the page switches products.
4. **Stock In** → choose a warehouse, quantity → **Review** → check the summary → **Confirm**. Stock and *Movements* update; the movement records your e-mail.
5. **Stock Out** with more than is there → refused with the exact available quantity. A fraction for *pcs* → refused. Unit *kg* accepts `1.25`.
6. Scan an unknown code, a retired barcode, an archived product's code → clear message each time; archived shows its stock but offers no actions.
7. Type `https://example.com` → "looks like a web link… not opened".
8. Products → *Edit* a product that has stock history → the Unit field is locked with an explanation.

Phone (over HTTPS, see above):

1. Sign in on the phone; open **Scan Product** (the menu wraps on small screens).
2. Tap **Use camera** → nothing is requested yet. Tap **Start camera** → the permission prompt appears now. *Deny* it first → "Camera access was blocked" and *Try the camera again*; allow it from the browser's site settings and retry.
3. Point at the label's QR code → the product appears and the camera switches off (the camera indicator goes out). Repeat with the Code 128 barcode and with a manufacturer barcode registered on a product.
4. Open the portal over plain `http://<LAN IP>:3001` → the same button explains that HTTPS is needed.
5. Use **Stock In** from the phone: all buttons are at least 44 px high; **Review → Confirm** protects against accidental taps.
6. Turn the phone sideways, and use a tablet-sized window on a desktop: the layout adapts.
7. Leave the page while the camera is running (or lock the phone) → the camera light goes out.
