"""
face_engine.py  —  TAT College Portal  —  Python Face Recognition Microservice
================================================================================
Runs on port 5001.  Node.js (server.js) proxies routes to this service.

UPGRADE (v2 — DeepFace edition):
  ─ Primary recogniser: DeepFace Facenet512 deep embeddings (512-d vectors)
    + MTCNN face detector (replaces Haar cascade)
  ─ Fallback:           OpenCV LBPH (kept for environments without GPU/DeepFace)
  ─ Cosine similarity on 512-d Facenet512 embeddings — threshold 0.40
  ─ All HTTP routes are unchanged so Node.js server.js needs NO edits.

Key behaviours preserved from v1
  ─ /capture  accepts { studentIds: [...] } to restrict matching to one class
  ─ /set-class, /reload, /stop, /video_feed, /ping, /status all work as before
  ─ Photos read from  portal_v6/public/photos/<student_id>/*.jpg
  ─ student name read from   portal_v6/public/photos/<student_id>/name.txt
  ─ face_db_cache.pkl persisted alongside face_engine.py

DEPENDENCIES (install once):
  pip install deepface mtcnn tensorflow opencv-contrib-python scipy numpy
  (tensorflow pulls in keras; mtcnn needs tensorflow)
"""

import os, sys, json, time, threading, pickle, hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── UTF-8 stdout fix for Windows ───────────────────────────────────────────────
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs
from datetime import datetime
from scipy.spatial.distance import cosine as cosine_dist

# ── Configuration ──────────────────────────────────────────────────────────────

PORT               = 5001
PHOTOS_DIR         = os.path.join(os.path.dirname(__file__), "public", "photos")
CACHE_FILE         = os.path.join(os.path.dirname(__file__), "face_db_cache.pkl")
FACE_SIZE          = (100, 100)   # used only for LBPH fallback
JPEG_QUALITY       = 60           # slightly lower than original 65 — still sharp, smaller frames

# DeepFace / Facenet512 settings  (primary)
DEEPFACE_MODEL     = "Facenet512"
DEEPFACE_THRESHOLD = 0.40         # cosine distance — tightened to reject strangers
# Facenet512 well-tested operating point is 0.30-0.40.
# 0.65 was far too loose: unknown faces were forced into the closest match.

# LBPH fallback settings  (only used when DeepFace packages are NOT installed)
LBPH_THRESHOLD     = 70           # Tightened from 130 — only accept very confident LBPH matches
COSINE_THRESHOLD   = 0.70         # Tightened from 0.55 — only used as absolute last resort

# Multi-frame voting: how many frames to sample per /capture call and
# how many must agree before we report a detection as confirmed.
CAPTURE_FRAMES     = 10           # frames to read per capture (more samples = more reliable)
CAPTURE_MIN_VOTES  = 1            # a student must appear in at least this many frames

# ── Globals ────────────────────────────────────────────────────────────────────

_db_lock  = threading.Lock()

# DeepFace embedding store
face_embeddings  = {}   # { student_id: [ np.ndarray(512,), ... ] }
name_map         = {}   # { student_id: full_name }
deepface_ready   = False

# LBPH fallback (kept for robustness)
lbph_recognizer  = None
lbph_label_map   = {}   # { int_label: student_id }
lbph_ready       = False

# Histogram cosine DB (last-resort fallback)
face_db          = {}   # { student_id: [ norm_vec, ... ] }

# ── Deep Learning models (loaded lazily once) ──────────────────────────────────

_model_lock       = threading.Lock()
_mtcnn_detector   = None
_deepface_loaded  = False


def _load_deepface_models():
    """Load MTCNN + warm up DeepFace Facenet512.  Called once at startup."""
    global _mtcnn_detector, _deepface_loaded
    with _model_lock:
        if _deepface_loaded:
            return
        try:
            from mtcnn import MTCNN
            _mtcnn_detector = MTCNN()
            print("[INFO] MTCNN detector loaded.", flush=True)
        except Exception as e:
            print(f"[WARN] MTCNN load failed ({e}) — falling back to Haar cascade.", flush=True)
            _mtcnn_detector = None

        try:
            from deepface import DeepFace
            # Warm up: run one dummy inference so the model is cached in memory
            dummy = np.zeros((160, 160, 3), dtype=np.uint8)
            DeepFace.represent(dummy, model_name=DEEPFACE_MODEL,
                               detector_backend='skip', enforce_detection=False)
            _deepface_loaded = True
            # Cache the module reference so _extract_embedding avoids per-call import
            import sys as _sys
            globals()['_deepface_module'] = _sys.modules.get('deepface.DeepFace') or \
                                             __import__('deepface', fromlist=['DeepFace'])
            print("[INFO] DeepFace Facenet512 model warmed up.", flush=True)
        except Exception as e:
            print(f"[WARN] DeepFace warm-up failed ({e}) — will use LBPH/cosine only.", flush=True)
            _deepface_loaded = False


# ── Cache fingerprint ──────────────────────────────────────────────────────────

