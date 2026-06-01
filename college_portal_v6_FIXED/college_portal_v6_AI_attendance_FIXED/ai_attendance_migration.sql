-- ============================================================
--  AI ATTENDANCE MIGRATION
--  Run AFTER: database.sql, attendance_setup.sql, timetable_setup.sql
--  mysql -u root -p college_portal < ai_attendance_migration.sql
-- ============================================================
USE college_portal;

-- 1. Add face descriptor column to photos table
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS descriptor JSON DEFAULT NULL
  COMMENT '128-dim Float32 face descriptor from face-api.js stored as JSON array';

-- 2. AI attendance sessions table
CREATE TABLE IF NOT EXISTS ai_attendance_sessions (
  id                INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id        VARCHAR(30)  NOT NULL UNIQUE,
  room_no           VARCHAR(20)  DEFAULT NULL,
  slot_id           INT          DEFAULT NULL,
  subject_code      VARCHAR(25)  DEFAULT NULL,
  subject_name      VARCHAR(200) DEFAULT NULL,
  faculty_code      VARCHAR(10)  DEFAULT NULL,
  branch            VARCHAR(20)  NOT NULL,
  semester          TINYINT      NOT NULL,
  time_slot         VARCHAR(30)  DEFAULT NULL,
  day_of_week       VARCHAR(15)  DEFAULT NULL,
  status            ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active',
  start_present_ids JSON         DEFAULT NULL,
  end_present_ids   JSON         DEFAULT NULL,
  final_present_ids JSON         DEFAULT NULL,
  present_count     INT          DEFAULT 0,
  absent_count      INT          DEFAULT 0,
  total_students    INT          DEFAULT 0,
  started_by        VARCHAR(50)  DEFAULT NULL,
  start_captured_at TIMESTAMP    DEFAULT NULL,
  end_captured_at   TIMESTAMP    DEFAULT NULL,
  finalized_at      TIMESTAMP    DEFAULT NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (slot_id) REFERENCES timetable_slots(id) ON DELETE SET NULL,
  INDEX idx_session_date   (created_at),
  INDEX idx_session_branch (branch, semester),
  INDEX idx_session_status (status)
) ENGINE=InnoDB;

SELECT 'AI Attendance migration complete! Tables: ai_attendance_sessions. Column: photos.descriptor' AS status;
