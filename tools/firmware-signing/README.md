# Firmware signing

The hub connects to the cloud with `WiFiClientSecure.setInsecure()` — it does not
authenticate the server certificate. The transport therefore proves nothing about
where an image came from. **The ECDSA signature is the only thing preventing an
attacker-supplied image from being flashed**, and it is verified on the device
before the new slot is made bootable.

Curve: NIST P-256 (`prime256v1`), matching `MBEDTLS_ECP_DP_SECP256R1_ENABLED` in
the hub's prebuilt mbedTLS. Digest: SHA-256 over the whole `.bin`.

## One-time setup

```bash
cd tools/firmware-signing
node sign.js keygen
```

This writes `fw-signing-key.pem` and prints a C array. Paste that array over
`FW_PUBLIC_KEY` in `hub/src/main.cpp`, then build and flash the hub.

**The private key must never be committed or copied to the droplet.** The root
`.gitignore` blocks `*.pem`, but the real protection is not putting it anywhere
shared. The droplet only ever stores signatures, never the key.

Back the key up offline. A hub only accepts images signed by the key it was
flashed with, so losing it means every hub needs a USB visit to trust a new one.

## Signing a release

```bash
node sign.js sign fw-signing-key.pem ../../hub/.pio/build/xiao_esp32c6_hub/firmware.bin
```

Prints the size, SHA-256, and base64 signature. Upload the `.bin` through the
dashboard's firmware page and paste in the signature; the backend stores it and
sends it to the hub with the OTA command.

## Key rotation

Rotating means flashing every hub with the new public key first — over OTA,
signed with the **old** key — and only then signing releases with the new one.
Skipping that ordering strands the fleet on firmware it can no longer update.

## Verifying by hand

```bash
openssl ec -in fw-signing-key.pem -pubout -out fw-public.pem
base64 -d <<< "<signature>" > sig.der
openssl dgst -sha256 -verify fw-public.pem -signature sig.der firmware.bin
```
