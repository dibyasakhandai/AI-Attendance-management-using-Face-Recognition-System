// ══════════════════════════════════════════════════════════════
//  PASTE THESE ROUTES INTO server.js  — before the start() call
// ══════════════════════════════════════════════════════════════

// ── FACULTY PROFILE (rich — designation, joining, subjects) ──
app.get('/api/faculty/profile', async (req,res)=>{
  const {userId}=req.query;
  if(!userId) return res.status(400).json({success:false,message:'userId required'});
  try{
    const [fm]=await pool.query(
      `SELECT fm.*, u.user_id AS login_id, u.email AS login_email
       FROM faculty_map fm
       LEFT JOIN users u ON u.user_id = fm.user_id
       WHERE fm.user_id = ?`,[userId]);
    if(!fm.length) return res.status(404).json({success:false,message:'Not mapped. Ask admin to link your account in Faculty Mapping.'});
    const fac=fm[0];
    const [batches]=await pool.query('SELECT id,batch_name FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(batches.length){
      const [subs]=await pool.query(
        `SELECT DISTINCT subject_short, subject_full, semester, branch
         FROM timetable_slots
         WHERE batch_id=? AND faculty_code=? AND subject_short IS NOT NULL AND subject_short NOT IN ('BREAK','LUNCH','LIBRARY','RECESS')
         ORDER BY semester, subject_short`,[batches[0].id, fac.shortcode]);
      fac.subjects_taught=subs;
      fac.active_batch=batches[0].batch_name;
    } else { fac.subjects_taught=[]; fac.active_batch=null; }
    res.json({success:true,faculty:fac});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

// ── FACULTY MY-CLASSES (distinct semester+branch from active timetable) ──
app.get('/api/faculty/my-classes', async (req,res)=>{
  const {userId,facultyCode}=req.query;
  try{
    let code=facultyCode;
    if(!code&&userId){
      const [fm]=await pool.query('SELECT shortcode FROM faculty_map WHERE user_id=?',[userId]);
      if(fm.length) code=fm[0].shortcode;
    }
    if(!code) return res.status(400).json({success:false,message:'Faculty not mapped'});
    const [batches]=await pool.query('SELECT * FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(!batches.length) return res.json({success:true,classes:[],batch:null});
    const [classes]=await pool.query(
      `SELECT ts.semester, ts.branch,
              COUNT(*) AS slot_count,
              GROUP_CONCAT(DISTINCT ts.subject_short ORDER BY ts.subject_short SEPARATOR ', ') AS subjects,
              GROUP_CONCAT(DISTINCT CONCAT(ts.subject_short,'||',COALESCE(ts.subject_full,ts.subject_short)) ORDER BY ts.subject_short SEPARATOR ';;') AS subject_details
       FROM timetable_slots ts
       WHERE ts.batch_id=? AND ts.faculty_code=?
         AND ts.subject_short IS NOT NULL AND ts.subject_short NOT IN ('BREAK','LUNCH','LIBRARY','RECESS')
       GROUP BY ts.semester, ts.branch
       ORDER BY ts.semester, ts.branch`,[batches[0].id,code.toUpperCase()]);
    res.json({success:true,classes,batch:batches[0],facultyCode:code});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

// ── TAKE CLASS ATTENDANCE (manual) ───────────────────────────
app.post('/api/attendance/take-class', async (req,res)=>{
  const {branch,semester,subjectCode,presentStudentIds,allStudentIds}=req.body;
  if(!branch||!semester||!subjectCode||!Array.isArray(allStudentIds)||!allStudentIds.length)
    return res.status(400).json({success:false,message:'Missing required fields'});
  try{
    const presentSet=new Set(presentStudentIds||[]);
    for(const sid of allStudentIds){
      const attended=presentSet.has(sid)?1:0;
      await pool.query(
        `INSERT INTO attendance (student_id,subject_code,semester,classes_held,classes_attended)
         VALUES (?,?,?,1,?)
         ON DUPLICATE KEY UPDATE
           classes_held     = classes_held + 1,
           classes_attended = classes_attended + VALUES(classes_attended),
           updated_at       = NOW()`,
        [sid,subjectCode,semester,attended]);
    }
    res.json({success:true,message:`Attendance saved: ${presentStudentIds?.length||0}/${allStudentIds.length} present`});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

// ── CHANGE FACULTY PASSWORD ───────────────────────────────────
app.put('/api/users/:userId/password', async (req,res)=>{
  const {currentPassword,newPassword}=req.body;
  try{
    const [rows]=await pool.query('SELECT id FROM users WHERE user_id=? AND password=?',[req.params.userId,currentPassword]);
    if(!rows.length) return res.status(400).json({success:false,message:'Current password incorrect'});
    await pool.query('UPDATE users SET password=? WHERE user_id=?',[newPassword,req.params.userId]);
    res.json({success:true,message:'Password updated'});
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});
