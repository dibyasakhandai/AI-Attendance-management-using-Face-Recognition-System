-- ============================================================
--  Run this AFTER database.sql
--  mysql -u root -p college_portal < attendance_setup.sql
-- ============================================================
USE college_portal;

-- Add extra fields to students if not already there
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS section      VARCHAR(20)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS session      VARCHAR(10)  DEFAULT '2025-2026',
  ADD COLUMN IF NOT EXISTS class_roll   VARCHAR(10)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS discipline   VARCHAR(50)  DEFAULT 'B.TECH.';

-- ── Subjects (BPUT syllabus) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subjects (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  subject_code VARCHAR(25)  NOT NULL,
  subject_name VARCHAR(200) NOT NULL,
  branch       VARCHAR(15)  NOT NULL COMMENT 'CSE|ECE|EEE|MECH|CIVIL|IT|ALL',
  semester     TINYINT      NOT NULL,
  credits      TINYINT      DEFAULT 3,
  INDEX idx_branch_sem (branch, semester)
) ENGINE=InnoDB;

-- ── Attendance ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id               INT         NOT NULL AUTO_INCREMENT PRIMARY KEY,
  student_id       VARCHAR(50) NOT NULL,
  subject_code     VARCHAR(25) NOT NULL,
  semester         TINYINT     NOT NULL,
  classes_held     INT         NOT NULL DEFAULT 0,
  classes_attended INT         NOT NULL DEFAULT 0,
  academic_year    VARCHAR(10) DEFAULT '2025-2026',
  updated_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_stu_sub_sem (student_id, subject_code, semester),
  FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
  INDEX idx_student_sem (student_id, semester)
) ENGINE=InnoDB;

-- ── SEED: BPUT B.Tech Subjects ────────────────────────────────
-- Semester 1  (common all branches)
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
('BS0001',    'Mathematics-I',                        'ALL', 1, 4),
('BS0002A',   'Physics',                              'ALL', 1, 3),
('ES0001A',   'Basic Electrical Engineering',         'ALL', 1, 3),
('ES0002A',   'Basic Mechanical Engineering',         'ALL', 1, 3),
('HS0001',    'Communicative English',                'ALL', 1, 3);

-- Semester 2  (common all branches)
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
('BS0002B',   'Chemistry',                            'ALL', 2, 3),
('BS0003',    'Mathematics-II',                       'ALL', 2, 4),
('ES0001B',   'Basic Electronics Engineering',        'ALL', 2, 3),
('ES0002B',   'Basic Civil Engineering',              'ALL', 2, 3),
('ES0004',    'Engineering Mechanics',                'ALL', 2, 3),
('ES0005',    'Programming Language',                 'ALL', 2, 3);

-- ── CSE ──────────────────────────────────────────────────────
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
-- Sem 3
('RCS3C001',  'Digital Logic Design',                 'CSE', 3, 3),
('RCS3C002',  'Data Structure',                       'CSE', 3, 3),
('RMA3A001',  'Mathematics-III',                      'CSE', 3, 4),
('PC3112',    'Object Oriented Programming (Java)',   'CSE', 3, 3),
('HS3102',    'Organizational Behavior',              'CSE', 3, 3),
('RES3F001',  'Environmental Science',                'CSE', 3, 2),
-- Sem 4
('RCS4C001',  'Computer Organization & Architecture', 'CSE', 4, 3),
('RCS4C002',  'Operating System',                     'CSE', 4, 3),
('RCS4C003',  'Microprocessor & Interfacing',         'CSE', 4, 3),
('RMA4A001',  'Numerical Methods',                    'CSE', 4, 3),
('RCS4C004',  'Discrete Mathematics',                 'CSE', 4, 3),
('RCS4C005',  'Software Engineering',                 'CSE', 4, 3),
-- Sem 5
('RCS5C001',  'Computer Networks',                    'CSE', 5, 3),
('RCS5C002',  'Database Management System',           'CSE', 5, 3),
('RCS5C003',  'Design & Analysis of Algorithm',       'CSE', 5, 3),
('RCS5C004',  'Theory of Computation',                'CSE', 5, 3),
('RCS5E001',  'Elective-I (Big Data Analytics)',      'CSE', 5, 3),
('RCS5C005',  'Web Technology',                       'CSE', 5, 3),
-- Sem 6
('RCS6C001',  'Compiler Design',                      'CSE', 6, 3),
('RCS6C002',  'Computer Graphics & Multimedia',       'CSE', 6, 3),
('RCS6C003',  'Information Security',                 'CSE', 6, 3),
('RCS6C004',  'Mobile Computing',                     'CSE', 6, 3),
('RCS6E001',  'Elective-II (Artificial Intelligence)','CSE', 6, 3),
('RCS6C005',  'Object Oriented Software Engineering', 'CSE', 6, 3),
-- Sem 7
('RCS7E001',  'Elective-III (Machine Learning)',      'CSE', 7, 3),
('RCS7E002',  'Elective-IV (Internet of Things)',     'CSE', 7, 3),
('RCS7P001',  'Project Phase-I',                      'CSE', 7, 4),
('RCS7S001',  'Seminar',                              'CSE', 7, 2),
-- Sem 8
('RCS8P001',  'Project Phase-II',                     'CSE', 8, 6),
('RCS8S001',  'Comprehensive Viva',                   'CSE', 8, 2);