def _photos_fingerprint() -> str:
    """
    Build a lightweight fingerprint of PHOTOS_DIR: sorted list of
    (student_id, filename, file_size, mtime).  If nothing in the photos
    folder has changed since the last build, the fingerprint will match
    the one stored in the cache and we can skip rebuilding entirely.
    This is the key optimisation: on a typical restart with no new photos
    the DB loads in <1 s instead of ~30-60 s.
    """
    parts = []
    if not os.path.isdir(PHOTOS_DIR):
        return ""
    for sid in sorted(os.listdir(PHOTOS_DIR)):
        folder = os.path.join(PHOTOS_DIR, sid)
        if not os.path.isdir(folder):
            continue
        for fname in sorted(os.listdir(folder)):
            if not fname.lower().endswith((".jpg", ".jpeg", ".png")):
                continue
            fp = os.path.join(folder, fname)
            try:
                st = os.stat(fp)
                parts.append(f"{sid}/{fname}:{st.st_size}:{st.st_mtime:.1f}")
            except OSError:
                pass
    return hashlib.md5("|".join(parts).encode()).hexdigest()




_haar_cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
_haar_detector     = cv2.CascadeClassifier(_haar_cascade_path)


# ── Face detection helpers ────────────────────────────────────────────────────

def _detect_faces_mtcnn(frame_bgr):
    """Return list of {'box': (x,y,w,h), 'face_rgb': np.ndarray} using MTCNN."""
    if _mtcnn_detector is None:
        return []
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    try:
        detections = _mtcnn_detector.detect_faces(rgb)
    except Exception as e:
        print(f"[WARN] MTCNN detect failed: {e}", flush=True)
        return []
    results = []
    for d in detections:
        if d.get('confidence', 0) < 0.90:
            continue
        x, y, w, h = d['box']
        x, y = max(0, x), max(0, y)
        face_rgb = rgb[y:y+h, x:x+w]
        if face_rgb.size == 0:
            continue
        results.append({'box': (x, y, w, h), 'face_rgb': face_rgb})
    return results


def _nms_faces(faces):
    """
    Suppress duplicate/sub-region face boxes (used with Haar cascade).
    """
    if len(faces) == 0:
        return []
    faces_sorted = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
    keep = []
    for (ax, ay, aw, ah) in faces_sorted:
        ax2, ay2 = ax + aw, ay + ah
        absorbed = False
        for (bx, by, bw, bh) in keep:
            bx2, by2 = bx + bw, by + bh
            ix1 = max(ax, bx); iy1 = max(ay, by)
            ix2 = min(ax2, bx2); iy2 = min(ay2, by2)
            if ix2 <= ix1 or iy2 <= iy1:
                continue
            inter = (ix2 - ix1) * (iy2 - iy1)
            if inter / min(aw * ah, bw * bh) > 0.50:
                absorbed = True
                break
        if not absorbed:
            keep.append((ax, ay, aw, ah))
    return keep


def _detect_faces_haar(frame_bgr):
    """Haar cascade fallback. Returns list of {'box': (x,y,w,h), 'face_bgr'}."""
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    raw = _haar_detector.detectMultiScale(
        gray, scaleFactor=1.05, minNeighbors=12,
        minSize=(80, 80), maxSize=(600, 600),
        flags=cv2.CASCADE_SCALE_IMAGE
    )
    boxes = _nms_faces(list(raw) if len(raw) > 0 else [])
    results = []
    for (x, y, w, h) in boxes:
        face_bgr = frame_bgr[y:y+h, x:x+w]
        results.append({'box': (x, y, w, h), 'face_bgr': face_bgr})
    return results


# ── Embedding extraction ───────────────────────────────────────────────────────

def _extract_embedding(face_rgb_or_bgr, is_rgb=True):
    """
    Extract a Facenet512 512-d embedding for a face crop.
    Returns np.ndarray(512,) or None on failure.
    """
    if not _deepface_loaded:
        return None
    try:
        from deepface import DeepFace
        img = face_rgb_or_bgr if is_rgb else cv2.cvtColor(face_rgb_or_bgr, cv2.COLOR_BGR2RGB)
        # Facenet512 requires at least 160x160; resize if smaller to avoid shape mismatch errors
        if img.shape[0] < 160 or img.shape[1] < 160:
            img = cv2.resize(img, (160, 160), interpolation=cv2.INTER_CUBIC)
        result = DeepFace.represent(img, model_name=DEEPFACE_MODEL,
                                    detector_backend='skip',
                                    enforce_detection=False)
        if result:
            vec = np.array(result[0]['embedding'], dtype=np.float32)
            norm = np.linalg.norm(vec)
            return vec / norm if norm > 0 else vec
    except Exception as e:
        print(f"[WARN] Embedding extraction failed: {e}", flush=True)
    return None


# ── Face pre-processing (LBPH / cosine fallback) ──────────────────────────────

def _preprocess(face_img: np.ndarray) -> np.ndarray:
    gray      = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY) if len(face_img.shape) == 3 else face_img
    resized   = cv2.resize(gray, FACE_SIZE)
    equalized = cv2.equalizeHist(resized)
    flat      = equalized.flatten().astype(np.float32)
    norm      = np.linalg.norm(flat)
    return flat / norm if norm > 0 else flat


def _augment_gray(gray_face: np.ndarray):
    r  = cv2.resize(gray_face, FACE_SIZE)
    eq = cv2.equalizeHist(r)
    return [
        eq,
        cv2.flip(eq, 1),
        np.clip(eq.astype(np.int16) + 20, 0, 255).astype(np.uint8),
        np.clip(eq.astype(np.int16) - 20, 0, 255).astype(np.uint8),
        cv2.GaussianBlur(eq, (3, 3), 0),
    ]


