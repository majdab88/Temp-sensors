#include "datalog.h"
#include <esp_partition.h>
#include <esp_system.h>

#define SECTOR        4096
#define PER_SECTOR    (SECTOR / sizeof(LogRec))
#define ERASED_SEQ    0xFFFFFFFFUL

static const esp_partition_t* s_part = nullptr;
static uint32_t s_n = 0;   // capacity in records

// Ring position, cached in RTC memory so a deep-sleep wake does not rescan
// 128 KiB. Trusted only on a deep-sleep wake: RTC memory also survives a
// software reset, including the one into a new OTA image, whose layout of RTC
// variables may differ.
//
//   head = next slot to write
//   tail = oldest pending record; tail == head means nothing is pending
//
// The pending range never contains the sector head is about to erase: entering
// a sector erases it first, and if tail was in it the tail moves on (those
// readings are lost, oldest first, and logged as such).
RTC_DATA_ATTR static uint32_t r_magic;
RTC_DATA_ATTR static uint32_t r_head, r_tail, r_nextSeq;
#define LOG_MAGIC 0x57464C47UL   // "WFLG"

static bool readRec(uint32_t idx, LogRec* r) {
  return esp_partition_read(s_part, idx * sizeof(LogRec), r, sizeof(LogRec)) == ESP_OK;
}

static void scan() {
  // Pass 1: the highest sequence number is the newest record; head follows it.
  static LogRec buf[PER_SECTOR];
  uint32_t maxSeq = 0, maxIdx = 0;
  bool any = false;
  for (uint32_t sec = 0; sec < s_n / PER_SECTOR; sec++) {
    esp_partition_read(s_part, sec * SECTOR, buf, SECTOR);
    for (uint32_t i = 0; i < PER_SECTOR; i++) {
      if (buf[i].seq == ERASED_SEQ) continue;
      if (!any || buf[i].seq > maxSeq) { maxSeq = buf[i].seq; maxIdx = sec * PER_SECTOR + i; any = true; }
    }
  }
  r_head    = any ? (maxIdx + 1) % s_n : 0;
  r_nextSeq = any ? maxSeq + 1 : 1;

  // Pass 2: walk from the oldest slot forward to the first pending record.
  r_tail = r_head;
  LogRec rec;
  for (uint32_t k = 0; k < s_n; k++) {
    uint32_t idx = (r_head + k) % s_n;
    if (!readRec(idx, &rec)) break;
    if (rec.seq != ERASED_SEQ && rec.state == 0xFF) { r_tail = idx; break; }
  }
  r_magic = LOG_MAGIC;
  Serial.printf("[LOG] Scanned: head=%lu tail=%lu next seq=%lu, %lu pending\n",
                (unsigned long)r_head, (unsigned long)r_tail,
                (unsigned long)r_nextSeq, (unsigned long)logPending());
}

bool logInit() {
  s_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                    (esp_partition_subtype_t)0x40, "datalog");
  if (!s_part) {
    Serial.println("[LOG] No datalog partition — readings will not be buffered");
    return false;
  }
  s_n = s_part->size / sizeof(LogRec);

  bool cached = esp_reset_reason() == ESP_RST_DEEPSLEEP && r_magic == LOG_MAGIC &&
                r_head < s_n && r_tail < s_n;
  if (!cached) scan();
  return true;
}

uint32_t logPending() {
  if (!s_part) return 0;
  return (r_head + s_n - r_tail) % s_n;
}

bool logAppend(LogRec rec) {
  if (!s_part) return false;

  if (r_head % PER_SECTOR == 0) {
    uint32_t secStart = r_head;
    bool tailInside = logPending() > 0 && r_tail >= secStart && r_tail < secStart + PER_SECTOR;
    if (esp_partition_erase_range(s_part, secStart * sizeof(LogRec), SECTOR) != ESP_OK) {
      Serial.println("[LOG] Sector erase failed");
      return false;
    }
    if (tailInside) {
      uint32_t lost = secStart + PER_SECTOR - r_tail;
      r_tail = (secStart + PER_SECTOR) % s_n;
      Serial.printf("[LOG] Ring full — dropped %lu oldest unsent readings\n", (unsigned long)lost);
    }
  }

  bool wasEmpty = logPending() == 0;
  rec.seq   = r_nextSeq;
  rec.state = 0xFF;
  if (esp_partition_write(s_part, r_head * sizeof(LogRec), &rec, sizeof(rec)) != ESP_OK) {
    Serial.println("[LOG] Write failed");
    return false;
  }
  if (wasEmpty) r_tail = r_head;
  r_head = (r_head + 1) % s_n;
  r_nextSeq++;
  return true;
}

int logPeek(LogRec* out, int max) {
  uint32_t pend = logPending();
  int n = 0;
  for (uint32_t k = 0; k < pend && n < max; k++) {
    if (readRec((r_tail + k) % s_n, &out[n])) n++;
  }
  return n;
}

void logMarkUploaded(int n) {
  const uint8_t zero = 0x00;
  for (int i = 0; i < n && logPending() > 0; i++) {
    esp_partition_write(s_part, r_tail * sizeof(LogRec) + offsetof(LogRec, state), &zero, 1);
    r_tail = (r_tail + 1) % s_n;
  }
}
