// ============================================================
//  AI Attendance — Unit Tests
//  Run: npm test
//  Install first: npm install --save-dev jest
// ============================================================

// ── Utility functions (copy these into src/aiAttendanceUtils.js) ──

function genSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = 'sess_';
  for (let i = 0; i < 8; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function parseSlot(timeSlot) {
  try {
    const [s, e] = timeSlot.split('-');
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    return { startH: sh, startM: sm, endH: eh, endM: em };
  } catch { return null; }
}

function isTimeInSlot(timeSlot, date = new Date()) {
  const p = parseSlot(timeSlot);
  if (!p) return false;
  const h = date.getHours(), m = date.getMinutes();
  const nowMins = h * 60 + m;
  return nowMins >= p.startH * 60 + p.startM && nowMins <= p.endH * 60 + p.endM;
}

function markAttendanceFromCaptures(startIds, endIds, mode = 'BOTH') {
  if (mode === 'BOTH') {
    const endSet = new Set(endIds);
    return startIds.filter(id => endSet.has(id));
  } else {
    return [...new Set([...startIds, ...endIds])];
  }
}

function deduplicateRecognitions(matches) {
  const seen = new Set();
  return matches.filter(m => {
    if (seen.has(m.studentId)) return false;
    seen.add(m.studentId);
    return true;
  });
}

function buildAbsentList(allStudentIds, presentIds) {
  const presentSet = new Set(presentIds);
  return allStudentIds.filter(id => !presentSet.has(id));
}

function validateDescriptor(descriptor) {
  return Array.isArray(descriptor) && descriptor.length === 128 && descriptor.every(v => typeof v === 'number');
}

// ── TESTS ─────────────────────────────────────────────────────

describe('genSessionId', () => {
  test('generates ID matching pattern sess_[a-z0-9]{8}', () => {
    const id = genSessionId();
    expect(id).toMatch(/^sess_[a-z0-9]{8}$/);
  });

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => genSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe('parseSlot', () => {
  test('parses 8:00-8:55 correctly', () => {
    const p = parseSlot('8:00-8:55');
    expect(p.startH).toBe(8);
    expect(p.startM).toBe(0);
    expect(p.endH).toBe(8);
    expect(p.endM).toBe(55);
  });

  test('parses 14:00-14:55', () => {
    const p = parseSlot('14:00-14:55');
    expect(p.startH).toBe(14);
    expect(p.endH).toBe(14);
    expect(p.endM).toBe(55);
  });

  test('returns null for invalid slot', () => {
    expect(parseSlot('invalid')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseSlot('')).toBeNull();
  });
});

describe('isTimeInSlot', () => {
  test('returns true for time inside slot', () => {
    const d = new Date('2026-04-27T08:30:00');
    expect(isTimeInSlot('8:00-8:55', d)).toBe(true);
  });

  test('returns true at exact start time', () => {
    const d = new Date('2026-04-27T08:00:00');
    expect(isTimeInSlot('8:00-8:55', d)).toBe(true);
  });

  test('returns true at exact end time', () => {
    const d = new Date('2026-04-27T08:55:00');
    expect(isTimeInSlot('8:00-8:55', d)).toBe(true);
  });

  test('returns false for time after slot ends', () => {
    const d = new Date('2026-04-27T09:05:00');
    expect(isTimeInSlot('8:00-8:55', d)).toBe(false);
  });

  test('returns false for time before slot starts', () => {
    const d = new Date('2026-04-27T07:50:00');
    expect(isTimeInSlot('8:00-8:55', d)).toBe(false);
  });

  test('returns false for invalid slot string', () => {
    expect(isTimeInSlot('', new Date())).toBe(false);
  });
});

describe('markAttendanceFromCaptures', () => {
  test('BOTH mode: returns intersection of start and end', () => {
    const start = ['S001', 'S002', 'S003'];
    const end   = ['S001', 'S003', 'S004'];
    const present = markAttendanceFromCaptures(start, end, 'BOTH');
    expect(present.sort()).toEqual(['S001', 'S003']);
  });

  test('BOTH mode: empty if no overlap', () => {
    const present = markAttendanceFromCaptures(['S001', 'S002'], ['S003', 'S004'], 'BOTH');
    expect(present).toEqual([]);
  });

  test('BOTH mode: full overlap returns all', () => {
    const ids = ['S001', 'S002', 'S003'];
    const present = markAttendanceFromCaptures(ids, ids, 'BOTH');
    expect(present.sort()).toEqual(['S001', 'S002', 'S003']);
  });

  test('EITHER mode: returns union', () => {
    const start = ['S001', 'S002'];
    const end   = ['S002', 'S003'];
    const present = markAttendanceFromCaptures(start, end, 'EITHER');
    expect(present.sort()).toEqual(['S001', 'S002', 'S003']);
  });

  test('EITHER mode: deduplicates', () => {
    const present = markAttendanceFromCaptures(['S001', 'S001'], ['S001'], 'EITHER');
    expect(present).toHaveLength(1);
  });

  test('handles empty start capture', () => {
    const present = markAttendanceFromCaptures([], ['S001', 'S002'], 'EITHER');
    expect(present.sort()).toEqual(['S001', 'S002']);
  });

  test('handles empty end capture', () => {
    const present = markAttendanceFromCaptures(['S001'], [], 'BOTH');
    expect(present).toEqual([]);
  });

  test('handles both empty', () => {
    expect(markAttendanceFromCaptures([], [], 'BOTH')).toEqual([]);
    expect(markAttendanceFromCaptures([], [], 'EITHER')).toEqual([]);
  });
});

describe('deduplicateRecognitions', () => {
  test('removes duplicate student recognitions', () => {
    const matches = [
      { studentId: 'S001', timestamp: 1000 },
      { studentId: 'S001', timestamp: 5000 },
      { studentId: 'S002', timestamp: 3000 },
    ];
    const unique = deduplicateRecognitions(matches);
    expect(unique).toHaveLength(2);
    expect(unique.map(m => m.studentId)).toEqual(['S001', 'S002']);
  });

  test('keeps first occurrence', () => {
    const matches = [
      { studentId: 'S001', timestamp: 1000 },
      { studentId: 'S001', timestamp: 2000 },
    ];
    const unique = deduplicateRecognitions(matches);
    expect(unique[0].timestamp).toBe(1000);
  });

  test('handles empty array', () => {
    expect(deduplicateRecognitions([])).toEqual([]);
  });

  test('handles single item', () => {
    const matches = [{ studentId: 'S001', timestamp: 1000 }];
    expect(deduplicateRecognitions(matches)).toHaveLength(1);
  });
});

describe('buildAbsentList', () => {
  test('returns students not in present set', () => {
    const all = ['S001', 'S002', 'S003', 'S004', 'S005'];
    const present = ['S001', 'S003'];
    expect(buildAbsentList(all, present).sort()).toEqual(['S002', 'S004', 'S005']);
  });

  test('returns all as absent if present is empty', () => {
    const all = ['S001', 'S002'];
    expect(buildAbsentList(all, [])).toEqual(['S001', 'S002']);
  });

  test('returns empty if all are present', () => {
    const all = ['S001', 'S002'];
    expect(buildAbsentList(all, all)).toEqual([]);
  });

  test('present + absent length equals total', () => {
    const all = ['S001', 'S002', 'S003', 'S004'];
    const present = ['S001', 'S003'];
    const absent = buildAbsentList(all, present);
    expect(present.length + absent.length).toBe(all.length);
  });
});

describe('validateDescriptor', () => {
  test('returns true for valid 128-dim float array', () => {
    const desc = Array.from({ length: 128 }, () => Math.random());
    expect(validateDescriptor(desc)).toBe(true);
  });

  test('returns false for wrong length', () => {
    expect(validateDescriptor(Array(64).fill(0.5))).toBe(false);
    expect(validateDescriptor(Array(256).fill(0.5))).toBe(false);
  });

  test('returns false for non-number values', () => {
    const bad = Array(128).fill('0.5');
    expect(validateDescriptor(bad)).toBe(false);
  });

  test('returns false for non-array', () => {
    expect(validateDescriptor(null)).toBe(false);
    expect(validateDescriptor('string')).toBe(false);
    expect(validateDescriptor({})).toBe(false);
  });

  test('returns false for empty array', () => {
    expect(validateDescriptor([])).toBe(false);
  });
});

// Export for potential use in other test files
module.exports = {
  genSessionId, parseSlot, isTimeInSlot,
  markAttendanceFromCaptures, deduplicateRecognitions,
  buildAbsentList, validateDescriptor
};
