-- ============================================================
--  TIMETABLE & FACULTY SYSTEM SETUP
--  Run AFTER database.sql and attendance_setup.sql
--  mysql -u root -p college_portal < timetable_setup.sql
-- ============================================================
USE college_portal;

-- ── Change 'Staff' role to 'Admin' in existing users ─────────
UPDATE users SET role = 'Admin' WHERE role = 'Staff';

-- Alter the ENUM to support Admin (drop & recreate column)
ALTER TABLE users MODIFY COLUMN role ENUM('Admin','Faculty') NOT NULL DEFAULT 'Faculty';

-- ── Faculty Shortcode Mapping ─────────────────────────────────
-- Admin maps shortcodes (LM, PSM, etc.) to full faculty names
-- Each faculty also gets a user_id login
CREATE TABLE IF NOT EXISTS faculty_map (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shortcode    VARCHAR(10)  NOT NULL UNIQUE,   -- e.g. LM, PSM, BRN
  full_name    VARCHAR(150) NOT NULL,
  department   VARCHAR(50)  NOT NULL DEFAULT 'CSE',
  email        VARCHAR(150),
  user_id      VARCHAR(50),   -- links to users table
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Timetable Upload Batches ──────────────────────────────────
-- Each upload = one semester batch (e.g. Odd Sem 2025, semesters 1,3,5,7)
CREATE TABLE IF NOT EXISTS timetable_batches (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_name    VARCHAR(100) NOT NULL,          -- e.g. "Odd Semester 2025"
  sem_type      ENUM('Odd','Even') NOT NULL,    -- Odd=1,3,5,7  Even=2,4,6,8
  academic_year VARCHAR(10)  NOT NULL DEFAULT '2025-2026',
  uploaded_by   VARCHAR(50),                   -- admin user_id
  is_active     TINYINT      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Timetable Slots ───────────────────────────────────────────
-- Each row = one period in the timetable
CREATE TABLE IF NOT EXISTS timetable_slots (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id      INT          NOT NULL,
  semester      TINYINT      NOT NULL,
  branch        VARCHAR(20)  NOT NULL,   -- CSE-A, CSE-B, MECH, EEE …
  day_of_week   ENUM('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') NOT NULL,
  time_slot     VARCHAR(30)  NOT NULL,   -- e.g. '8:00-8:55'
  subject_short VARCHAR(50),            -- e.g. IOT, CL&E, SPM
  subject_full  VARCHAR(200),           -- expanded name
  faculty_code  VARCHAR(10),            -- shortcode like LM
  room_no       VARCHAR(20),            -- e.g. RN-4113
  is_lab        TINYINT      NOT NULL DEFAULT 0,
  notes         VARCHAR(200),
  FOREIGN KEY (batch_id) REFERENCES timetable_batches(id) ON DELETE CASCADE,
  INDEX idx_batch_sem   (batch_id, semester),
  INDEX idx_faculty     (faculty_code),
  INDEX idx_branch_day  (branch, day_of_week)
) ENGINE=InnoDB;

-- ── Seed: default admin seeded if not present ─────────────────
INSERT IGNORE INTO users (user_id, password, role, name)
  VALUES ('ADMIN001', 'admin123', 'Admin', 'Administrator');

SELECT 'Timetable system setup complete!' AS status;
