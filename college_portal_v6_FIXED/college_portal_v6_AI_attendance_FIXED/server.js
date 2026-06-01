const express       = require('express');
const cors          = require('cors');
const multer        = require('multer');
const fs            = require('fs');
const path          = require('path');
const mysql         = require('mysql2/promise');
const http          = require('http');
const { spawn }     = require('child_process');

const app  = express();
const PORT = 3000;
const FACE_ENGINE_PORT = 5001;  // Python face_engine.py

// ── Auto-spawn face_engine.py if not already running ─────────────────────────
let _faceEngineProc  = null;
let _engineStatus    = 'stopped';   // 'stopped' | 'starting' | 'running' | 'error'
let _engineError     = '';
let _spawnAttempts   = 0;
const MAX_SPAWN_ATTEMPTS = 3;

function spawnFaceEngine() {
  // Already running or starting
  if (_faceEngineProc && !_faceEngineProc.killed) return;
  // Gave up after repeated failures
  if (_spawnAttempts >= MAX_SPAWN_ATTEMPTS && _engineStatus === 'error') return;

  const enginePath = path.join(__dirname, 'face_engine.py');
  if (!fs.existsSync(enginePath)) {
    _engineStatus = 'error';
    _engineError  = `face_engine.py not found at: ${enginePath}`;
    console.error('[FaceEngine]', _engineError);
    return;
  }

  // Try python, python3, py in order (covers all Windows/Linux setups)
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];

  function tryNext(i) {
    if (i >= candidates.length) {
      _engineStatus = 'error';
      _engineError  = 'Python not found. Install Python 3 and add it to PATH.';
      console.error('[FaceEngine]', _engineError);
      return;
    }
    const cmd = candidates[i];
    _engineStatus = 'starting';
    _spawnAttempts++;
    console.log(`[FaceEngine] Spawning: ${cmd} face_engine.py (attempt ${_spawnAttempts})`);

    const proc = spawn(cmd, [enginePath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    let started = false;

    proc.stdout.on('data', d => {
      const msg = d.toString();
      process.stdout.write(`[FaceEngine] ${msg}`);
      if (msg.includes('HTTP server started') || msg.includes('Running on http')) {
        started = true;
        _engineStatus = 'running';
        _spawnAttempts = 0;   // reset on success
        _engineError = '';
      }
    });
    proc.stderr.on('data', d => process.stderr.write(`[FaceEngine:ERR] ${d}`));

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        // This python command doesn't exist, try next
        tryNext(i + 1);
      } else {
        _engineStatus = 'error';
        _engineError  = err.message;
        console.error('[FaceEngine] Spawn error:', err.message);
      }
    });

    proc.on('exit', (code) => {
      console.log(`[FaceEngine] Exited with code ${code}`);
      _faceEngineProc = null;
      if (!started && _spawnAttempts < MAX_SPAWN_ATTEMPTS) {
        // Crashed before serving — wait 2s then retry
        setTimeout(() => spawnFaceEngine(), 2000);
      } else if (!started) {
        _engineStatus = 'error';
        _engineError  = `Python exited with code ${code}. Check that opencv-python and numpy are installed.`;
      } else {
        _engineStatus = 'stopped';
      }
    });

    _faceEngineProc = proc;
  }

  tryNext(0);
}

// Expose engine status to the browser via /py/engine-status
// (separate from /py/status which proxies to Python)
app.get('/py/engine-status', (req, res) => {
  res.json({ status: _engineStatus, error: _engineError, attempts: _spawnAttempts });
});

// Auto-start when Node boots
spawnFaceEngine();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const pool = mysql.createPool({
  host:'localhost', user:'root', password:'D@040405ibs',
  database:'college_portal', waitForConnections:true, connectionLimit:10
});

async function testDB(){
  try{ const c=await pool.getConnection(); console.log('✅ MySQL connected'); c.release(); }
  catch(e){ console.error('❌ MySQL failed:',e.message); process.exit(1); }
}

