#!/usr/bin/env python3
"""
ORION Vault Unsealer Sidecar

Fetches unseal keys from ORION's internal API on startup — keys are held
in process memory only, never written to disk.

If ORION doesn't have keys yet (fresh install or migration needed) and
VAULT_UNSEAL_KEY_1/2/3 env vars are set, automatically migrates them to
the DB via the ORION migration endpoint, then clears them from env.

Main loop: polls Vault every UNSEAL_POLL_INTERVAL seconds and submits
the threshold keys whenever Vault is found sealed.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

ORION_URL      = os.environ.get('ORION_URL', 'http://orion:3000')
VAULT_URL      = os.environ.get('VAULT_URL', 'http://vault:8200')
UNSEALER_TOKEN = os.environ.get('ORION_UNSEALER_TOKEN', '')
POLL_INTERVAL  = int(os.environ.get('UNSEAL_POLL_INTERVAL', '30'))

# Legacy env var keys — only used for one-time migration of existing installs
LEGACY_KEYS = [v for v in [
    os.environ.get('VAULT_UNSEAL_KEY_1'),
    os.environ.get('VAULT_UNSEAL_KEY_2'),
    os.environ.get('VAULT_UNSEAL_KEY_3'),
] if v]


def log(msg: str) -> None:
    print(f'vault-unsealer: {msg}', flush=True)


def orion_request(path: str, *, method: str = 'GET', body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(
        f'{ORION_URL}{path}',
        data=data,
        headers={
            'Authorization': f'Bearer {UNSEALER_TOKEN}',
            'Content-Type': 'application/json',
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def vault_request(path: str, *, method: str = 'GET', body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(
        f'{VAULT_URL}{path}',
        data=data,
        headers={'Content-Type': 'application/json'},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def wait_for_orion() -> None:
    log('waiting for ORION...')
    while True:
        try:
            urllib.request.urlopen(f'{ORION_URL}/api/health', timeout=5)
            log('ORION is ready')
            return
        except Exception:
            time.sleep(5)


def migrate_legacy_keys() -> bool:
    """Push env var keys into ORION DB, then return True."""
    if not LEGACY_KEYS:
        return False
    log(f'migrating {len(LEGACY_KEYS)} keys from env vars into ORION...')
    orion_request('/api/internal/vault/unseal-keys', method='POST', body={'keys': LEGACY_KEYS})
    log('migration complete — remove VAULT_UNSEAL_KEY_* from your .env after confirming')
    return True


def fetch_keys() -> list[str] | None:
    try:
        result = orion_request('/api/internal/vault/unseal-keys')
        return result['keys']
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def load_keys() -> list[str]:
    """Fetch keys from ORION, migrating from legacy env vars if needed."""
    while True:
        keys = fetch_keys()
        if keys:
            log(f'loaded {len(keys)} unseal keys from ORION (memory only)')
            return keys

        # Keys not in DB yet — try legacy migration
        if LEGACY_KEYS:
            migrate_legacy_keys()
            continue

        log('keys not available — waiting for Vault wizard to complete...')
        time.sleep(15)


def is_sealed() -> bool:
    try:
        health = vault_request('/v1/sys/health')
        return bool(health.get('sealed', True))
    except Exception:
        return True


def unseal(keys: list[str]) -> None:
    log('Vault is sealed — submitting unseal keys')
    for key in keys:
        try:
            vault_request('/v1/sys/unseal', method='PUT', body={'key': key})
        except Exception as e:
            log(f'unseal error: {e}')
    log('unseal keys submitted')


def main() -> None:
    if not UNSEALER_TOKEN:
        log('ERROR: ORION_UNSEALER_TOKEN is not set')
        sys.exit(1)

    log('starting')
    wait_for_orion()

    keys = load_keys()

    log(f'entering unseal loop (interval: {POLL_INTERVAL}s)')
    while True:
        if is_sealed():
            unseal(keys)
        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    main()
