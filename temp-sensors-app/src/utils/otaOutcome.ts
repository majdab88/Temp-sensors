// Ported from temp-sensors-cloud/frontend/src/utils/otaOutcome.js -- keep the two in step.
/* eslint-disable */
export interface Outcome { tone: 'bad' | 'info'; text: string; next: string | null }
// What happened to a firmware update, in words, and what to do about it.
//
// The hub reports every outcome with a short machine reason (hub/src/main.cpp:
// publishOtaStatus for its own updates, publishSensorOtaStatus* and the
// sensorOtaDeclineName / sensorOtaResultName tables for a sensor's). The
// Firmware page used to show none of it on the row: a declined or failed
// sensor simply went back to "Send", which looked like the staging had been
// lost. Every reason the firmware can send is listed here; an unknown one is
// still shown, verbatim.
//
// Each entry: text = what happened, next = what to do. Keep the wording
// plain: these are read by whoever has to walk to the node.

const SENSOR_DECLINED: Record<string, { text: string; next: string | null }> = {
  'already on this version': {
    text: 'The sensor is already running this version.',
    next: null,
  },
  'battery too low': {
    // From sensor 1.1.16 the check is the pack voltage under radio load over
    // the last few wakes (2.6 V minimum); before that, a 40 % resting reading.
    text: 'The sensor declined: its battery sags too far under load to be trusted through an update.',
    next: 'Replace the batteries, then Retry and press the sensor’s button.',
  },
  'previous image not confirmed': {
    text: 'The sensor declined: it is still proving its last update, which it does by delivering a reading.',
    next: 'Wait for its next reading, then Retry and press the button.',
  },
  'no usable partition': {
    text: 'The sensor declined: it has no firmware slot to write the update into.',
    next: 'It cannot be updated over the air. Reflash it over USB / ESP-PROG.',
  },
  'image too large': {
    text: 'The sensor declined: this image does not fit in its firmware slot.',
    next: 'This image cannot go on this sensor. Check it was built for this board.',
  },
}

const SENSOR_FAILED: Record<string, { text: string; next: string | null }> = {
  'no free staging slot': {
    text: 'The hub is already holding an image for as many sensors as it can.',
    next: 'Cancel one of the other staged sensors, then Retry.',
  },
  'bad hash or signature': {
    text: 'The hub refused the image: its checksum or signature in the command was malformed.',
    next: 'Re-publish the image, then send it again.',
  },
  'image unreachable': {
    text: 'The hub could not download the image from the server.',
    next: 'Check the server is up, then Retry.',
  },
  'bad url': {
    text: 'The hub could not open the image’s download address.',
    next: 'Re-publish the image, then send it again.',
  },
  'timed out': {
    text: 'The transfer timed out — usually a weak radio link between the sensor and the hub.',
    next: 'Move the sensor closer to the hub, then Retry and press its button.',
  },
  'incomplete - sensor stopped acknowledging': {
    text: 'The sensor stopped answering partway through (out of range, or it lost power). Nothing was installed.',
    next: 'Check its batteries and distance to the hub, then Retry and press the button.',
  },
  'no result - may have installed anyway': {
    text: 'The whole image was sent, but the sensor’s result never arrived. It may have installed anyway.',
    next: 'Its next reading shows the version it runs. If that is still the old one, Retry.',
  },
  'sha256 mismatch': {
    text: 'The image the sensor received does not match its published checksum. Nothing was installed.',
    next: 'Re-publish the image, then send it again.',
  },
  'signature invalid': {
    text: 'The image’s signature did not verify on the sensor: it is not signed with the fleet key. Nothing was installed.',
    next: 'Publish an image signed with the fleet key.',
  },
  'flash write failed': {
    text: 'The sensor could not write the image to its flash.',
    next: 'Retry and press the button. If it fails again, reflash the sensor over USB / ESP-PROG.',
  },
  'not a valid image': {
    text: 'The sensor rejected the image as not valid firmware — possibly built for a different board.',
    next: 'Check the image was built for this sensor’s board.',
  },
}

const HUB_FAILED: Record<string, { text: string; next: string | null }> = {
  'incomplete command': {
    text: 'The hub received an incomplete install command.',
    next: 'Install again; if it repeats, re-publish the image.',
  },
  'previous update not yet confirmed': {
    text: 'The hub is still confirming its last update (it has up to 15 minutes after rebooting).',
    next: 'Install again once that update shows as confirmed.',
  },
  'version previously rolled back on this hub': {
    text: 'This version was installed on this hub before and rolled itself back, so the hub refuses it.',
    next: 'Publish a fixed version instead.',
  },
  'bad sha256 in command': {
    text: 'The install command carried a malformed checksum.',
    next: 'Re-publish the image, then install again.',
  },
  'no OTA partition': {
    text: 'The hub has no slot to install updates into (wrong partition table).',
    next: 'Reflash it over USB with the min_spiffs partition table, without erasing flash.',
  },
  'bad url': {
    text: 'The hub could not open the image’s download address.',
    next: 'Re-publish the image, then install again.',
  },
  'no content-length': {
    text: 'The server did not say how big the image is, so the hub could not start.',
    next: 'Check the firmware server, then install again.',
  },
  'image larger than partition': {
    text: 'The image is too big for the hub’s firmware slot.',
    next: 'Check the image was built for the hub.',
  },
  'ota_begin failed': {
    text: 'The hub could not prepare its flash for the update.',
    next: 'Install again. If it repeats, the hub needs a USB reflash.',
  },
  'download incomplete': {
    text: 'The download stopped partway — the hub’s connection dropped.',
    next: 'Install again.',
  },
  'sha256 mismatch': {
    text: 'The downloaded image does not match its published checksum. Nothing was installed.',
    next: 'Install again; if it repeats, re-publish the image.',
  },
  'signature invalid': {
    text: 'The image’s signature did not verify: it is not signed with the fleet key. Nothing was installed.',
    next: 'Publish an image signed with the fleet key.',
  },
  'image rejected by esp_ota_end': {
    text: 'The hub rejected the downloaded image as not valid firmware.',
    next: 'Check the image was built for the hub.',
  },
  'set_boot_partition failed': {
    text: 'The image was written but the hub could not switch to it.',
    next: 'Install again. If it repeats, the hub needs a USB reflash.',
  },
}