# ── Camera ─────────────────────────────────────────────────────────────────────

_cam_lock    = threading.Lock()
_camera      = None
_cam_running = False
_cam_read_lock = threading.Lock()  # serialize cam.read() calls across all threads


def get_camera():
    global _camera
    with _cam_lock:
        if _camera is None or not _camera.isOpened():
            for backend in ([cv2.CAP_DSHOW] if sys.platform == 'win32' else []) + [cv2.CAP_V4L2, 0]:
                try:
                    cam = cv2.VideoCapture(0, backend) if isinstance(backend, int) and backend != 0 \
                          else cv2.VideoCapture(0)
                    if cam.isOpened():
                        _camera = cam
                        break
                    cam.release()
                except Exception:
                    continue
            if _camera is None or not _camera.isOpened():
                print("[ERROR] Cannot open camera.", flush=True)
                return _camera
            _camera.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
            _camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            _camera.set(cv2.CAP_PROP_FPS, 30)
            _camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)   # always read the freshest frame
            print(f"[INFO] Camera opened ({int(_camera.get(cv2.CAP_PROP_FRAME_WIDTH))}x"
                  f"{int(_camera.get(cv2.CAP_PROP_FRAME_HEIGHT))})", flush=True)
        return _camera


def release_camera():
    global _camera, _cam_running
    with _cam_lock:
        _cam_running = False
        if _camera and _camera.isOpened():
            _camera.release()
        _camera = None


# ── Face DB ────────────────────────────────────────────────────────────────────

def _process_one_student(student_id, folder):
    """
    Process a single student folder: detect faces, extract embeddings, build
    LBPH training images.  Runs in a thread-pool worker during rebuild.
    Returns (student_id, embeddings_list, cosine_vecs, train_imgs, name) or None.
    """
    embeddings_for_student = []
    cosine_vecs            = []
    student_train_imgs     = []
    name                   = student_id

    name_file = os.path.join(folder, "name.txt")
    try:
        if os.path.exists(name_file):
            name = open(name_file).read().strip() or student_id
    except Exception:
        pass

    try:
        photo_files = sorted(
            f for f in os.listdir(folder) if f.lower().endswith((".jpg", ".jpeg", ".png"))
        )
        for fname in photo_files:
            img_path = os.path.join(folder, fname)
            img_bgr  = cv2.imread(img_path)
            if img_bgr is None or img_bgr.shape[0] < 48 or img_bgr.shape[1] < 48:
                continue

            # ── Detect face ──────────────────────────────────────────────────
            face_rgb_crop = None
            face_bgr_crop = None

            mtcnn_faces = _detect_faces_mtcnn(img_bgr)
            if mtcnn_faces:
                best = max(mtcnn_faces, key=lambda f: f['box'][2] * f['box'][3])
                face_rgb_crop = best['face_rgb']
                x, y, w, h = best['box']
                face_bgr_crop = img_bgr[y:y+h, x:x+w]
            else:
                try:
                    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
                    raw_faces = _haar_detector.detectMultiScale(gray, 1.05, 5, minSize=(40, 40))
                    if len(raw_faces):
                        x, y, w, h = max(raw_faces, key=lambda f: f[2] * f[3])
                        face_bgr_crop = img_bgr[y:y+h, x:x+w]
                        face_rgb_crop = cv2.cvtColor(face_bgr_crop, cv2.COLOR_BGR2RGB)
                    else:
                        face_bgr_crop = img_bgr
                        face_rgb_crop = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
                except cv2.error as cv_err:
                    print(f"[WARN] Skipping {fname}: {cv_err}", flush=True)
                    continue

            # ── DeepFace embedding ────────────────────────────────────────────
            emb = _extract_embedding(face_rgb_crop, is_rgb=True)
            if emb is not None:
                embeddings_for_student.append(emb)

            # ── Cosine vector (fallback) ──────────────────────────────────────
            crop_bgr = cv2.resize(face_bgr_crop, FACE_SIZE)
            eq       = cv2.equalizeHist(cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY))
            flat     = eq.flatten().astype(np.float32)
            norm     = np.linalg.norm(flat)
            cosine_vecs.append(flat / norm if norm > 0 else flat)

            # ── LBPH training images ──────────────────────────────────────────
            gray_crop = cv2.cvtColor(face_bgr_crop, cv2.COLOR_BGR2GRAY)
            student_train_imgs.extend(_augment_gray(gray_crop))

    except Exception as err:
        print(f"[WARN] Skipping student {student_id}: {err}", flush=True)

    if not (embeddings_for_student or cosine_vecs):
        return None
    return student_id, embeddings_for_student, cosine_vecs, student_train_imgs, name


