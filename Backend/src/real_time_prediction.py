import cv2
import pickle
import numpy as np
import base64
import sys
import collections
import os

# ================= FIX MODULE PATH =================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BASE_DIR)
from utils.landmark_extraction import LandmarkExtractor
# ================= SETTINGS =================

MODEL_PATH = os.path.join(BASE_DIR, "model", "sign_model.pkl")

PREDICTION_WINDOW_SIZE = 10
CONFIDENCE_THRESHOLD = 0.8

print("Loading model from:", MODEL_PATH, flush=True)

model = pickle.load(open(MODEL_PATH, "rb"))

print("Model loaded successfully", flush=True)

extractor = LandmarkExtractor()

prediction_history = collections.deque(maxlen=PREDICTION_WINDOW_SIZE)

# ================= MAIN LOOP =================

while True:

    try:

        data = sys.stdin.readline().strip()

        if not data:
            continue

        # -------- Decode Base64 Frame --------

        try:

            img = base64.b64decode(data.split(",")[1])

            npimg = np.frombuffer(img, dtype=np.uint8)

            frame = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

        except:

            print("Waiting...", flush=True)

            continue

        if frame is None:

            print("Waiting...", flush=True)

            continue

        # Mirror frame
        frame = cv2.flip(frame, 1)

        # Use full frame
        roi = frame

        rgb = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)

        # -------- Extract Landmarks --------

        landmarks, hand_landmarks, _ = extractor.get_landmarks(rgb)

        prediction = "Waiting..."

        # -------- No Hand Detected --------

        if landmarks is None or len(landmarks) == 0:

            prediction_history.clear()

            print("Waiting...", flush=True)

            continue

        # -------- Prepare Features --------

        features = np.array([landmarks])

        # -------- Prediction --------

        if hasattr(model, "predict_proba"):

            probs = model.predict_proba(features)[0]

            max_prob = np.max(probs)

            pred = model.classes_[np.argmax(probs)]

            print("Raw prediction:", pred, "Confidence:", max_prob, flush=True)

            if max_prob > CONFIDENCE_THRESHOLD:

                prediction_history.append(pred)

        else:

            pred = model.predict(features)[0]

            prediction_history.append(pred)

        # -------- Stabilize Prediction --------

        if len(prediction_history) > 0:

            stable, count = collections.Counter(prediction_history).most_common(1)[0]

            if count >= PREDICTION_WINDOW_SIZE * 0.6:

                prediction = stable

            else:

                prediction = "Waiting..."

        print(prediction, flush=True)

    except Exception as e:

        print("Error:", str(e), flush=True)