-- ── ECE ──────────────────────────────────────────────────────
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
('REC3C001',  'Signals & Systems',                    'ECE', 3, 3),
('REC3C002',  'Electronic Devices & Circuits',        'ECE', 3, 3),
('RMA3A001E', 'Mathematics-III',                      'ECE', 3, 4),
('REC3C003',  'Network Theory',                       'ECE', 3, 3),
('REC3C004',  'Digital Electronics',                  'ECE', 3, 3),
('RES3F001E', 'Environmental Science',                'ECE', 3, 2),
('REC4C001',  'Analog Communication',                 'ECE', 4, 3),
('REC4C002',  'Electromagnetic Field Theory',         'ECE', 4, 3),
('REC4C003',  'Microprocessor & Microcontroller',     'ECE', 4, 3),
('RMA4A001E', 'Numerical Methods',                    'ECE', 4, 3),
('REC4C004',  'Control Systems',                      'ECE', 4, 3),
('REC4C005',  'VLSI Design',                          'ECE', 4, 3),
('REC5C001',  'Digital Communication',                'ECE', 5, 3),
('REC5C002',  'Antenna & Wave Propagation',           'ECE', 5, 3),
('REC5C003',  'Microwave Engineering',                'ECE', 5, 3),
('REC5C004',  'Digital Signal Processing',            'ECE', 5, 3),
('REC5E001',  'Elective-I (Embedded Systems)',        'ECE', 5, 3),
('REC5C005',  'Computer Communication Networks',      'ECE', 5, 3);

-- ── EEE ──────────────────────────────────────────────────────
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
('REE3C001',  'Electrical Machines-I',                'EEE', 3, 3),
('REE3C002',  'Circuit Theory',                       'EEE', 3, 3),
('RMA3A001W', 'Mathematics-III',                      'EEE', 3, 4),
('REE3C003',  'Electromagnetic Theory',               'EEE', 3, 3),
('REE3C004',  'Electronic Devices & Circuits',        'EEE', 3, 3),
('RES3F001W', 'Environmental Science',                'EEE', 3, 2),
('REE4C001',  'Electrical Machines-II',               'EEE', 4, 3),
('REE4C002',  'Power Systems-I',                      'EEE', 4, 3),
('REE4C003',  'Control Systems',                      'EEE', 4, 3),
('REE4C004',  'Measurement & Instrumentation',        'EEE', 4, 3),
('REE4C005',  'Analog Electronics',                   'EEE', 4, 3),
('RMA4A001W', 'Numerical Methods',                    'EEE', 4, 3);

-- ── MECH ─────────────────────────────────────────────────────
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
('RME3C001',  'Manufacturing Technology',             'MECH', 3, 3),
('RME3C002',  'Fluid Mechanics',                      'MECH', 3, 3),
('RMA3A001M', 'Mathematics-III',                      'MECH', 3, 4),
('RME3C003',  'Thermodynamics',                       'MECH', 3, 3),
('RME3C004',  'Mechanics of Solid',                   'MECH', 3, 3),
('RES3F001M', 'Environmental Science',                'MECH', 3, 2),
('RME4C001',  'Theory of Machines',                   'MECH', 4, 3),
('RME4C002',  'Heat Transfer',                        'MECH', 4, 3),
('RME4C003',  'Machine Design',                       'MECH', 4, 3),
('RME4C004',  'Industrial Engineering',               'MECH', 4, 3),
('RME4C005',  'Metrology & Quality Control',          'MECH', 4, 3),
('RMA4A001M', 'Numerical Methods',                    'MECH', 4, 3);

-- ── CIVIL ────────────────────────────────────────────────────
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
('RCE3C001',  'Structural Analysis-I',                'CIVIL', 3, 3),
('RCE3C002',  'Fluid Mechanics',                      'CIVIL', 3, 3),
('RMA3A001C', 'Mathematics-III',                      'CIVIL', 3, 4),
('RCE3C003',  'Building Materials & Construction',    'CIVIL', 3, 3),
('RCE3C004',  'Surveying',                            'CIVIL', 3, 3),
('RES3F001C', 'Environmental Science',                'CIVIL', 3, 2),
('RCE4C001',  'Structural Analysis-II',               'CIVIL', 4, 3),
('RCE4C002',  'Hydraulics & Hydraulic Machines',      'CIVIL', 4, 3),
('RCE4C003',  'Geotechnical Engineering-I',           'CIVIL', 4, 3),
('RCE4C004',  'Transportation Engineering',           'CIVIL', 4, 3),
('RCE4C005',  'Environmental Engineering',            'CIVIL', 4, 3),
('RMA4A001C', 'Numerical Methods',                    'CIVIL', 4, 3);

-- ── IT ───────────────────────────────────────────────────────
INSERT INTO subjects (subject_code, subject_name, branch, semester, credits) VALUES
('RIT3C001',  'Digital Logic & Computer Organization','IT', 3, 3),
('RIT3C002',  'Data Structures',                      'IT', 3, 3),
('RMA3A001I', 'Mathematics-III',                      'IT', 3, 4),
('RIT3C003',  'OOP with Java',                        'IT', 3, 3),
('HS3102I',   'Organizational Behavior',              'IT', 3, 3),
('RES3F001I', 'Environmental Science',                'IT', 3, 2),
('RIT4C001',  'Computer Architecture',                'IT', 4, 3),
('RIT4C002',  'Operating Systems',                    'IT', 4, 3),
('RIT4C003',  'Database Systems',                     'IT', 4, 3),
('RIT4C004',  'Computer Networks',                    'IT', 4, 3),
('RIT4C005',  'Software Engineering',                 'IT', 4, 3),
('RMA4A001I', 'Numerical Methods',                    'IT', 4, 3);

SELECT 'Attendance setup complete! Subjects seeded for CSE, ECE, EEE, MECH, CIVIL, IT.' AS status;