// "http 404" and the like, from either side's download.
function httpReason(error: string | null | undefined, what: string) {
  const m = /^http (-?\d+)$/.exec(error || '')
  if (!m) return null
  const code = Number(m[1])
  return {
    text: code < 0
      ? `The ${what} could not reach the firmware server (connection error ${code}).`
      : `The firmware server answered HTTP ${code} while the ${what} was downloading the image.`,
    next: 'Check the server, then try again.',
  }
}

function unknown(state: string, error: string | null | undefined) {
  return { text: `${state === 'declined' ? 'Declined' : 'Failed'}: ${error || 'no reason given'}.`, next: null }
}

// A reading taken before the update can reach the cloud a moment after the
// hub reports it installed, still carrying the old version. A rollback takes
// three boots, so anything inside this margin is that, not a rollback.
const ROLLBACK_MARGIN_MS = 2 * 60 * 1000

// A transfer that reported no progress for this long was cut off -- most
// likely the hub restarted mid-transfer. The transfer itself gives up after
// 3 minutes plus 45 s waiting for the result.
const SENSOR_SENDING_STALE_MS = 10 * 60 * 1000

/** True when the sensor took this image but is now back on another version. */
export function sensorRolledBack(sen: any, version: string): boolean {
  if (sen.ota_state !== 'installed' || sen.ota_version !== version) return false
  if (!sen.fw_version || sen.fw_version === version) return false
  if (!sen.fw_reported_at || !sen.ota_updated_at) return false
  return new Date(sen.fw_reported_at).getTime() - new Date(sen.ota_updated_at).getTime() > ROLLBACK_MARGIN_MS
}

export function sensorSendingStale(sen: any, now = Date.now()): boolean {
  return sen.ota_state === 'sending' && !!sen.ota_updated_at &&
    now - new Date(sen.ota_updated_at).getTime() > SENSOR_SENDING_STALE_MS
}

/**
 * The outcome to show on a sensor's row for image `version`, or null when
 * there is nothing to explain (never staged, staged, in progress, installed).
 * tone: 'bad' for something that went wrong, 'info' otherwise.
 */
export function sensorOutcome(sen: any, version: string, now = Date.now()): Outcome | null {
  if (sen.ota_version !== version) return null

  if (sensorRolledBack(sen, version)) {
    return {
      tone: 'bad',
      text: `Installed, then rolled back to v${sen.fw_version}: the new firmware did not deliver a reading within three boots, so the sensor returned to its previous version.`,
      next: 'Check the sensor’s log for why the new image could not report.',
    }
  }
  if (sensorSendingStale(sen, now)) {
    return {
      tone: 'bad',
      text: 'The transfer stopped reporting progress — the hub probably restarted or lost power partway. Nothing was installed.',
      next: 'Retry and press the sensor’s button.',
    }
  }
  if (sen.ota_state === 'declined') {
    const r = SENSOR_DECLINED[sen.ota_error] || unknown('declined', sen.ota_error)
    return { tone: sen.ota_error === 'already on this version' ? 'info' : 'bad', ...r } as Outcome
  }
  if (sen.ota_state === 'failed') {
    const r = SENSOR_FAILED[sen.ota_error] || httpReason(sen.ota_error, 'hub') ||
              unknown('failed', sen.ota_error)
    return { tone: 'bad', ...r } as Outcome
  }
  return null
}

/**
 * The outcome to show on a hub's row for image `version`. `ota` is the hub's
 * last reported state ({state, version, error, updatedAt}); `stale` says it
 * has not reported for longer than the page's stale window.
 */
export function hubOutcome(hub: any, ota: any, version: string, stale: boolean): Outcome | null {
  if (!ota) return null
  // A failure before the hub knew which version it was handling (a malformed
  // command) carries none; show it on every card rather than on none.
  if (ota.version && ota.version !== version) return null
  if (hub.fw_version === version) return null

  if (ota.state === 'failed') {
    const r = HUB_FAILED[ota.error] || httpReason(ota.error, 'hub') || unknown('failed', ota.error)
    return { tone: 'bad', ...r } as Outcome
  }
  if (ota.state === 'rebooting' && stale) {
    // Reported its version since the reboot, and it is not this one: it came
    // back on the old image. Otherwise it has not come back at all.
    const reportedSince = hub.fw_reported_at && ota.updatedAt &&
      new Date(hub.fw_reported_at) > new Date(ota.updatedAt)
    return reportedSince ? {
      tone: 'bad',
      text: `Installed and rebooted, but the hub came back on v${hub.fw_version || '?'}: the new firmware could not reach the cloud, so it rolled itself back.`,
      next: 'Check the hub’s serial log for why the new image could not connect.',
    } : {
      tone: 'bad',
      text: 'The hub rebooted into the update and has not reported since.',
      next: 'Check the hub is powered and online. It reverts by itself within about 15 minutes if the new firmware cannot connect.',
    }
  }
  if (stale && !['confirmed', 'uptodate'].includes(ota.state)) {
    return {
      tone: 'bad',
      text: `No progress reported for over 20 minutes (last: ${ota.state}). The hub may be offline or have restarted.`,
      next: 'Install again once the hub is back online.',
    }
  }
  return null
}
