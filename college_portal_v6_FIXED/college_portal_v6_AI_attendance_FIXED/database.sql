-- ============================================================
--  college_portal — MySQL Database Setup Script
--  Run once:  mysql -u root -p < database.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS college_portal
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE college_portal;

-- ── Users (Admin / Faculty / Staff) ─────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    VARCHAR(50)  NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  role       ENUM('Admin','Faculty','Staff') NOT NULL DEFAULT 'Faculty',
  name       VARCHAR(150) NOT NULL,
  email      VARCHAR(150),
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Students ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS students (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id  VARCHAR(50)  NOT NULL UNIQUE,
  full_name   VARCHAR(150) NOT NULL,
  email       VARCHAR(150),
  department  VARCHAR(100) NOT NULL,
  branch      VARCHAR(100) NOT NULL,
  semester    TINYINT      NOT NULL,
  password    VARCHAR(255) NOT NULL,
  photo_count INT          NOT NULL DEFAULT 0,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ── Face Photos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS photos (
  id          INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id  VARCHAR(50)   NOT NULL,
  filename    VARCHAR(255)  NOT NULL,
  angle       VARCHAR(50),
  angle_index INT,
  file_path   VARCHAR(500),
  captured_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Indexes for fast lookups ──────────────────────────────────
CREATE INDEX idx_photos_student ON photos(student_id);
CREATE INDEX idx_students_dept  ON students(department, branch, semester);

SELECT 'Database setup complete! Tables: users, students, photos' AS status;