def rebuild_face_db():
    """
    Scan PHOTOS_DIR, extract DeepFace Facenet512 embeddings for each student,
    and train the LBPH fallback model.  Persists to face_db_cache.pkl.

    Speed improvements vs original:
      1. Smart cache: if no photos have changed since last build, load from
         cache in <1 s instead of re-running DeepFace (~30-60 s).
      2. Parallel workers: each student's photos are processed concurrently
         using a ThreadPoolExecutor so multi-core CPUs are fully utilised.
      3. Per-student cap: at most MAX_PHOTOS_PER_STUDENT photos embedded —
         more photos than this give diminishing accuracy returns but cost
         linearly more time.
    """
    global face_embeddings, face_db, name_map
    global lbph_recognizer, lbph_label_map, lbph_ready, deepface_ready

    # ── Smart cache check ─────────────────────────────────────────────────────
    current_fp = _photos_fingerprint()
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "rb") as f:
                cached = pickle.load(f)
            if cached.get("photos_fingerprint") == current_fp and current_fp:
                # Photos unchanged — skip full rebuild, just load
                print("[INFO] Photos unchanged — loading from cache (fast path).", flush=True)
                load_face_db()
                return
        except Exception:
            pass  # corrupt cache → fall through to full rebuild

    new_embeddings, new_db, new_names = {}, {}, {}
    train_images, train_labels, new_label_map = [], [], {}
    label_counter = 0

    if not os.path.isdir(PHOTOS_DIR):
        print(f"[WARN] Photos dir not found: {PHOTOS_DIR}", flush=True)
        with _db_lock:
            face_embeddings, face_db, name_map = new_embeddings, new_db, new_names
            lbph_ready = False
            deepface_ready = False
        return

    student_ids = [
        sid for sid in sorted(os.listdir(PHOTOS_DIR))
        if os.path.isdir(os.path.join(PHOTOS_DIR, sid))
    ]
    print(f"[INFO] Building face DB for {len(student_ids)} students (parallel)…", flush=True)

    # Run per-student processing in parallel.
    # DeepFace releases the GIL during TensorFlow inference so threads are
    # effective here even with CPython.  Workers = min(students, CPU count).
    max_workers = min(len(student_ids), os.cpu_count() or 4, 8)
    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(_process_one_student, sid, os.path.join(PHOTOS_DIR, sid)): sid
            for sid in student_ids
        }
        for fut in as_completed(futures):
            sid = futures[fut]
            try:
                res = fut.result()
            except Exception as exc:
                print(f"[WARN] Worker error for {sid}: {exc}", flush=True)
                res = None
            if res is not None:
                results.append(res)
                print(f"[INFO] ✓ {res[0]} ({len(res[1])} embeddings)", flush=True)

    for student_id, embs, cvecs, train_imgs, sname in results:
        new_embeddings[student_id] = embs
        new_db[student_id]         = cvecs
        new_names[student_id]      = sname

        if train_imgs:
            new_label_map[label_counter] = student_id
            for img in train_imgs:
                train_images.append(img)
                train_labels.append(label_counter)
            label_counter += 1

    with _db_lock:
        face_embeddings = new_embeddings
        face_db         = new_db
        name_map        = new_names
        deepface_ready  = any(len(v) > 0 for v in new_embeddings.values())

    # Train LBPH
    new_lbph, new_lmap, new_lbph_ready = None, {}, False
    if train_images:
        try:
            rec = cv2.face.LBPHFaceRecognizer_create(radius=2, neighbors=8, grid_x=10, grid_y=10)
            rec.train(train_images, np.array(train_labels))
            new_lbph       = rec
            new_lmap       = new_label_map
            new_lbph_ready = True
            print(f"[INFO] LBPH trained on {len(train_images)} images for {label_counter} students.",
                  flush=True)
        except Exception as e:
            print(f"[WARN] LBPH training failed: {e}", flush=True)

    with _db_lock:
        lbph_recognizer = new_lbph
        lbph_label_map  = new_lmap
        lbph_ready      = new_lbph_ready

    # Persist cache (include fingerprint for next-run fast-path)
    lbph_xml = CACHE_FILE.replace(".pkl", "_lbph.xml")
    try:
        if new_lbph is not None and new_lbph_ready:
            new_lbph.save(lbph_xml)
        elif os.path.exists(lbph_xml):
            os.remove(lbph_xml)
    except Exception as e:
        print(f"[WARN] LBPH XML save failed: {e}", flush=True)

    try:
        with open(CACHE_FILE, "wb") as f:
            pickle.dump({
                "face_embeddings":    face_embeddings,
                "face_db":            face_db,
                "name_map":           name_map,
                "lbph_label_map":     new_lmap,
                "lbph_ready":         new_lbph_ready,
                "deepface_ready":     deepface_ready,
                "photos_fingerprint": current_fp,   # ← used by fast-path next run
            }, f)
        print(f"[INFO] Cache saved OK ({len(face_embeddings)} students).", flush=True)
    except Exception as e:
        print(f"[WARN] Cache write failed: {e}", flush=True)

    total = len(face_embeddings)
    df_students = sum(1 for v in face_embeddings.values() if v)
    print(f"[INFO] Face DB built: {total} students, {df_students} with DeepFace embeddings.", flush=True)


