
import cv2
import os
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision


class LandmarkExtractor:

    def __init__(self, model_path=None):

        # Resolve model path automatically
        if model_path is None:
            project_root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..")
            )
            model_path = os.path.join(project_root, "models", "hand_landmarker.task")

        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"Hand landmarker model not found at: {model_path}"
            )

        base_options = python.BaseOptions(model_asset_path=model_path)

        # IMPORTANT SETTINGS
        options = vision.HandLandmarkerOptions(
            base_options=base_options,
            running_mode=vision.RunningMode.VIDEO,   # better for streaming
            num_hands=1,
            min_hand_detection_confidence=0.5,
            min_hand_presence_confidence=0.5,
            min_tracking_confidence=0.5
        )

        self.landmarker = vision.HandLandmarker.create_from_options(options)

        self.frame_timestamp = 0


    # ------------------------------
    # Landmark Detection
    # ------------------------------

    def get_landmarks(self, image_rgb):

        if image_rgb is None:
            return None, None, None

        mp_image = mp.Image(
            image_format=mp.ImageFormat.SRGB,
            data=image_rgb
        )

        # timestamp required for VIDEO mode
        self.frame_timestamp += 1

        detection_result = self.landmarker.detect_for_video(
            mp_image,
            self.frame_timestamp
        )

        if not detection_result.hand_landmarks:
            return None, None, None

        hand_landmarks = detection_result.hand_landmarks[0]

        flattened = []

        for lm in hand_landmarks:
            flattened.extend([lm.x, lm.y, lm.z])

        return flattened, hand_landmarks, None


    # ------------------------------
    # Draw Landmarks
    # ------------------------------

    def draw_landmarks(self, image, landmarks):

        if landmarks is None:
            return image

        h, w, _ = image.shape

        CONNECTIONS = [
            (0,1),(1,2),(2,3),(3,4),
            (0,5),(5,6),(6,7),(7,8),
            (5,9),(9,10),(10,11),(11,12),
            (9,13),(13,14),(14,15),(15,16),
            (13,17),(17,18),(18,19),(19,20),
            (0,17)
        ]

        points = {}

        for idx, lm in enumerate(landmarks):

            cx = int(lm.x * w)
            cy = int(lm.y * h)

            points[idx] = (cx, cy)

            cv2.circle(image, (cx, cy), 4, (0,0,255), -1)

        for start, end in CONNECTIONS:

            if start in points and end in points:
                cv2.line(image, points[start], points[end], (0,255,0), 2)

        return image