// Photo storage
const storage = multer.diskStorage({
  destination:(req,file,cb)=>{ const d=path.join(__dirname,'public','photos',req.params.studentId||'unknown'); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:(req,file,cb)=>cb(null,`${Date.now()}_${file.originalname}`)
});
const upload = multer({storage});

// Timetable file storage
const ttStorage = multer.diskStorage({
  destination:(req,file,cb)=>{ const d=path.join(__dirname,'uploads','timetables'); fs.mkdirSync(d,{recursive:true}); cb(null,d); },
  filename:(req,file,cb)=>cb(null,`${Date.now()}_${file.originalname}`)
});
const ttUpload = multer({ storage:ttStorage, limits:{fileSize:10*1024*1024},
  fileFilter:(req,file,cb)=>{ const ok=['.pdf','.xlsx','.xls','.csv']; const ext=path.extname(file.originalname).toLowerCase(); ok.includes(ext)?cb(null,true):cb(new Error('Only PDF/Excel/CSV allowed')); }
});

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/login', async (req,res)=>{
  const {userId,password,role}=req.body;
  try{
    const [students]=await pool.query('SELECT * FROM students WHERE student_id=? AND password=?',[userId,password]);
    if(students.length>0&&(role==='Student'||!role)){
      const s=students[0]; return res.json({success:true,role:'Student',name:s.full_name,data:s});
    }
    const [users]=await pool.query('SELECT * FROM users WHERE user_id=? AND password=?',[userId,password]);
    if(users.length>0){
      const u=users[0];
      if(u.role==='Faculty'){
        const [fm]=await pool.query('SELECT * FROM faculty_map WHERE user_id=?',[u.user_id]);
        u.facultyInfo=fm.length>0?fm[0]:null;
      }
      return res.json({success:true,role:u.role,name:u.name,data:u});
    }
    res.status(401).json({success:false,message:'Invalid credentials'});
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── STUDENTS ──────────────────────────────────────────────────
app.post('/api/students', async (req,res)=>{
  const {studentId,fullName,email,department,branch,semester,section,session,classRoll,discipline,password}=req.body;
  if(!studentId||!fullName||!department||!branch||!semester||!password)
    return res.status(400).json({success:false,message:'Missing required fields'});
  try{
    const [ex]=await pool.query('SELECT id FROM students WHERE student_id=?',[studentId]);
    if(ex.length>0) return res.status(400).json({success:false,message:'Student ID already exists'});
    // Auto-set section from branch if not provided (e.g. branch='CSE-B' -> section='CSE-B')
    const effectiveSection = section || branch;
    const [result]=await pool.query(
      `INSERT INTO students (student_id,full_name,email,department,branch,semester,section,session,class_roll,discipline,password) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [studentId,fullName,email||null,department,branch,semester,effectiveSection,session||'2025-2026',classRoll||null,discipline||'B.TECH.',password]
    );
    fs.mkdirSync(path.join(__dirname,'public','photos',studentId),{recursive:true});
    const [rows]=await pool.query('SELECT * FROM students WHERE id=?',[result.insertId]);
    res.json({success:true,message:'Student registered',student:rows[0]});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

app.get('/api/students', async (req,res)=>{
  try{
    const {branch,semester,section}=req.query;
    let q=`SELECT s.*,COUNT(p.id) AS photo_count FROM students s LEFT JOIN photos p ON p.student_id=s.student_id`;
    const params=[]; const conds=[];
    if(branch){conds.push('s.branch=?');params.push(branch);}
    if(semester){conds.push('s.semester=?');params.push(semester);}
    if(section){conds.push('s.section=?');params.push(section);}
    if(conds.length) q+=' WHERE '+conds.join(' AND ');
    q+=' GROUP BY s.id ORDER BY s.full_name ASC';
    const [rows]=await pool.query(q,params); res.json(rows);
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.get('/api/students/:studentId', async (req,res)=>{
  try{
    const [rows]=await pool.query('SELECT * FROM students WHERE student_id=?',[req.params.studentId]);
    if(!rows.length) return res.status(404).json({success:false,message:'Not found'});
    const s=rows[0];
    const [photos]=await pool.query('SELECT * FROM photos WHERE student_id=? ORDER BY captured_at ASC',[req.params.studentId]);
    s.photos=photos; s.photoCount=photos.length; res.json(s);
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.delete('/api/students/:studentId', async (req,res)=>{
  try{
    await pool.query('DELETE FROM photos WHERE student_id=?',[req.params.studentId]);
    await pool.query('DELETE FROM attendance WHERE student_id=?',[req.params.studentId]);
    await pool.query('DELETE FROM students WHERE student_id=?',[req.params.studentId]);
    res.json({success:true,message:'Student deleted'});
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.put('/api/students/:studentId/password', async (req,res)=>{
  const {currentPassword,newPassword}=req.body;
  try{
    const [rows]=await pool.query('SELECT id FROM students WHERE student_id=? AND password=?',[req.params.studentId,currentPassword]);
    if(!rows.length) return res.status(400).json({success:false,message:'Current password incorrect'});
    await pool.query('UPDATE students SET password=? WHERE student_id=?',[newPassword,req.params.studentId]);
    res.json({success:true,message:'Password changed'});
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── PHOTOS ────────────────────────────────────────────────────
// ── STORE FACE DESCRIPTOR (called from browser after face-api processes a photo) ─
app.post('/api/students/:studentId/photos/:photoId/descriptor', async (req,res)=>{
  const {descriptor}=req.body;
  const {studentId,photoId}=req.params;
  if(!descriptor||!Array.isArray(descriptor)) return res.status(400).json({success:false,message:'descriptor array required'});
  try{
    await pool.query('UPDATE photos SET descriptor=? WHERE id=? AND student_id=?',[JSON.stringify(descriptor),photoId,studentId]);
    res.json({success:true});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

app.post('/api/students/:studentId/photos', async (req,res)=>{
  const {studentId}=req.params; const {imageData,angle,index}=req.body;
  try{
    const [rows]=await pool.query('SELECT id,full_name FROM students WHERE student_id=?',[studentId]);
    if(!rows.length) return res.status(404).json({success:false,message:'Student not found'});
    const dir=path.join(__dirname,'public','photos',studentId); fs.mkdirSync(dir,{recursive:true});
    // Write name.txt so the Python face engine can resolve student names
    const namePath=path.join(dir,'name.txt');
    if(!fs.existsSync(namePath) && rows[0].full_name) fs.writeFileSync(namePath, rows[0].full_name);
    const fn=`${angle}_${index}_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(dir,fn),Buffer.from(imageData.replace(/^data:image\/\w+;base64,/,''),'base64'));
    const [ins]=await pool.query('INSERT INTO photos (student_id,filename,angle,angle_index,file_path) VALUES(?,?,?,?,?)',[studentId,fn,angle,index,`/photos/${studentId}/${fn}`]);
    const [[{photo_count}]]=await pool.query('SELECT COUNT(*) AS photo_count FROM photos WHERE student_id=?',[studentId]);
    await pool.query('UPDATE students SET photo_count=? WHERE student_id=?',[photo_count,studentId]);

    // Auto-trigger Python face engine reload after all 50 photos are saved,
    // so the new student is immediately visible on the AI Attendance camera.
    if(photo_count >= 50){
      try{
        const http=require('http');
        const opts={hostname:'127.0.0.1',port:5001,path:'/reload',method:'POST'};
        const pyReq=http.request(opts); pyReq.on('error',()=>{}); pyReq.end();
        console.log(`[INFO] Triggered face engine reload after ${photo_count} photos for ${studentId}`);
      }catch(_){}
    }

    res.json({success:true,photoId:ins.insertId,photoCount:photo_count,filename:fn});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

app.get('/api/students/:studentId/photos', async (req,res)=>{
  try{ const [p]=await pool.query('SELECT * FROM photos WHERE student_id=? ORDER BY captured_at ASC',[req.params.studentId]); res.json(p); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── STATS (lightweight counts for admin overview) ─────────────
app.get('/api/stats/counts', async (req,res)=>{
  try{
    const [[sc]] = await pool.query('SELECT COUNT(*) AS cnt FROM students');
    const [[fc]] = await pool.query('SELECT COUNT(*) AS cnt FROM faculty_map');
    res.json({students: sc.cnt, faculty: fc.cnt});
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── SUBJECTS ──────────────────────────────────────────────────
app.get('/api/subjects/:branch/:semester', async (req,res)=>{
  try{
    const [rows]=await pool.query(`SELECT * FROM subjects WHERE (branch=? OR branch='ALL') AND semester=? ORDER BY id ASC`,[req.params.branch.toUpperCase(),req.params.semester]);
    res.json(rows);
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── ATTENDANCE ────────────────────────────────────────────────
app.get('/api/attendance/:studentId/:semester', async (req,res)=>{
  const {studentId,semester}=req.params;
  try{
    // ── Get student section for exact timetable match ────────
    const [st]=await pool.query('SELECT branch,section FROM students WHERE student_id=?',[studentId]);
    if(!st.length) return res.status(404).json({success:false,message:'Student not found'});
    const branchBase   = (st[0].branch||'CSE').toUpperCase();
    const sectionFilter= (st[0].section||'').toUpperCase()||null;

    // ── Use active timetable as the SINGLE SOURCE OF TRUTH ───
    const [batches]=await pool.query('SELECT id FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(!batches.length) return res.json([]);
    const batchId=batches[0].id;

    const branchCondition = sectionFilter ? 'ts.branch=?' : '(ts.branch=? OR ts.branch LIKE ?)';
    const branchParams    = sectionFilter ? [sectionFilter] : [branchBase, branchBase+'%'];

    // One row per unique subject from timetable, LEFT JOIN actual attendance
    const [rows]=await pool.query(
      `SELECT ts.subject_short                              AS subject_code,
              MAX(ts.subject_full)                          AS subject_name,
              COALESCE(MAX(a.classes_held),0)               AS classes_held,
              COALESCE(MAX(a.classes_attended),0)           AS classes_attended,
              COALESCE(MAX(a.academic_year),'2025-2026')    AS academic_year,
              3                                             AS credits
       FROM timetable_slots ts
       LEFT JOIN attendance a
         ON a.subject_code=ts.subject_short AND a.student_id=? AND a.semester=?
       WHERE ts.batch_id=? AND ts.semester=?
         AND ${branchCondition}
         AND ts.subject_short IS NOT NULL
         AND ts.subject_short NOT IN ('BREAK','LUNCH','LIBRARY','RECESS','')
       GROUP BY ts.subject_short
       ORDER BY ts.subject_short ASC`,
      [studentId, semester, batchId, semester, ...branchParams]
    );
    res.json(rows);
  }catch(e){ console.error(e); res.status(500).json({success:false,message:'Server error'}); }
});

app.get('/api/attendance/:studentId', async (req,res)=>{
  try{
    const [rows]=await pool.query(`SELECT semester,SUM(classes_held) AS total_held,SUM(classes_attended) AS total_attended FROM attendance WHERE student_id=? GROUP BY semester ORDER BY semester`,[req.params.studentId]);
    res.json(rows);
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.post('/api/attendance', async (req,res)=>{
  const {studentId,subjectCode,semester,classesHeld,classesAttended,academicYear}=req.body;
  if(!studentId||!subjectCode||!semester) return res.status(400).json({success:false,message:'Missing fields'});
  try{
    await pool.query(`INSERT INTO attendance (student_id,subject_code,semester,classes_held,classes_attended,academic_year) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE classes_held=VALUES(classes_held),classes_attended=VALUES(classes_attended),academic_year=VALUES(academic_year),updated_at=NOW()`,
      [studentId,subjectCode,semester,classesHeld||0,classesAttended||0,academicYear||'2025-2026']);
    res.json({success:true,message:'Attendance updated'});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

app.post('/api/attendance/bulk', async (req,res)=>{
  const {records}=req.body;
  if(!Array.isArray(records)||!records.length) return res.status(400).json({success:false,message:'No records'});
  try{
    for(const r of records)
      await pool.query(`INSERT INTO attendance (student_id,subject_code,semester,classes_held,classes_attended) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE classes_held=VALUES(classes_held),classes_attended=VALUES(classes_attended),updated_at=NOW()`,
        [r.studentId,r.subjectCode,r.semester,r.classesHeld||0,r.classesAttended||0]);
    res.json({success:true,message:`${records.length} records updated`});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

// ── FACULTY MAP ───────────────────────────────────────────────
app.get('/api/faculty-map', async (req,res)=>{
  try{ const [r]=await pool.query('SELECT * FROM faculty_map ORDER BY shortcode ASC'); res.json(r); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.post('/api/faculty-map', async (req,res)=>{
  const {shortcode,fullName,department,email,userId}=req.body;
  if(!shortcode||!fullName) return res.status(400).json({success:false,message:'shortcode and fullName required'});
  try{
    await pool.query(`INSERT INTO faculty_map (shortcode,full_name,department,email,user_id) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE full_name=VALUES(full_name),department=VALUES(department),email=VALUES(email),user_id=VALUES(user_id)`,
      [shortcode.toUpperCase(),fullName,department||'CSE',email||null,userId||null]);
    res.json({success:true,message:'Faculty mapping saved'});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

app.delete('/api/faculty-map/:shortcode', async (req,res)=>{
  try{ await pool.query('DELETE FROM faculty_map WHERE shortcode=?',[req.params.shortcode.toUpperCase()]); res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── USERS (admin manages) ─────────────────────────────────────
app.get('/api/users', async (req,res)=>{
  try{ const [r]=await pool.query("SELECT id,user_id,role,name,email,created_at FROM users ORDER BY created_at DESC"); res.json(r); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.post('/api/users', async (req,res)=>{
  const {userId,password,role,name,email}=req.body;
  if(!userId||!password||!name) return res.status(400).json({success:false,message:'userId, password, name required'});
  try{
    const [ex]=await pool.query('SELECT id FROM users WHERE user_id=?',[userId]);
    if(ex.length) return res.status(400).json({success:false,message:'User ID already exists'});
    await pool.query('INSERT INTO users (user_id,password,role,name,email) VALUES(?,?,?,?,?)',[userId,password,role||'Faculty',name,email||null]);
    res.json({success:true,message:'User created'});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

app.delete('/api/users/:userId', async (req,res)=>{
  try{ await pool.query("DELETE FROM users WHERE user_id=? AND role!='Admin'",[req.params.userId]); res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── TIMETABLE BATCHES ─────────────────────────────────────────
app.get('/api/timetable/batches', async (req,res)=>{
  try{
    const [r]=await pool.query(`SELECT b.*,COUNT(s.id) AS slot_count FROM timetable_batches b LEFT JOIN timetable_slots s ON s.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC`);
    res.json(r);
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.post('/api/timetable/batches', async (req,res)=>{
  const {batchName,semType,academicYear,uploadedBy}=req.body;
  if(!batchName||!semType) return res.status(400).json({success:false,message:'batchName and semType required'});
  try{
    const [r]=await pool.query('INSERT INTO timetable_batches (batch_name,sem_type,academic_year,uploaded_by) VALUES(?,?,?,?)',[batchName,semType,academicYear||'2025-2026',uploadedBy||null]);
    res.json({success:true,batchId:r.insertId,message:'Batch created'});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

app.delete('/api/timetable/batches/:id', async (req,res)=>{
  try{ await pool.query('DELETE FROM timetable_batches WHERE id=?',[req.params.id]); res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.patch('/api/timetable/batches/:id/active', async (req,res)=>{
  try{ await pool.query('UPDATE timetable_batches SET is_active=? WHERE id=?',[req.body.isActive?1:0,req.params.id]); res.json({success:true}); }
  catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── TIMETABLE SLOTS ───────────────────────────────────────────
app.post('/api/timetable/slots/bulk', async (req,res)=>{
  const {batchId,slots}=req.body;
  if(!batchId||!Array.isArray(slots)||!slots.length) return res.status(400).json({success:false,message:'batchId and slots required'});
  try{
    await pool.query('DELETE FROM timetable_slots WHERE batch_id=?',[batchId]);
    for(const s of slots)
      await pool.query(`INSERT INTO timetable_slots (batch_id,semester,branch,day_of_week,time_slot,subject_short,subject_full,faculty_code,room_no,is_lab,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        [batchId,s.semester,s.branch,s.dayOfWeek,s.timeSlot,s.subjectShort||null,s.subjectFull||null,s.facultyCode||null,s.roomNo||null,s.isLab?1:0,s.notes||null]);
    res.json({success:true,inserted:slots.length});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

app.get('/api/timetable/slots/:batchId', async (req,res)=>{
  try{
    const {branch,semester}=req.query;
    let q=`SELECT ts.*,fm.full_name AS faculty_name FROM timetable_slots ts LEFT JOIN faculty_map fm ON fm.shortcode=ts.faculty_code WHERE ts.batch_id=?`;
    const p=[req.params.batchId];
    if(branch){q+=' AND ts.branch=?';p.push(branch);}
    if(semester){q+=' AND ts.semester=?';p.push(semester);}
    q+=` ORDER BY FIELD(ts.day_of_week,'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'),ts.time_slot`;
    const [rows]=await pool.query(q,p); res.json(rows);
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── FACULTY TIMETABLE ─────────────────────────────────────────
app.get('/api/faculty/timetable', async (req,res)=>{
  const {userId,facultyCode}=req.query;
  try{
    let code=facultyCode;
    if(!code&&userId){
      const [fm]=await pool.query('SELECT shortcode FROM faculty_map WHERE user_id=?',[userId]);
      if(fm.length) code=fm[0].shortcode;
    }
    if(!code) return res.status(400).json({success:false,message:'Faculty shortcode not found. Ask admin to map your account.'});
    const [batches]=await pool.query('SELECT * FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(!batches.length) return res.json({success:true,slots:[],batch:null,facultyCode:code});
    const batch=batches[0];
    const [slots]=await pool.query(
      `SELECT ts.* FROM timetable_slots ts WHERE ts.batch_id=? AND ts.faculty_code=?
       ORDER BY FIELD(ts.day_of_week,'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'),ts.time_slot`,
      [batch.id,code.toUpperCase()]
    );
    res.json({success:true,batch,slots,facultyCode:code});
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

app.get('/api/faculty/class-students', async (req,res)=>{
  const {branch,semester,section}=req.query;
  if(!branch||!semester) return res.status(400).json({success:false,message:'branch and semester required'});
  try{
    // branch from timetable_slots is stored as e.g. 'CSE-B'
    // students table stores branch='CSE', section='CSE-B'
    // So we must match students.section = timetable branch (CSE-B)
    // OR if branch has no dash, match by students.branch directly
    let q=`SELECT student_id,full_name,email,section,class_roll FROM students WHERE semester=?`;
    const p=[semester];

    if(branch.includes('-')){
      // branch = 'CSE-B': match students where section=CSE-B
      q+=` AND (section=? OR branch=?)`;
      p.push(branch, branch);
    } else if(section){
      // branch='CSE', section='CSE-B': match by section
      q+=` AND section=?`;
      p.push(section);
    } else {
      // branch only (e.g. 'EEE', 'MECH'): match by branch or department
      q+=` AND (branch=? OR department LIKE ?)`;
      p.push(branch, `%${branch}%`);
    }
    q+=' ORDER BY full_name ASC';
    const [rows]=await pool.query(q,p); res.json(rows);
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ── FILE UPLOAD ───────────────────────────────────────────────
app.post('/api/timetable/upload', ttUpload.single('timetableFile'), (req,res)=>{
  if(!req.file) return res.status(400).json({success:false,message:'No file uploaded'});
  res.json({success:true,filename:req.file.filename,original:req.file.originalname,size:req.file.size,mimetype:req.file.mimetype,message:'File uploaded successfully'});
});

// ── START ─────────────────────────────────────────────────────
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
  const {branch,semester,subjectCode,presentStudentIds,allStudentIds,date}=req.body;
  if(!branch||!semester||!subjectCode||!Array.isArray(allStudentIds)||!allStudentIds.length)
    return res.status(400).json({success:false,message:'Missing required fields'});
  try{
    const classDate = date || new Date().toISOString().slice(0,10); // YYYY-MM-DD
    const presentSet=new Set((presentStudentIds||[]).map(id=>String(id)));
    const allStudentIds_str = allStudentIds.map(id=>String(id));
    // Check if attendance was already recorded today for this subject+semester
    const [existing]=await pool.query(
      'SELECT id FROM attendance_log WHERE subject_code=? AND semester=? AND class_date=? LIMIT 1',
      [subjectCode, semester, classDate]
    );
    if(existing.length)
      return res.json({success:false, message:`Attendance for ${subjectCode} on ${classDate} was already recorded. To re-record, please contact admin.`});
    for(const sid of allStudentIds_str){
      const attended=presentSet.has(sid)?1:0;
      await pool.query(
        `INSERT IGNORE INTO attendance_log (student_id,subject_code,semester,class_date,status,recorded_by)
         VALUES(?,?,?,?,?,?)`,
        [sid, subjectCode, semester, classDate, attended?'present':'absent', req.headers['x-user-id']||'faculty']
      );
      await pool.query(
        `INSERT INTO attendance (student_id,subject_code,semester,classes_held,classes_attended)
         VALUES (?,?,?,1,?)
         ON DUPLICATE KEY UPDATE
           classes_held     = classes_held + 1,
           classes_attended = classes_attended + VALUES(classes_attended),
           updated_at       = NOW()`,
        [sid,subjectCode,semester,attended]);
    }
    res.json({success:true,message:`Attendance saved for ${classDate}: ${presentStudentIds?.length||0}/${allStudentIds.length} present`});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

// ── FACULTY ATTENDANCE SUMMARY (per subject, per class) ───────
// Returns per-student attendance counts for a subject taught by this faculty
app.get('/api/faculty/attendance-summary', async (req,res)=>{
  const {branch, semester, subjectCode} = req.query;
  if(!branch||!semester||!subjectCode)
    return res.status(400).json({success:false,message:'branch, semester and subjectCode required'});
  try{
    // Strip section suffix from branch so we can match students table
    const baseBranch = branch.replace(/[_\-][A-Z0-9]+$/i,'').toUpperCase();
    const [rows]=await pool.query(
      `SELECT
         s.student_id,
         s.full_name,
         s.class_roll,
         COALESCE(a.classes_held,0)      AS classes_held,
         COALESCE(a.classes_attended,0)  AS classes_attended,
         COALESCE(
           ROUND(a.classes_attended/NULLIF(a.classes_held,0)*100,1),
           0
         ) AS percentage
       FROM students s
       LEFT JOIN attendance a
         ON a.student_id=s.student_id
        AND a.subject_code=?
        AND a.semester=?
       WHERE s.semester=?
         AND (s.branch=? OR s.branch=? OR s.section=?)
       ORDER BY s.full_name ASC`,
      [subjectCode, semester, semester, branch, baseBranch, branch]
    );
    // Also get day-wise log for last 30 days
    const [log]=await pool.query(
      `SELECT student_id, class_date, status
       FROM attendance_log
       WHERE subject_code=? AND semester=? AND class_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       ORDER BY class_date DESC`,
      [subjectCode, semester]
    );
    res.json({success:true, records:rows, log});
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


// ── BULK FACULTY IMPORT (CSV or TXT) ─────────────────────────
app.post("/api/faculty/bulk-import", async (req,res)=>{
  const {rows} = req.body;
  if(!Array.isArray(rows)||!rows.length) return res.status(400).json({success:false,message:"No rows provided"});
  let inserted=0, updated=0, errors=[];
  for(const r of rows){
    const sc=(r.shortcode||r.code||r.Shortcode||r.Code||"").trim().toUpperCase();
    const name=(r.full_name||r.name||r.Full_Name||r.Name||"").trim();
    if(!sc||!name){ errors.push("Skipped: missing shortcode or name"); continue; }
    const email=r.email||r.Email||sc.toLowerCase()+"@tat.ac.in";
    const pwd=r.password||r.Password||"Faculty@123";
    const dept=r.department||r.Department||"CSE";
    const desig=r.designation||r.Designation||"Assistant Professor";
    const qual=r.qualification||r.Qualification||"ME/M.Tech";
    const jdate=r.joining_date||r.joining||null;
    const noa=r.nature_of_association||r.nature||"Regular";
    const spec=r.specialization||null;
    try{
      const [ex]=await pool.query("SELECT shortcode FROM faculty_map WHERE shortcode=?",[sc]);
      if(ex.length){
        await pool.query("UPDATE faculty_map SET full_name=?,department=?,email=?,designation=?,qualification=?,joining_date=?,nature_of_association=?,specialization=? WHERE shortcode=?",[name,dept,email,desig,qual,jdate,noa,spec,sc]);
        updated++;
      } else {
        await pool.query("INSERT INTO faculty_map (shortcode,full_name,department,email,designation,qualification,joining_date,nature_of_association,specialization,user_id) VALUES(?,?,?,?,?,?,?,?,?,?)",[sc,name,dept,email,desig,qual,jdate,noa,spec,sc]);
        inserted++;
      }
      await pool.query("INSERT IGNORE INTO users (user_id,password,role,name,email) VALUES(?,?,'Faculty',?,?)",[sc,pwd,name,email]);
      await pool.query("UPDATE faculty_map SET user_id=? WHERE shortcode=? AND (user_id IS NULL OR user_id='')",[sc,sc]);
    }catch(e){ errors.push(sc+": "+e.message); }
  }
  res.json({success:true,inserted,updated,errors,message:"Done: "+inserted+" added, "+updated+" updated"+(errors.length?" ("+errors.length+" errors)":"")});
});


// ── STUDENT TIMETABLE (by semester + branch/section) ─────────
app.get('/api/student/timetable', async (req,res)=>{
  const {semester, branch, section} = req.query;
  if(!semester||!branch) return res.status(400).json({success:false,message:'semester and branch required'});
  try{
    const [batches]=await pool.query('SELECT * FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(!batches.length) return res.json({success:true,slots:[],batch:null});

    // Determine the exact section to filter timetable_slots.branch
    // timetable stores branch as the Section column e.g. 'CSE-B'
    // student has branch='CSE', section='CSE-B'
    // Priority: use section param if given, else use branch directly if it has a dash, else show all sections for that branch
    let branchFilter;
    if(section && section.trim()){
      branchFilter = section.trim().toUpperCase();          // e.g. 'CSE-B'
    } else if(branch.includes('-')){
      branchFilter = branch.toUpperCase();                  // e.g. 'CSE-B' passed directly
    } else {
      branchFilter = null;                                  // e.g. 'EEE' — no sections, match all
    }

    let query, params;
    if(branchFilter){
      query = `SELECT ts.*, fm.full_name AS faculty_name
               FROM timetable_slots ts
               LEFT JOIN faculty_map fm ON fm.shortcode = ts.faculty_code
               WHERE ts.batch_id=? AND ts.semester=? AND ts.branch=?
               ORDER BY FIELD(ts.day_of_week,'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'), ts.time_slot`;
      params = [batches[0].id, semester, branchFilter];
    } else {
      // No section info — LIKE fallback handles CSE -> CSE-A, CSE-B etc.
      const branchBase = branch.split('-')[0].toUpperCase();
      query = `SELECT ts.*, fm.full_name AS faculty_name
               FROM timetable_slots ts
               LEFT JOIN faculty_map fm ON fm.shortcode = ts.faculty_code
               WHERE ts.batch_id=? AND ts.semester=?
                 AND (ts.branch=? OR ts.branch LIKE ?)
               ORDER BY FIELD(ts.day_of_week,'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'), ts.time_slot`;
      params = [batches[0].id, semester, branchBase, branchBase + '%'];
    }

    const [slots]=await pool.query(query, params);
    res.json({success:true, slots, batch:batches[0].batch_name});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

// ── STUDENT SUBJECTS WITH FACULTY (semester + branch/section) ─
app.get('/api/student/subjects-faculty', async (req,res)=>{
  const {semester, branch, section} = req.query;
  if(!semester||!branch) return res.status(400).json({success:false,message:'semester and branch required'});
  try{
    // ── Resolve branch parts ──────────────────────────────────────────────────
    const branchBase = branch.includes('-') ? branch.split('-')[0] : branch;
    // Prefer explicit section param, then dash-branch (e.g. CSE-B), then null
    const sectionFilter = (section?.trim().toUpperCase()) || (branch.includes('-') ? branch.toUpperCase() : null);

    // ── STEP 1: Get active timetable batch ───────────────────────────────────
    const [batches]=await pool.query('SELECT id,batch_name FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(!batches.length) return res.json({success:true, subjects:[]});

    const batchId = batches[0].id;

    // ── STEP 2: Branch condition — if section known use exact match,
    //    otherwise catch all sections (CSE-A, CSE-B …) with LIKE ────────────
    const branchCondition = sectionFilter ? 'ts.branch=?' : '(ts.branch=? OR ts.branch LIKE ?)';
    const branchParams    = sectionFilter ? [sectionFilter] : [branchBase, `${branchBase}%`];

    // ── STEP 3: Pull one row per unique subject directly from timetable ──────
    //    This is the SINGLE SOURCE OF TRUTH — whatever admin uploaded is what
    //    students see.  The old subjects table is only used for credits below.
    const [slots]=await pool.query(
      `SELECT ts.subject_short                AS subject_code,
              MAX(ts.subject_full)            AS subject_name,
              MAX(ts.faculty_code)            AS faculty_code,
              MAX(fm.full_name)               AS faculty_name,
              MAX(fm.designation)             AS designation
       FROM timetable_slots ts
       LEFT JOIN faculty_map fm ON fm.shortcode = ts.faculty_code
       WHERE ts.batch_id=? AND ts.semester=?
         AND ${branchCondition}
         AND ts.subject_short IS NOT NULL
         AND ts.subject_short NOT IN ('BREAK','LUNCH','LIBRARY','RECESS','')
       GROUP BY ts.subject_short
       ORDER BY ts.subject_short`,
      [batchId, semester, ...branchParams]
    );

    if(!slots.length) return res.json({success:true, subjects:[]});

    // ── STEP 4: Optionally enrich credits from syllabus table ────────────────
    const codes = slots.map(s=>s.subject_code);
    const placeholders = codes.map(()=>'?').join(',');
    const [syllabusRows]=await pool.query(
      `SELECT subject_code, credits FROM subjects WHERE subject_code IN (${placeholders})`,
      codes
    );
    const creditMap = {};
    syllabusRows.forEach(s=>{ creditMap[s.subject_code]=s.credits; });

    // ── STEP 5: Build final result ───────────────────────────────────────────
    const result = slots.map(s=>({
      subject_code:        s.subject_code,
      subject_name:        s.subject_name || s.subject_code,
      branch:              sectionFilter || branchBase,
      semester:            parseInt(semester),
      credits:             creditMap[s.subject_code] || 3,
      faculty_code:        s.faculty_code        || null,
      faculty_name:        s.faculty_name        || null,
      faculty_designation: s.designation         || null
    }));

    res.json({success:true, subjects:result});
  }catch(e){ res.status(500).json({success:false,message:'Server error: '+e.message}); }
});

// ── STUDENT ATTENDANCE DETAILED ───────────────────────────────
app.get('/api/student/attendance/:studentId', async (req,res)=>{
  const {semester} = req.query;
  try{
    let q = `SELECT a.*, s.subject_name FROM attendance a LEFT JOIN subjects s ON s.subject_code=a.subject_code WHERE a.student_id=?`;
    const p = [req.params.studentId];
    if(semester){ q+=' AND a.semester=?'; p.push(semester); }
    q+=' ORDER BY a.semester, a.subject_code';
    const [rows]=await pool.query(q,p);
    res.json({success:true, attendance:rows});
  }catch(e){ res.status(500).json({success:false,message:'Server error'}); }
});

// ══════════════════════════════════════════════════════════════
//  AI ATTENDANCE — face-api.js powered automatic attendance
// ══════════════════════════════════════════════════════════════

// Helper: generate session ID
function genSessionId(){
  const chars='abcdefghijklmnopqrstuvwxyz0123456789';
  let r='sess_';
  for(let i=0;i<8;i++) r+=chars[Math.floor(Math.random()*chars.length)];
  return r;
}

// Helper: parse time slot "8:00-8:55" → {startH,startM,endH,endM}
function parseSlot(timeSlot){
  try{
    const [s,e]=timeSlot.split('-');
    const [sh,sm]=s.split(':').map(Number);
    const [eh,em]=e.split(':').map(Number);
    return {startH:sh,startM:sm,endH:eh,endM:em};
  }catch(e){ return null; }
}

// Helper: is current time inside a slot?
function isNowInSlot(timeSlot){
  const p=parseSlot(timeSlot); if(!p) return false;
  const now=new Date();
  const h=now.getHours(), m=now.getMinutes();
  const nowMins=h*60+m;
  const startMins=p.startH*60+p.startM;
  const endMins=p.endH*60+p.endM;
  return nowMins>=startMins && nowMins<=endMins;
}

// GET active timetable slot for a given branch/semester right now
async function getCurrentSlot(branch, semester){
  try{
    const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const today=days[new Date().getDay()];
    const [batches]=await pool.query('SELECT id FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(!batches.length) return null;
    const batchId=batches[0].id;
    const [slots]=await pool.query(
      `SELECT ts.*, fm.full_name AS faculty_name
       FROM timetable_slots ts
       LEFT JOIN faculty_map fm ON fm.shortcode=ts.faculty_code
       WHERE ts.batch_id=? AND ts.branch=? AND ts.semester=? AND ts.day_of_week=?
       ORDER BY ts.time_slot ASC`,
      [batchId, branch, semester, today]
    );
    for(const slot of slots){
      if(isNowInSlot(slot.time_slot)) return slot;
    }
    return null;
  }catch(e){ console.error('getCurrentSlot error:',e.message); return null; }
}

// ── POST /api/ai-attendance/start ─────────────────────────────
// Admin starts an AI attendance session
app.post('/api/ai-attendance/start', async (req,res)=>{
  const {branch, semester, roomNo, forceSlotId, manualSubject} = req.body;
  if(!branch||!semester) return res.status(400).json({success:false,message:'branch and semester required'});
  try{
    let slotInfo=null;
    if(forceSlotId){
      const [rows]=await pool.query('SELECT ts.*,fm.full_name AS faculty_name FROM timetable_slots ts LEFT JOIN faculty_map fm ON fm.shortcode=ts.faculty_code WHERE ts.id=?',[forceSlotId]);
      slotInfo=rows[0]||null;
    } else {
      slotInfo=await getCurrentSlot(branch, parseInt(semester));
    }
    // If no timetable slot found but admin typed a subject manually, use it
    const subjectCode = slotInfo?.subject_short || (manualSubject ? manualSubject.trim() : null);
    const subjectName = slotInfo?.subject_full  || (manualSubject ? manualSubject.trim() : null);
    const sessionId=genSessionId();
    await pool.query(
      `INSERT INTO ai_attendance_sessions
       (session_id,room_no,slot_id,subject_code,subject_name,faculty_code,branch,semester,time_slot,day_of_week,status,started_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sessionId, roomNo||null,
       slotInfo?.id||null, subjectCode||null, subjectName||null,
       slotInfo?.faculty_code||null, branch, parseInt(semester),
       slotInfo?.time_slot||null, slotInfo?.day_of_week||null,
       'active', req.headers['x-user-id']||'admin']
    );
    // Return synthetic slotInfo so frontend badge/infoBox populate correctly
    const responseSlotInfo = slotInfo || (subjectCode ? {
      subject_short: subjectCode,
      subject_full:  subjectName,
      time_slot:     null,
      faculty_name:  null,
      faculty_code:  null,
      room_no:       roomNo||null
    } : null);
    res.json({success:true, sessionId, slotInfo: responseSlotInfo});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── POST /api/ai-attendance/save-capture ──────────────────────
// Save recognized student IDs for start or end capture
app.post('/api/ai-attendance/save-capture', async (req,res)=>{
  const {sessionId, captureType, recognizedIds} = req.body;
  if(!sessionId||!captureType||!Array.isArray(recognizedIds))
    return res.status(400).json({success:false,message:'sessionId, captureType (start|end), recognizedIds[] required'});
  try{
    const [rows]=await pool.query('SELECT * FROM ai_attendance_sessions WHERE session_id=?',[sessionId]);
    if(!rows.length) return res.status(404).json({success:false,message:'Session not found'});
    const normalizedIds = recognizedIds.map(id => String(id));
    const idsJson=JSON.stringify(normalizedIds);
    if(captureType==='start'){
      await pool.query('UPDATE ai_attendance_sessions SET start_present_ids=?, start_captured_at=NOW() WHERE session_id=?',[idsJson,sessionId]);
    } else {
      await pool.query('UPDATE ai_attendance_sessions SET end_present_ids=?, end_captured_at=NOW() WHERE session_id=?',[idsJson,sessionId]);
    }
    res.json({success:true, count:recognizedIds.length, captureType});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── POST /api/ai-attendance/finalize ─────────────────────────
// Write final attendance to DB using intersection of start+end captures
app.post('/api/ai-attendance/finalize', async (req,res)=>{
  const {sessionId, mode} = req.body; // mode: 'BOTH'(intersection) or 'EITHER'(union), default BOTH
  if(!sessionId) return res.status(400).json({success:false,message:'sessionId required'});
  try{
    const [rows]=await pool.query('SELECT * FROM ai_attendance_sessions WHERE session_id=?',[sessionId]);
    if(!rows.length) return res.status(404).json({success:false,message:'Session not found'});
    const sess=rows[0];

    const parseJsonCol = (val) => {
      if (!val) return [];
      if (Array.isArray(val)) return val;          // MySQL2 already parsed it
      if (typeof val === 'object') return Object.values(val);
      try { return JSON.parse(val); } catch(e) { return []; }
    };
    const startIds = parseJsonCol(sess.start_present_ids);
    const endIds   = parseJsonCol(sess.end_present_ids);

    // Determine present set
    let presentIds=[];
    const useMode=mode||'EITHER'; // EITHER = lenient: in either capture counts
    if(useMode==='BOTH'){
      const endSet=new Set(endIds);
      presentIds=startIds.filter(id=>endSet.has(id));
    } else {
      presentIds=[...new Set([...startIds,...endIds])];
    }

    // Get all students for this class.
    // sess.branch may be "CSE-B"/"CSE_B" (section format) or plain "CSE".
    // Strip section suffix so students stored as "CSE" are also found.
    const branchRaw  = (sess.branch||'').trim();
    const baseBranch = branchRaw.replace(/[_\-][A-Z0-9]+$/i, '').toUpperCase();
    const [allStudents]=await pool.query(
      `SELECT student_id FROM students
       WHERE semester=? AND (branch=? OR branch=? OR branch=? OR section=?)`,
      [sess.semester, branchRaw, branchRaw.toUpperCase(), baseBranch, branchRaw]
    );
    const allIds=allStudents.map(s=>String(s.student_id));
    // Normalize presentIds to strings so comparison always works (face engine returns strings,
    // but JSON parse from DB might produce numbers in some MySQL/Node versions)
    const normalizedPresentIds = presentIds.map(id => String(id));
    const presentSet=new Set(normalizedPresentIds);

    const subjectCode=sess.subject_code;
    const semester=sess.semester;
    const classDate = new Date().toISOString().slice(0,10);

    // BUG FIX: subjectCode can be null when no timetable slot is found.
    // We must STILL write attendance — use a fallback code so the block is never skipped.
    const effectiveSubjectCode = subjectCode || `MANUAL-${sess.session_id.slice(0,8)}`;

    if(allIds.length){
      // Check if already finalized today for this subject to prevent double-counting
      // Only check against real subject codes (not manual fallback), to avoid false blocks
      if(subjectCode){
        const [dupCheck]=await pool.query(
          'SELECT id FROM attendance_log WHERE subject_code=? AND semester=? AND class_date=? AND recorded_by=? LIMIT 1',
          [subjectCode, semester, classDate, 'ai-system']
        );
        if(dupCheck.length){
          return res.status(400).json({success:false, message:`AI Attendance for ${subjectCode} on ${classDate} was already finalized. Re-finalizing would double-count classes.`});
        }
      }
      for(const sid of allIds){
        const attended=presentSet.has(sid)?1:0;
        await pool.query(
          `INSERT IGNORE INTO attendance_log (student_id,subject_code,semester,class_date,status,recorded_by)
           VALUES(?,?,?,?,?,?)`,
          [sid, effectiveSubjectCode, semester, classDate, attended?'present':'absent', 'ai-system']
        );
        await pool.query(
          `INSERT INTO attendance (student_id,subject_code,semester,classes_held,classes_attended)
           VALUES(?,?,?,1,?)
           ON DUPLICATE KEY UPDATE
             classes_held=classes_held+1,
             classes_attended=classes_attended+VALUES(classes_attended),
             updated_at=NOW()`,
          [sid, effectiveSubjectCode, semester, attended]
        );
      }
    } else {
      // allIds empty = no students found for this branch/semester combo — log and return error
      return res.status(400).json({success:false, message:`No students found for branch "${sess.branch}" semester ${sess.semester}. Check that students are registered with the correct branch/section.`});
    }

    // Update session record
    await pool.query(
      `UPDATE ai_attendance_sessions
       SET status='completed', final_present_ids=?, present_count=?, absent_count=?,
           total_students=?, finalized_at=NOW()
       WHERE session_id=?`,
      [JSON.stringify(normalizedPresentIds), normalizedPresentIds.length,
       allIds.length-normalizedPresentIds.length, allIds.length, sessionId]
    );

    res.json({
      success:true,
      presentCount:normalizedPresentIds.length,
      absentCount:allIds.length-normalizedPresentIds.length,
      totalStudents:allIds.length,
      presentIds: normalizedPresentIds
    });
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});


// ── GET /api/ai-attendance/faculty-sessions ───────────────────
// Returns completed AI sessions for the logged-in faculty's subjects
app.get('/api/ai-attendance/faculty-sessions', async (req,res)=>{
  const userId = req.headers['x-user-id'];
  if(!userId) return res.status(401).json({success:false,message:'Not authenticated'});
  try{
    // Get faculty shortcode
    const [fm]=await pool.query('SELECT shortcode FROM faculty_map WHERE user_id=?',[userId]);
    if(!fm.length) return res.status(403).json({success:false,message:'Faculty profile not found'});
    const shortcode=fm[0].shortcode;

    // Get sessions where this faculty's subjects were taken (via timetable slot OR subject_code match)
    const {date, days=30}=req.query;
    let dateFilter = date ? 'DATE(s.finalized_at)=?' : 's.finalized_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
    let dateParam  = date ? date : parseInt(days)||30;

    const [sessions]=await pool.query(
      `SELECT s.*,
              ts.faculty_code AS slot_faculty_code,
              fm2.full_name   AS faculty_name
       FROM ai_attendance_sessions s
       LEFT JOIN timetable_slots ts ON ts.id=s.slot_id
       LEFT JOIN faculty_map fm2 ON fm2.shortcode=ts.faculty_code
       WHERE s.status='completed'
         AND ${dateFilter}
         AND (ts.faculty_code=? OR s.faculty_code=?)
       ORDER BY s.finalized_at DESC`,
      [dateParam, shortcode, shortcode]
    );

    // For each session, get the present student names
    const result=[];
    for(const sess of sessions){
      const parseJson = v=>{
        if(!v) return [];
        if(Array.isArray(v)) return v;
        if(typeof v==='object') return Object.values(v);
        try{ return JSON.parse(v); }catch(e){ return []; }
      };
      const presentIds = parseJson(sess.final_present_ids);

      // Get all students for this class
      const baseBranch=(sess.branch||'').replace(/[_\-][A-Z0-9]+$/i,'').toUpperCase();
      const sectionLetter2 = (sess.branch||'').includes('-') ? (sess.branch||'').split('-').pop().toUpperCase() : (sess.branch||'');
      const [allStudents]=await pool.query(
        `SELECT student_id, full_name FROM students
         WHERE semester=? AND (
           branch=? OR branch=? OR section=? OR section=?
           OR (branch=? AND (section=? OR section=? OR section IS NULL OR section=''))
         )`,
        [sess.semester, sess.branch, baseBranch, sess.branch, sectionLetter2,
         baseBranch, sectionLetter2, sess.branch]
      );
      const presentSet=new Set(presentIds.map(id=>String(id)));
      result.push({
        ...sess,
        students: allStudents.map(s=>({
          student_id: s.student_id,
          name:       s.full_name||s.student_id,
          present:    presentSet.has(String(s.student_id))
        }))
      });
    }
    res.json({success:true, sessions:result, faculty:shortcode});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── GET /api/ai-attendance/debug-session/:sessionId ───────────
// Returns raw session data + matched students for diagnosing attendance issues
app.get('/api/ai-attendance/debug-session/:sessionId', async (req,res)=>{
  try{
    const [rows]=await pool.query('SELECT * FROM ai_attendance_sessions WHERE session_id=?',[req.params.sessionId]);
    if(!rows.length) return res.status(404).json({success:false,message:'Session not found'});
    const sess=rows[0];
    const parseJson=v=>{ if(!v)return[]; if(Array.isArray(v))return v; if(typeof v==='object')return Object.values(v); try{return JSON.parse(v);}catch(e){return[];} };
    const startIds=parseJson(sess.start_present_ids).map(String);
    const endIds=parseJson(sess.end_present_ids).map(String);
    const finalIds=parseJson(sess.final_present_ids).map(String);
    const branchRaw=(sess.branch||'').trim();
    const baseBranch=branchRaw.replace(/[_\-][A-Z0-9]+$/i,'').toUpperCase();
    const [allStudents]=await pool.query(
      `SELECT student_id,full_name,branch,section FROM students WHERE semester=? AND (branch=? OR branch=? OR branch=? OR section=?)`,
      [sess.semester,branchRaw,branchRaw.toUpperCase(),baseBranch,branchRaw]
    );
    res.json({
      success:true,
      session:{ session_id:sess.session_id, branch:sess.branch, semester:sess.semester, subject_code:sess.subject_code, status:sess.status, started_at:sess.created_at, finalized_at:sess.finalized_at },
      captured:{ startIds, endIds, finalIds },
      studentsFound:allStudents.length,
      students:allStudents.map(s=>({ student_id:String(s.student_id), full_name:s.full_name, branch:s.branch, section:s.section, inStart:startIds.includes(String(s.student_id)), inEnd:endIds.includes(String(s.student_id)), inFinal:finalIds.includes(String(s.student_id)) })),
      diagnosis:{ subjectCodeNull:!sess.subject_code, noStudentsFound:allStudents.length===0, branchUsed:branchRaw, baseBranchUsed:baseBranch }
    });
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── GET /api/ai-attendance/sessions ──────────────────────────
// List sessions (optionally filter by date)
app.get('/api/ai-attendance/sessions', async (req,res)=>{
  try{
    const {date}=req.query;
    let q=`SELECT s.*,
           (SELECT COUNT(*) FROM students WHERE branch=s.branch AND semester=s.semester) AS enrolled
           FROM ai_attendance_sessions s`;
    const params=[];
    if(date){ q+=' WHERE DATE(s.created_at)=?'; params.push(date); }
    else { q+=' WHERE DATE(s.created_at)=CURDATE()'; }
    q+=' ORDER BY s.created_at DESC';
    const [rows]=await pool.query(q,params);
    res.json({success:true,sessions:rows});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── GET /api/ai-attendance/slots ──────────────────────────────
// Get timetable slots for a branch/semester for manual slot selection
app.get('/api/ai-attendance/slots', async (req,res)=>{
  const {branch, semester}=req.query;
  if(!branch||!semester) return res.status(400).json({success:false,message:'branch and semester required'});
  try{
    const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const today=days[new Date().getDay()];
    const [batches]=await pool.query('SELECT id FROM timetable_batches WHERE is_active=1 ORDER BY created_at DESC LIMIT 1');
    if(!batches.length) return res.json({success:true,slots:[],today});
    const [slots]=await pool.query(
      `SELECT ts.id,ts.time_slot,ts.subject_short,ts.subject_full,ts.faculty_code,ts.room_no,ts.day_of_week,
              fm.full_name AS faculty_name
       FROM timetable_slots ts
       LEFT JOIN faculty_map fm ON fm.shortcode=ts.faculty_code
       WHERE ts.batch_id=? AND ts.branch=? AND ts.semester=? AND ts.day_of_week=?
         AND ts.subject_short IS NOT NULL
         AND ts.subject_short NOT IN ('BREAK','LUNCH','RECESS','')
       ORDER BY ts.time_slot ASC`,
      [batches[0].id, branch, parseInt(semester), today]
    );
    res.json({success:true,slots,today});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── GET /api/ai-attendance/students-with-descriptors ─────────
// Returns ALL students for this class (with or without face descriptors).
// Used to build the class roster — even students registered only via Python
// (who have photos on disk but no DB descriptor) must appear here.
app.get('/api/ai-attendance/students-with-descriptors', async (req,res)=>{
  const {branch,semester}=req.query;
  if(!branch||!semester) return res.status(400).json({success:false,message:'branch and semester required'});
  try{
    // Strip section suffix for flexible branch matching (CSE-B -> CSE, CSE_B -> CSE)
    const baseBranch = branch.replace(/[_\-][A-Z0-9]+$/i,'').toUpperCase();
    // Also extract just the section letter (e.g. "CSE-B" -> "B")
    const sectionLetter = branch.includes('-') ? branch.split('-').pop().toUpperCase() : branch;

    // Get ALL students for this class (LEFT JOIN so those without photos also appear)
    // Matches: branch='CSE-B', branch='CSE' with section='B' or 'CSE-B', etc.
    const [allStudents]=await pool.query(
      `SELECT s.student_id, s.full_name, s.branch, s.section, s.semester,
              COUNT(p.id) AS photo_count,
              MAX(CASE WHEN p.descriptor IS NOT NULL THEN 1 ELSE 0 END) AS has_descriptor
       FROM students s
       LEFT JOIN photos p ON p.student_id=s.student_id
       WHERE s.semester=? AND (
         s.branch=? OR s.branch=? OR s.section=? OR s.section=?
         OR (s.branch=? AND (s.section=? OR s.section=? OR s.section IS NULL OR s.section=''))
       )
       GROUP BY s.student_id
       ORDER BY s.student_id`,
      [parseInt(semester), branch, baseBranch, branch, sectionLetter,
       baseBranch, sectionLetter, branch]
    );

    // Also pull descriptors for those who have them (for any client-side use)
    const [descRows]=await pool.query(
      `SELECT s.student_id, p.descriptor, p.file_path
       FROM students s
       INNER JOIN photos p ON p.student_id=s.student_id
       WHERE s.semester=? AND (
         s.branch=? OR s.branch=? OR s.section=? OR s.section=?
         OR (s.branch=? AND (s.section=? OR s.section=? OR s.section IS NULL OR s.section=''))
       ) AND p.descriptor IS NOT NULL
       ORDER BY s.student_id`,
      [parseInt(semester), branch, baseBranch, branch, sectionLetter,
       baseBranch, sectionLetter, branch]
    );
    const descMap={};
    for(const r of descRows){
      if(!descMap[r.student_id]) descMap[r.student_id]=[];
      try{ descMap[r.student_id].push(JSON.parse(r.descriptor)); }catch(_){}
    }

    const students = allStudents.map(s=>({
      studentId:   s.student_id,
      fullName:    s.full_name,
      branch:      s.branch,
      section:     s.section,
      semester:    s.semester,
      photoCount:  s.photo_count||0,
      hasDescriptor: !!s.has_descriptor,
      descriptors: descMap[s.student_id]||[]
    }));

    res.json({success:true, students, totalCount: students.length});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── GET /api/ai-attendance/students-roster ────────────────────
// Lightweight: just student IDs + names for a class (for passing to face engine)
app.get('/api/ai-attendance/students-roster', async (req,res)=>{
  const {branch,semester}=req.query;
  if(!branch||!semester) return res.status(400).json({success:false,message:'branch and semester required'});
  try{
    const baseBranch = branch.replace(/[_\-][A-Z0-9]+$/i,'').toUpperCase();
    const sectionLetter = branch.includes('-') ? branch.split('-').pop().toUpperCase() : branch;
    const [rows]=await pool.query(
      `SELECT student_id, full_name FROM students
       WHERE semester=? AND (
         branch=? OR branch=? OR section=? OR section=?
         OR (branch=? AND (section=? OR section=? OR section IS NULL OR section=''))
       )
       ORDER BY student_id`,
      [parseInt(semester), branch, baseBranch, branch, sectionLetter,
       baseBranch, sectionLetter, branch]
    );
    res.json({success:true, students: rows.map(r=>({studentId:r.student_id, fullName:r.full_name}))});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── POST /api/ai-attendance/store-descriptor ─────────────────
// Store computed descriptor for a photo (called after photo upload)
app.post('/api/ai-attendance/store-descriptor', async (req,res)=>{
  const {studentId, photoFilename, descriptor}=req.body;
  if(!studentId||!descriptor) return res.status(400).json({success:false,message:'Missing studentId or descriptor'});
  try{
    let q='UPDATE photos SET descriptor=? WHERE student_id=?';
    const p=[JSON.stringify(descriptor), studentId];
    if(photoFilename){ q+=' AND filename=?'; p.push(photoFilename); }
    await pool.query(q,p);
    res.json({success:true});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

// ── PYTHON FACE ENGINE PROXY ──────────────────────────────────────────────────
// These routes forward requests to the Python face_engine.py (port 5001).
// The browser talks only to Node (port 3000) — no CORS issues.

function proxyToPython(req, res, pyPath, method='GET', body=null){
  // /capture can take up to ~10 s (multi-frame voting) — give it 30 s.
  // All other routes respond in <1 s so 30 s is still safe for them.
  const timeoutMs = pyPath === '/capture' ? 30000 : 10000;
  const options={
    hostname:'127.0.0.1', port:FACE_ENGINE_PORT,
    path:pyPath, method,
    headers:{'Content-Type':'application/json'},
    timeout: timeoutMs
  };
  const pyReq=http.request(options, pyRes=>{
    if((pyRes.headers['content-type']||'').includes('multipart')){
      res.setHeader('Content-Type', pyRes.headers['content-type']);
      res.setHeader('Cache-Control','no-cache');
      pyRes.pipe(res);
      req.on('close',()=>pyRes.destroy());
    } else {
      let data='';
      pyRes.on('data',c=>data+=c);
      pyRes.on('end',()=>{
        res.setHeader('Content-Type','application/json');
        res.send(data);
      });
    }
  });
  pyReq.on('timeout',()=>{
    pyReq.destroy();
    spawnFaceEngine();
    if(!res.headersSent) res.status(503).json({ok:false, status:_engineStatus, error:_engineError, message:'Face engine starting up — please wait.'});
  });
  pyReq.on('error',()=>{
    spawnFaceEngine();
    if(!res.headersSent) res.status(503).json({ok:false, status:_engineStatus, error:_engineError, message:'Face engine starting up — please wait.'});
  });
  // Forward explicit body OR pipe incoming request body (for POST with JSON payload)
  if(body){
    pyReq.write(typeof body==='string'?body:JSON.stringify(body));
    pyReq.end();
  } else if(method==='POST' && req.body && Object.keys(req.body).length>0){
    const bodyStr=JSON.stringify(req.body);
    pyReq.setHeader('Content-Length', Buffer.byteLength(bodyStr));
    pyReq.write(bodyStr);
    pyReq.end();
  } else {
    pyReq.end();
  }
}

// MJPEG live stream — browser displays this in an <img> tag
app.get('/py/video_feed', (req,res)=>proxyToPython(req,res,'/video_feed','GET'));

// Snapshot capture — returns recognised student IDs
app.post('/py/capture', (req,res)=>proxyToPython(req,res,'/capture','POST'));

// Stop the camera
app.post('/py/stop', (req,res)=>proxyToPython(req,res,'/stop','POST'));

// Status — how many students enrolled in face DB
app.get('/py/status', (req,res)=>proxyToPython(req,res,'/status','GET'));

// Reload face DB after new student photos are saved
app.post('/py/reload', (req,res)=>proxyToPython(req,res,'/reload','POST'));

// Set active class filter — restricts face matching to selected branch/semester
app.post('/py/set-class', (req,res)=>proxyToPython(req,res,'/set-class','POST'));

// ── WRITE name.txt alongside photos so Python engine can show names ───────────
// Called automatically after student photos are saved
app.post('/api/students/:studentId/save-name', async (req,res)=>{
  const {studentId}=req.params;
  try{
    const [rows]=await pool.query('SELECT full_name FROM students WHERE student_id=?',[studentId]);
    if(!rows.length) return res.status(404).json({success:false});
    const dir=path.join(__dirname,'public','photos',studentId);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'name.txt'), rows[0].full_name);
    res.json({success:true});
  }catch(e){ res.status(500).json({success:false,message:e.message}); }
});

async function runMigrations(){
  try{ await pool.query(`ALTER TABLE photos ADD COLUMN IF NOT EXISTS descriptor JSON DEFAULT NULL`); }catch(e){}
  // attendance_log: one row per student per class-day — prevents double-counting
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS attendance_log (
      id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
      student_id   VARCHAR(50)  NOT NULL,
      subject_code VARCHAR(25)  NOT NULL,
      semester     TINYINT      NOT NULL,
      class_date   DATE         NOT NULL,
      status       ENUM('present','absent') NOT NULL DEFAULT 'absent',
      recorded_by  VARCHAR(50)  DEFAULT NULL,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_log (student_id, subject_code, semester, class_date),
      INDEX idx_log_subject (subject_code, semester, class_date)
    ) ENGINE=InnoDB`);
  }catch(e){ console.warn('⚠️ attendance_log migration:',e.message); }
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_attendance_sessions (
      id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      session_id        VARCHAR(30) NOT NULL UNIQUE,
      room_no           VARCHAR(20) DEFAULT NULL,
      slot_id           INT DEFAULT NULL,
      subject_code      VARCHAR(25) DEFAULT NULL,
      subject_name      VARCHAR(200) DEFAULT NULL,
      faculty_code      VARCHAR(10) DEFAULT NULL,
      branch            VARCHAR(20) NOT NULL,
      semester          TINYINT NOT NULL,
      time_slot         VARCHAR(30) DEFAULT NULL,
      day_of_week       VARCHAR(15) DEFAULT NULL,
      status            ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active',
      start_present_ids JSON DEFAULT NULL,
      end_present_ids   JSON DEFAULT NULL,
      final_present_ids JSON DEFAULT NULL,
      present_count     INT DEFAULT 0,
      absent_count      INT DEFAULT 0,
      total_students    INT DEFAULT 0,
      started_by        VARCHAR(50) DEFAULT NULL,
      start_captured_at TIMESTAMP DEFAULT NULL,
      end_captured_at   TIMESTAMP DEFAULT NULL,
      finalized_at      TIMESTAMP DEFAULT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_session_date(created_at),
      INDEX idx_session_branch(branch,semester),
      INDEX idx_session_status(status)
    ) ENGINE=InnoDB`);
    console.log('✅ DB migrations done');
  }catch(e){ console.warn('⚠️ Migration warning:',e.message); }
}

async function start(){
  await testDB();
  await runMigrations();
  const [users]=await pool.query('SELECT id FROM users LIMIT 1');
  if(!users.length){
    await pool.query(`INSERT INTO users (user_id,password,role,name) VALUES ('ADMIN001','admin123','Admin','Administrator'),('FAC001','faculty123','Faculty','Dr. Sharma')`);
    console.log('🔑 Seeded: ADMIN001/admin123, FAC001/faculty123');
  }
  fs.mkdirSync(path.join(__dirname,'uploads','timetables'),{recursive:true});
  app.listen(PORT,()=>{ console.log(`\n🚀 Portal → http://localhost:${PORT}\n`); });
}
start();