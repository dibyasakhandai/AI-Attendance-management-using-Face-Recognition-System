-- ============================================================
--  FACULTY FULL SETUP — TAT College Portal
--  Run:  mysql -u root -p college_portal < faculty_setup.sql
--  This adds profile columns and inserts all 39 CSE faculty
-- ============================================================
USE college_portal;

-- ── Step 1: Add profile columns to faculty_map ───────────────
ALTER TABLE faculty_map
  ADD COLUMN IF NOT EXISTS designation          VARCHAR(100) DEFAULT 'Assistant Professor',
  ADD COLUMN IF NOT EXISTS qualification        VARCHAR(200) DEFAULT 'ME/M.Tech',
  ADD COLUMN IF NOT EXISTS joining_date         VARCHAR(20)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS nature_of_association VARCHAR(50) DEFAULT 'Regular',
  ADD COLUMN IF NOT EXISTS specialization       VARCHAR(200) DEFAULT NULL;

-- ── Step 2: Insert / update faculty_map entries ──────────────
INSERT INTO faculty_map (shortcode, full_name, department, email, designation, qualification, joining_date, nature_of_association, specialization)
VALUES
  ('AB',  'Dr. Abhaya Kumar Samal',      'CSE', 'ab@tat.ac.in',  'Professor & Dean',         'ME/M.Tech and PhD', '01.07.2014', 'Regular', 'Systems & Architecture'),
  ('BRN', 'Dr. Biswaranjan Nayak',       'CSE', 'brn@tat.ac.in', 'Professor',                'ME/M.Tech and PhD', '10.01.2009', 'Regular', 'Networks & Security'),
  ('PKN', 'Dr. Padmabati Chand',         'CSE', 'pkn@tat.ac.in', 'Professor & HOD',          'ME/M.Tech and PhD', '21.09.2006', 'Regular', 'Software Engineering'),
  ('MM',  'Dr. Mahendra Nath Dwibedi',   'CSE', 'mm@tat.ac.in',  'Professor',                'ME/M.Tech and PhD', '14.08.2008', 'Regular', 'Data Mining & AI'),
  ('RS',  'Dr. Rabinarayan Satpathy',    'CSE', 'rs@tat.ac.in',  'Professor',                'ME/M.Tech and PhD', '17.06.2016', 'Regular', 'Machine Learning'),
  ('MNY', 'Dr. Maya Nayak',             'CSE', 'mny@tat.ac.in', 'Professor',                'ME/M.Tech and PhD', '01.08.2023', 'Regular', 'Cloud Computing'),
  ('SBP', 'Dr. Sashi Bhusan Parida',    'CSE', 'sbp@tat.ac.in', 'Associate Professor',      'ME/M.Tech and PhD', '09.05.2005', 'Regular', 'Compiler Design'),
  ('SNR', 'Dr. Sudhansu Ranjan Lenka',  'CSE', 'snr@tat.ac.in', 'Associate Professor',      'ME/M.Tech and PhD', '09.08.2011', 'Regular', 'Theory of Computation'),
  ('SN',  'Dr. Sanjeev Narayan Bal',    'CSE', 'sn@tat.ac.in',  'Associate Professor',      'ME/M.Tech and PhD', '02.07.2014', 'Regular', 'Algorithms & Complexity'),
  ('SCS', 'Dr. Simantika Ray',          'CSE', 'scs@tat.ac.in', 'Associate Professor',      'ME/M.Tech and PhD', '08.08.2014', 'Regular', 'Image Processing'),
  ('DPP', 'Dr. Dakshya Prasad Pati',    'CSE', 'dpp@tat.ac.in', 'Associate Professor',      'ME/M.Tech and PhD', '08.08.2014', 'Regular', 'Distributed Systems'),
  ('MRC', 'Dr. Manas Ranjan Choudhury', 'CSE', 'mrc@tat.ac.in', 'Associate Professor',      'ME/M.Tech and PhD', '22.07.2015', 'Regular', 'Information Security'),
  ('MPD', 'Dr. Madhumita Panda',        'CSE', 'mpd@tat.ac.in', 'Associate Professor',      'ME/M.Tech and PhD', '10.08.2023', 'Regular', 'Natural Language Processing'),
  ('RC',  'Rahul Ranjan',               'CSE', 'rc@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '02.07.2007', 'Regular', 'Programming & OOPS'),
  ('NR',  'Aditya Narayan Das',         'CSE', 'nr@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '28.07.2009', 'Regular', 'Java & Web Technologies'),
  ('BN',  'Basudev Nath',              'CSE', 'bn@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '07.07.2014', 'Regular', 'Computer Networks'),
  ('SIB', 'Sibanand Behera',           'CSE', 'sib@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '07.07.2014', 'Regular', 'Operating Systems'),
  ('SK',  'Sumati Baral',              'CSE', 'sk@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '08.08.2014', 'Regular', 'Database Management'),
  ('DD',  'Dipalika Das',              'CSE', 'dd@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '08.08.2014', 'Regular', 'Data Structures'),
  ('AKS', 'Ashok Kumar Sahoo',         'CSE', 'aks@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '02.07.2015', 'Regular', 'Computer Architecture'),
  ('PK',  'Pratiti Mishra',            'CSE', 'pk@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '02.07.2015', 'Regular', 'Software Testing'),
  ('PS',  'Pralipta Samal',            'CSE', 'ps@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '21.07.2010', 'Regular', 'IoT & Embedded Systems'),
  ('PSM', 'Partha Sarathi Mohapatra',  'CSE', 'psm@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '13.08.2019', 'Regular', 'Cloud & Virtualization'),
  ('SM',  'Sasmita Mishra',            'CSE', 'sm@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '08.08.2011', 'Regular', 'Software Project Management'),
  ('KCD', 'Krushna Chandra Das',       'CSE', 'kcd@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '13.08.2019', 'Regular', 'Machine Learning'),
  ('DPM', 'Debi Prasad Mohanty',       'CSE', 'dpm@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '23.07.2020', 'Regular', 'Big Data Analytics'),
  ('RP',  'Rabiteja Patra',            'CSE', 'rp@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '22.07.2021', 'Regular', 'Deep Learning'),
  ('SSM', 'Shyamalendu Pati',          'CSE', 'ssm@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '22.08.2022', 'Regular', 'Computer Graphics'),
  ('RK',  'Ranjeep Kumar Pradhan',     'CSE', 'rk@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '10.08.2022', 'Regular', 'Cyber Security'),
  ('KSO', 'Kabita Sahoo',             'CSE', 'kso@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '22.08.2022', 'Regular', 'Web Development'),
  ('RD',  'Rani Dubey',               'CSE', 'rd@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '31.08.2022', 'Regular', 'Digital Logic Design'),
  ('YP',  'Yogasambhuta Dash',        'CSE', 'yp@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '10.10.2022', 'Regular', 'Microprocessors'),
  ('TS',  'Siba Prasad Pati',         'CSE', 'ts@tat.ac.in',  'Assistant Professor',      'ME/M.Tech',         '11.10.2022', 'Regular', 'Programming & Data Structures'),
  ('MPM', 'Mohini Prasad Mishra',     'CSE', 'mpm@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '19.12.2022', 'Regular', 'Artificial Intelligence'),
  ('MME', 'Dr. Meena Moharana',       'CSE', 'mme@tat.ac.in', 'Assistant Professor',      'PhD',               '21.07.2025', 'Regular', 'Research Methods'),
  ('DIA', 'Diana Dhal',               'CSE', 'dia@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '11.07.2025', 'Regular', 'Mobile Computing'),
  ('BKS', 'Baisakhi Sahoo',           'CSE', 'bks@tat.ac.in', 'Assistant Professor',      'ME/M.Tech',         '21.07.2025', 'Regular', 'Cloud Services'),
  ('SHS', 'Shradhanjali Sahoo',       'CSE', 'shs@tat.ac.in', 'Assistant Professor',      'MCA',               '18.07.2025', 'Regular', 'Information Systems'),
  ('LM',  'Prof. Lipika Mohanty',     'CSE', 'lm@tat.ac.in',  'Associate Professor',      'ME/M.Tech and PhD', '15.06.2010', 'Regular', 'Advanced Algorithms')
AS new_vals(shortcode, full_name, department, email, designation, qualification, joining_date, nature_of_association, specialization)
ON DUPLICATE KEY UPDATE
  full_name              = new_vals.full_name,
  department             = new_vals.department,
  email                  = new_vals.email,
  designation            = new_vals.designation,
  qualification          = new_vals.qualification,
  joining_date           = new_vals.joining_date,
  nature_of_association  = new_vals.nature_of_association,
  specialization         = new_vals.specialization;

-- ── Step 3: Create login accounts for all faculty ─────────────
-- Default password: Faculty@123  (admin should reset)
INSERT IGNORE INTO users (user_id, password, role, name, email) VALUES
  ('AB',  'Faculty@123', 'Faculty', 'Dr. Abhaya Kumar Samal',      'ab@tat.ac.in'),
  ('BRN', 'Faculty@123', 'Faculty', 'Dr. Biswaranjan Nayak',       'brn@tat.ac.in'),
  ('PKN', 'Faculty@123', 'Faculty', 'Dr. Padmabati Chand',         'pkn@tat.ac.in'),
  ('MM',  'Faculty@123', 'Faculty', 'Dr. Mahendra Nath Dwibedi',   'mm@tat.ac.in'),
  ('RS',  'Faculty@123', 'Faculty', 'Dr. Rabinarayan Satpathy',    'rs@tat.ac.in'),
  ('MNY', 'Faculty@123', 'Faculty', 'Dr. Maya Nayak',              'mny@tat.ac.in'),
  ('SBP', 'Faculty@123', 'Faculty', 'Dr. Sashi Bhusan Parida',     'sbp@tat.ac.in'),
  ('SNR', 'Faculty@123', 'Faculty', 'Dr. Sudhansu Ranjan Lenka',   'snr@tat.ac.in'),
  ('SN',  'Faculty@123', 'Faculty', 'Dr. Sanjeev Narayan Bal',     'sn@tat.ac.in'),
  ('SCS', 'Faculty@123', 'Faculty', 'Dr. Simantika Ray',           'scs@tat.ac.in'),
  ('DPP', 'Faculty@123', 'Faculty', 'Dr. Dakshya Prasad Pati',     'dpp@tat.ac.in'),
  ('MRC', 'Faculty@123', 'Faculty', 'Dr. Manas Ranjan Choudhury',  'mrc@tat.ac.in'),
  ('MPD', 'Faculty@123', 'Faculty', 'Dr. Madhumita Panda',         'mpd@tat.ac.in'),
  ('RC',  'Faculty@123', 'Faculty', 'Rahul Ranjan',                'rc@tat.ac.in'),
  ('NR',  'Faculty@123', 'Faculty', 'Aditya Narayan Das',          'nr@tat.ac.in'),
  ('BN',  'Faculty@123', 'Faculty', 'Basudev Nath',               'bn@tat.ac.in'),
  ('SIB', 'Faculty@123', 'Faculty', 'Sibanand Behera',            'sib@tat.ac.in'),
  ('SK',  'Faculty@123', 'Faculty', 'Sumati Baral',               'sk@tat.ac.in'),
  ('DD',  'Faculty@123', 'Faculty', 'Dipalika Das',               'dd@tat.ac.in'),
  ('AKS', 'Faculty@123', 'Faculty', 'Ashok Kumar Sahoo',          'aks@tat.ac.in'),
  ('PK',  'Faculty@123', 'Faculty', 'Pratiti Mishra',             'pk@tat.ac.in'),
  ('PS',  'Faculty@123', 'Faculty', 'Pralipta Samal',             'ps@tat.ac.in'),
  ('PSM', 'Faculty@123', 'Faculty', 'Partha Sarathi Mohapatra',   'psm@tat.ac.in'),
  ('SM',  'Faculty@123', 'Faculty', 'Sasmita Mishra',             'sm@tat.ac.in'),
  ('KCD', 'Faculty@123', 'Faculty', 'Krushna Chandra Das',        'kcd@tat.ac.in'),
  ('DPM', 'Faculty@123', 'Faculty', 'Debi Prasad Mohanty',        'dpm@tat.ac.in'),
  ('RP',  'Faculty@123', 'Faculty', 'Rabiteja Patra',             'rp@tat.ac.in'),
  ('SSM', 'Faculty@123', 'Faculty', 'Shyamalendu Pati',           'ssm@tat.ac.in'),
  ('RK',  'Faculty@123', 'Faculty', 'Ranjeep Kumar Pradhan',      'rk@tat.ac.in'),
  ('KSO', 'Faculty@123', 'Faculty', 'Kabita Sahoo',               'kso@tat.ac.in'),
  ('RD',  'Faculty@123', 'Faculty', 'Rani Dubey',                 'rd@tat.ac.in'),
  ('YP',  'Faculty@123', 'Faculty', 'Yogasambhuta Dash',          'yp@tat.ac.in'),
  ('TS',  'Faculty@123', 'Faculty', 'Siba Prasad Pati',           'ts@tat.ac.in'),
  ('MPM', 'Faculty@123', 'Faculty', 'Mohini Prasad Mishra',       'mpm@tat.ac.in'),
  ('MME', 'Faculty@123', 'Faculty', 'Dr. Meena Moharana',         'mme@tat.ac.in'),
  ('DIA', 'Faculty@123', 'Faculty', 'Diana Dhal',                 'dia@tat.ac.in'),
  ('BKS', 'Faculty@123', 'Faculty', 'Baisakhi Sahoo',             'bks@tat.ac.in'),
  ('SHS', 'Faculty@123', 'Faculty', 'Shradhanjali Sahoo',         'shs@tat.ac.in'),
  ('LM',  'Faculty@123', 'Faculty', 'Prof. Lipika Mohanty',       'lm@tat.ac.in');

-- ── Step 4: Link faculty_map.user_id to users table ──────────
UPDATE faculty_map fm
JOIN   users u ON u.user_id = fm.shortcode
SET    fm.user_id = fm.shortcode
WHERE  fm.user_id IS NULL OR fm.user_id = '';

SELECT CONCAT('Done! ', COUNT(*), ' faculty accounts ready.') AS status FROM faculty_map;
SELECT 'Login: user_id = shortcode (e.g. SNR), password = Faculty@123' AS login_info;