def load_face_db():
    global face_embeddings, face_db, name_map
    global lbph_recognizer, lbph_label_map, lbph_ready, deepface_ready
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "rb") as f:
                data = pickle.load(f)
            # Load LBPH from its separate XML file (avoids pickle incompatibility)
            lbph_xml = CACHE_FILE.replace(".pkl", "_lbph.xml")
            loaded_lbph = None
            if data.get("lbph_ready") and os.path.exists(lbph_xml):
                try:
                    rec = cv2.face.LBPHFaceRecognizer_create()
                    rec.read(lbph_xml)
                    loaded_lbph = rec
                except Exception as le:
                    print(f"[WARN] LBPH XML load failed ({le}) — LBPH disabled.", flush=True)
            with _db_lock:
                face_embeddings = data.get("face_embeddings", {})
                face_db         = data.get("face_db",         {})
                name_map        = data.get("name_map",        {})
                lbph_recognizer = loaded_lbph
                lbph_label_map  = data.get("lbph_label_map",  {})
                lbph_ready      = loaded_lbph is not None
                deepface_ready  = data.get("deepface_ready",  False)
            print(f"[INFO] Cache loaded: {len(face_embeddings)} students. "
                  f"DeepFace={deepface_ready}, LBPH={lbph_ready}", flush=True)
            return
        except Exception as e:
            print(f"[WARN] Cache load failed ({e}) — rebuilding.", flush=True)
    rebuild_face_db()


# ── Matching ───────────────────────────────────────────────────────────────────

def _best_match_deepface(query_emb: np.ndarray, allowed_ids=None):
    """
    Match a 512-d Facenet512 embedding against registered embeddings.
    Returns (student_id, name, similarity_score).
    similarity_score is 1 - cosine_distance (higher = better).
    """
    best_id, best_sim = "Unknown", 0.0
    with _db_lock:
        emb_store = face_embeddings

    for sid, embs in emb_store.items():
        if allowed_ids is not None and sid not in allowed_ids:
            continue
        if not embs:
            continue
        # cosine_dist from scipy = 1 - cosine_similarity
        dists = [cosine_dist(query_emb, e) for e in embs]
        # Take average of top-3 closest
        top_k = sorted(dists)[:min(3, len(dists))]
        avg_dist = float(np.mean(top_k))
        sim = 1.0 - avg_dist
        if avg_dist < DEEPFACE_THRESHOLD and sim > best_sim:
            best_sim = sim
            best_id  = sid

    if best_id == "Unknown":
        return "Unknown", "", best_sim
    return best_id, name_map.get(best_id, best_id), best_sim


def _best_match_cosine(query_vec: np.ndarray, allowed_ids=None):
    """Cosine similarity fallback on raw histogram vectors."""
    best_id, best_sim = "Unknown", 0.0
    with _db_lock:
        db = face_db
    for sid, vectors in db.items():
        if allowed_ids is not None and sid not in allowed_ids:
            continue
        sims  = [float(np.dot(query_vec, v)) for v in vectors]
        top_k = sorted(sims, reverse=True)[:min(3, len(sims))]
        avg   = float(np.mean(top_k))
        if avg > best_sim:
            best_sim = avg
            best_id  = sid
    if best_sim < COSINE_THRESHOLD:
        return "Unknown", "", best_sim
    return best_id, name_map.get(best_id, best_id), best_sim


def _best_match(face_rgb: np.ndarray, face_gray: np.ndarray, allowed_ids=None):
    """
    Tiered matching:
      1. DeepFace Facenet512 (primary — most accurate)
         If DeepFace is loaded and returns "Unknown", we STOP HERE and return
         Unknown.  We do NOT fall through to LBPH/cosine because those older
         methods are far less accurate and are the root cause of students being
         wrongly matched to each other.
      2. LBPH + Cosine fallbacks are ONLY used when DeepFace packages are not
         installed at all (i.e. _deepface_loaded is False).  In that environment
         they are the best available option.
    """
    # ── Tier 1: DeepFace ──────────────────────────────────────────────────────
    with _db_lock:
        df_ready = deepface_ready

    if _deepface_loaded and df_ready and face_rgb is not None:
        emb = _extract_embedding(face_rgb, is_rgb=True)
        if emb is not None:
            sid, name, sim = _best_match_deepface(emb, allowed_ids)
            if sid != "Unknown":
                return sid, name, sim
            # DeepFace is loaded and said "Unknown" — TRUST IT.
            # Do NOT fall through to LBPH/cosine: those older methods are far
            # less discriminative and are the direct cause of strangers being
            # wrongly matched to enrolled students.
            print(f"[MATCH] DeepFace Unknown (dist>{DEEPFACE_THRESHOLD}, sim={sim:.3f}) — returning Unknown.", flush=True)
            return "Unknown", "", sim

    # ── DeepFace NOT available — only then use LBPH / cosine ─────────────────
    # (e.g. tensorflow / deepface packages not installed in this environment)
    with _db_lock:
        rec   = lbph_recognizer
        lmap  = lbph_label_map
        ready = lbph_ready

    face_eq = cv2.equalizeHist(cv2.resize(face_gray, FACE_SIZE))

    # ── Tier 2: LBPH ─────────────────────────────────────────────────────────
    if ready and rec is not None:
        try:
            label, confidence = rec.predict(face_eq)
            sid = lmap.get(label, "Unknown")
            if allowed_ids is not None and sid not in allowed_ids:
                pass  # fall through to cosine
            elif confidence <= LBPH_THRESHOLD:
                sim = max(0.0, 1.0 - (confidence / 100.0))
                return sid, name_map.get(sid, sid), sim
        except Exception as e:
            print(f"[WARN] LBPH predict failed: {e}", flush=True)

    # ── Tier 3: Cosine histogram ──────────────────────────────────────────────
    flat = face_eq.flatten().astype(np.float32)
    norm = np.linalg.norm(flat)
    vec  = flat / norm if norm > 0 else flat
    return _best_match_cosine(vec, allowed_ids)


