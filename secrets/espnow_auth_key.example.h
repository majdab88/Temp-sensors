// Template for secrets/espnow_auth_key.h, which is NOT in git.
//
// The hub and every sensor sign their ESP-NOW messages with this key (HMAC-
// SHA256, see authTag() in both firmwares). It used to be committed, and the
// repository is public, so anyone could forge readings and configuration for
// any node in radio range. The old value is still in git history and is only
// accepted during the move to a new one (AUTH_KEY_OLD on the hub).
//
// Create the real file once, on the machine that builds and publishes firmware:
//
//   python -c "import secrets; k=secrets.token_bytes(32); print('#pragma once\n#define ESPNOW_AUTH_KEY_BYTES { ' + ', '.join('0x%02X'%b for b in k) + ' }')" > secrets/espnow_auth_key.h
//
// Back it up with fw-signing-key.pem. Every device must carry the same value,
// so losing it means generating a new one and rotating the whole fleet: a hub
// that accepts both keys, then every sensor updated, then the hub without the
// old one.
//
// A worktree does not see the main checkout's copy (it is ignored, so it is
// not checked out); copy secrets/espnow_auth_key.h into the worktree to build.
#pragma once
#error "Copy secrets/espnow_auth_key.example.h to secrets/espnow_auth_key.h and fill in a generated key (instructions above)."