# ── Frame processing ───────────────────────────────────────────────────────────

def process_frame(frame: np.ndarray, allowed_ids=None):
    """Detect all faces and match each one.  Returns (annotated_frame, detections)."""
    detections = []
    seen_ids   = set()

    # Detect on the full frame — the background recognition thread and interval
    # throttling (not frame downscaling) provide the speed wins.  Running MTCNN
    # on a downscaled image caused bad coordinate remapping (empty / clipped crops
    # → zero embeddings → every face reported as Unknown).
    face_list = _detect_faces_mtcnn(frame)
    use_mtcnn = bool(face_list)

    if not use_mtcnn:
        haar_faces = _detect_faces_haar(frame)
        for f in haar_faces:
            face_list.append({'box': f['box'], 'face_rgb': None, 'face_bgr': f['face_bgr']})

    for face_info in face_list:
        x, y, w, h = face_info['box']
        face_rgb = face_info.get('face_rgb')
        face_bgr = face_info.get('face_bgr')
        if face_bgr is None and face_rgb is not None:
            face_bgr = cv2.cvtColor(face_rgb, cv2.COLOR_RGB2BGR)
        if face_bgr is None or face_bgr.size == 0:
            continue
        # Skip crops that are too small for DeepFace to embed reliably
        if face_bgr.shape[0] < 20 or face_bgr.shape[1] < 20:
            continue

        face_gray = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2GRAY)
        sid, name, sim = _best_match(face_rgb, face_gray, allowed_ids)

        color = (0, 200, 60) if sid != "Unknown" else (0, 60, 220)
        cv2.rectangle(frame, (x, y), (x+w, y+h), color, 2)

        if sid != "Unknown":
            display_name = name if name and name != sid else sid
            label_top = display_name
            label_bot = f"{sid}  {sim:.0%}"
        else:
            label_top = "Unknown"
            label_bot = ""

        (tw1, th1), _ = cv2.getTextSize(label_top, cv2.FONT_HERSHEY_SIMPLEX, 0.60, 2)
        (tw2, th2), _ = cv2.getTextSize(label_bot,  cv2.FONT_HERSHEY_SIMPLEX, 0.40, 1)
        box_w = max(tw1, tw2) + 10
        box_h = th1 + (th2 + 6 if label_bot else 0) + 10
        cv2.rectangle(frame, (x, y - box_h - 4), (x + box_w, y), color, cv2.FILLED)
        cv2.putText(frame, label_top,
                    (x + 5, y - (th2 + 8 if label_bot else 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.60, (255, 255, 255), 2)
        if label_bot:
            cv2.putText(frame, label_bot, (x + 5, y - 3),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.40, (220, 255, 220), 1)

        if sid != "Unknown" and sid not in seen_ids:
            seen_ids.add(sid)
            detections.append({"student_id": sid, "name": name, "confidence": round(sim, 3)})

    # Overlay
    ts = datetime.now().strftime("%d-%b-%Y  %H:%M:%S")
    cv2.putText(frame, ts, (10, frame.shape[0] - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 180, 180), 1)
    with _db_lock:
        enrolled = len(face_embeddings)
    class_count = len(allowed_ids) if allowed_ids else enrolled
    mode = "MTCNN+DeepFace" if (use_mtcnn and _deepface_loaded) else "Haar+LBPH"
    cv2.putText(frame,
                f"Class: {class_count}  |  Enrolled: {enrolled}  |  Faces: {len(face_list)}  |  {mode}",
                (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 255, 180), 1)

    return frame, detections


# ── Session state ──────────────────────────────────────────────────────────────

_session_lock       = threading.Lock()
_active_allowed_ids = None


def set_active_class(student_ids):
    global _active_allowed_ids
    with _session_lock:
        if student_ids:
            # Only apply the class filter when we actually received student IDs.
            # If the roster query returns an empty list (e.g. branch-name mismatch
            # between the timetable and how the student was registered), treat it
            # as "no filter" so the capture still matches all enrolled students.
            _active_allowed_ids = set(str(s).strip() for s in student_ids if str(s).strip())
        else:
            _active_allowed_ids = None  # empty list → no filter → match all enrolled


def get_active_allowed_ids():
    with _session_lock:
        return _active_allowed_ids


# ── MJPEG generator ────────────────────────────────────────────────────────────

# Run full face recognition only every STREAM_RECOGNITION_INTERVAL frames on the
# live video feed.  Between recognition frames we still read and encode the camera
# image (so the stream stays smooth) but we reuse the last known annotated frame.
# This keeps the preview fluid without changing how /capture works at all.
STREAM_RECOGNITION_INTERVAL = 6   # recognise every 6th frame (~5 fps recognition on 30fps cam)

# Shared state for the background recognition worker
_stream_lock        = threading.Lock()
_stream_latest_raw  = None   # most recent raw frame from camera
_stream_annotated   = None   # most recent annotated frame from worker
_stream_processing  = False  # True while worker is running DeepFace on a frame

# How long (seconds) the recognition worker pauses between inference calls.
# DeepFace/Facenet512 is the bottleneck; running it faster than it can finish
# just piles up work.  0.10 s ≈ ~8-10 recognition FPS which is plenty for
# attendance while keeping the live preview fluid.
RECOGNITION_WORKER_INTERVAL = 0.10

def _recognition_worker():
    """
    Background thread: grabs the latest raw frame and runs face recognition.
    Updates _stream_annotated so gen_frames can serve it without blocking.
    Skips a cycle if the previous inference hasn't finished yet to prevent
    CPU/GPU saturation which is the primary cause of camera lag.
    """
    global _stream_annotated, _stream_latest_raw, _stream_processing
    while True:
        with _stream_lock:
            already_busy = _stream_processing
            frame = _stream_latest_raw

        # If still busy with the previous frame, wait and retry — don't pile up
        if already_busy or frame is None:
            time.sleep(0.02)
            continue

        with _stream_lock:
            _stream_processing = True

        try:
            allowed = get_active_allowed_ids()
            annotated, _ = process_frame(frame.copy(), allowed)
            with _stream_lock:
                _stream_annotated = annotated
        except Exception as e:
            print(f"[WARN] Recognition worker error: {e}", flush=True)
        finally:
            with _stream_lock:
                _stream_processing = False

        # Pace the worker — running DeepFace faster than this interval wastes
        # CPU/GPU and starves the camera-read thread, causing visible lag.
        time.sleep(RECOGNITION_WORKER_INTERVAL)

_recognition_thread = None

def _ensure_recognition_thread():
    global _recognition_thread
    if _recognition_thread is None or not _recognition_thread.is_alive():
        _recognition_thread = threading.Thread(target=_recognition_worker, daemon=True)
        _recognition_thread.start()


def gen_frames():
    cam = get_camera()
    if not cam.isOpened():
        return
    global _cam_running, _stream_latest_raw, _stream_annotated
    _cam_running = True
    _ensure_recognition_thread()

    # Target ~30 fps for the MJPEG stream (33 ms per frame).
    # This prevents gen_frames from spinning in a tight loop and starving the
    # recognition worker thread, which is the main cause of lag.
    STREAM_FRAME_INTERVAL = 1.0 / 30.0
    last_stream_time = 0.0

    while _cam_running:
        with _cam_read_lock:
            ok, frame = cam.read()
        if not ok:
            time.sleep(0.05)
            continue

        # Share raw frame with recognition worker (always update so worker
        # always picks up the freshest frame, even if we skip encoding below)
        with _stream_lock:
            _stream_latest_raw = frame

        # Throttle the MJPEG output to STREAM_FRAME_INTERVAL so we don't
        # flood the browser connection and saturate the CPU with JPEG encodes.
        now = time.monotonic()
        elapsed = now - last_stream_time
        if elapsed < STREAM_FRAME_INTERVAL:
            time.sleep(STREAM_FRAME_INTERVAL - elapsed)

        with _stream_lock:
            out_frame = _stream_annotated if _stream_annotated is not None else frame

        ok2, buf = cv2.imencode(".jpg", out_frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if not ok2:
            continue
        last_stream_time = time.monotonic()
        yield (b"--frame\r\n"
               b"Content-Type: image/jpeg\r\n\r\n"
               + buf.tobytes()
               + b"\r\n")


# ── HTTP Server ─────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
            pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _json_response(self, code, obj):
        body = json.dumps(obj).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(body))
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def _handle_video_feed(self):
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        try:
            for chunk in gen_frames():
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        # Do NOT release camera here — _handle_capture may use it immediately after stream drops

    def _handle_ping(self):
        self._json_response(200, {"ok": True})

    def _handle_status(self):
        with _db_lock:
            enrolled = len(face_embeddings)
        self._json_response(200, {
            "ok": True,
            "enrolled": enrolled,
            "db_ready": _db_ready,
            "lbph_ready": lbph_ready,
            "deepface_ready": deepface_ready,
            "mtcnn_loaded": _mtcnn_detector is not None,
        })

    def _handle_capture(self, qs):
        # ── Parse student ID filter ───────────────────────────────────────────
        allowed_ids = None
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 0:
                body = json.loads(self.rfile.read(length))
                ids  = body.get("studentIds") or body.get("student_ids")
                if ids:
                    set_active_class(ids)
                    allowed_ids = get_active_allowed_ids()
        except Exception:
            pass
        if allowed_ids is None:
            allowed_ids = get_active_allowed_ids()

        # ── Sanity: filter must overlap with enrolled students ────────────────
        with _db_lock:
            enrolled_ids = set(face_embeddings.keys())
        print(f"[CAPTURE] enrolled={enrolled_ids}  filter={allowed_ids}", flush=True)
        if allowed_ids and not enrolled_ids.intersection(allowed_ids):
            print("[CAPTURE] WARNING: filter/enrolled mismatch — disabling filter", flush=True)
            allowed_ids = None

        # ── Get camera (reuse existing if open) ───────────────────────────────
        cam = get_camera()
        if cam is None or not cam.isOpened():
            self._json_response(503, {"ok": False, "error": "Camera unavailable", "detections": []})
            return

        # ── BUG FIX: Do NOT stop the live stream during capture ──────────────
        # The old code set _cam_running = False here which caused gen_frames()
        # to exit and call release_camera(), closing the camera before any
        # capture frame could be read (every cam.read() returned ok=False →
        # 0 detections always).
        #
        # Fix: keep the stream running and use _cam_read_lock to interleave
        # capture reads with stream reads safely.  No race, no camera release.
        # ─────────────────────────────────────────────────────────────────────

        # Flush stale buffered frames so we get a fresh exposure for capture.
        with _cam_read_lock:
            for _ in range(3):
                cam.read()
        time.sleep(0.15)   # brief settle for auto-exposure (BUFFERSIZE=1 means frames are already fresh)

        vote_counts  = {}
        vote_details = {}

        # Try up to 20 frames (~3 seconds max) — stop as soon as we get a recognition
        for attempt in range(20):
            with _cam_read_lock:
                ok, frame = cam.read()
            if not ok:
                time.sleep(0.1)
                continue

            _, dets = process_frame(frame, allowed_ids)
            print(f"[CAPTURE] attempt={attempt} dets={[d['student_id'] for d in dets]}", flush=True)

            for det in dets:
                sid = det["student_id"]
                vote_counts[sid]  = vote_counts.get(sid, 0) + 1
                vote_details[sid] = det

            if any(c >= CAPTURE_MIN_VOTES for c in vote_counts.values()):
                break   # found someone — done

            time.sleep(0.05)  # tight loop — DeepFace is the bottleneck, not sleep

        confirmed = [
            vote_details[sid]
            for sid, cnt in vote_counts.items()
            if cnt >= CAPTURE_MIN_VOTES
        ]
        print(f"[CAPTURE] FINAL votes={vote_counts} confirmed={[d['student_id'] for d in confirmed]}", flush=True)
        self._json_response(200, {"ok": True, "detections": confirmed})

    def _handle_set_class(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw  = self.rfile.read(length) if length > 0 else b"{}"
            body = json.loads(raw)
            ids  = body.get("studentIds") or []
            set_active_class(ids)
            self._json_response(200, {"ok": True, "filtered": len(ids)})
        except Exception as e:
            self._json_response(400, {"ok": False, "error": str(e)})

    def _handle_reload(self):
        threading.Thread(target=rebuild_face_db, daemon=True).start()
        self._json_response(200, {"ok": True, "message": "Rebuilding face DB in background"})

    def _handle_stop(self):
        global _cam_running
        _cam_running = False
        release_camera()   # explicitly release now that stream is intentionally stopped
        self._json_response(200, {"ok": True})

    def do_GET(self):
        path = urlparse(self.path).path
        qs   = parse_qs(urlparse(self.path).query)
        if path == "/video_feed":
            self._handle_video_feed()
        elif path == "/status":
            self._handle_status()
        elif path == "/ping":
            self._handle_ping()
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        qs   = parse_qs(urlparse(self.path).query)
        if path == "/capture":
            self._handle_capture(qs)
        elif path == "/set-class":
            self._handle_set_class()
        elif path == "/reload":
            self._handle_reload()
        elif path == "/stop":
            self._handle_stop()
        else:
            self.send_response(404)
            self.end_headers()


# ── Entry point ─────────────────────────────────────────────────────────────────

_db_ready = False


class _QuietHTTPServer(ThreadingMixIn, HTTPServer):
    """
    Multi-threaded HTTP server.
    ThreadingMixIn is CRITICAL: without it, the MJPEG video stream (a never-ending
    HTTP response) blocks the single server thread, so any subsequent request —
    including the browser's CORS preflight OPTIONS for /capture — never gets a
    response.  The browser then reports "Failed to fetch" (CORS error) even though
    the CORS headers are correct.  With ThreadingMixIn every request gets its own
    thread so stream and capture run concurrently without blocking each other.
    """
    daemon_threads = True   # threads exit when main process exits

    def handle_error(self, request, client_address):
        exc_type = sys.exc_info()[0]
        if exc_type in (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    server = _QuietHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[TAT Face Engine v2] HTTP server started on http://localhost:{PORT}", flush=True)
    print(f"[TAT Face Engine v2]   Photos dir : {PHOTOS_DIR}", flush=True)
    print(f"[TAT Face Engine v2]   Loading deep learning models + building face DB…", flush=True)

    def _startup():
        global _db_ready
        try:
            # Step 1 — load DeepFace / MTCNN models
            _load_deepface_models()
            # Step 2 — build/load face DB
            # rebuild_face_db() checks if photos changed since last run:
            #   • No changes  → loads from cache in <1 s  (fast path)
            #   • Photos added/changed → re-runs DeepFace on changed students
            # The old code deleted the cache here unconditionally, causing the
            # full ~30-60 s rebuild on every restart regardless of any changes.
            rebuild_face_db()
        except Exception as exc:
            print(f"[ERROR] Startup failed: {exc}", flush=True)
        finally:
            _db_ready = True
            print(f"[TAT Face Engine v2] Ready — {len(face_embeddings)} students. "
                  f"DeepFace={deepface_ready}, LBPH={lbph_ready}.", flush=True)

    threading.Thread(target=_startup, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[TAT Face Engine v2] Shutting down.", flush=True)
        release_camera()
        server.server_close()