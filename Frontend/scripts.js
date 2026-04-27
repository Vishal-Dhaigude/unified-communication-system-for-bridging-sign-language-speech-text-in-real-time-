
const userName = "Deciphers - " + Math.floor(Math.random() * 100000);
const password = "x";
document.querySelector('#user-name').innerHTML = userName;

const socket = io.connect('https://localhost:5000/', {
    auth: { userName, password }
});

const localVideoEl = document.querySelector('#local-video');
const remoteVideoEl = document.querySelector('#remote-video');
const screenShareVideo = document.querySelector('#screen-share-video');
const landmarkCanvas = document.querySelector('#landmark-canvas');
const landmarkCtx = landmarkCanvas.getContext('2d');
const signPredictionText = document.getElementById("signPrediction");
const callButton = document.querySelector('#call');
const hangupButton = document.querySelector('#hangup');
const startScreenShareButton = document.querySelector('#startScreenShare');
const stopScreenShareButton = document.querySelector('#stopScreenShare');

let localStream;
let remoteStream;
let peerConnection;
let didIOffer = false;
let screenShareStream = null;
let cameraVideoTrack = null;
let handsModel = null;
let handDetectionStarted = false;
let handDetectedInFrame = false;

const peerConfiguration = {
    iceServers: [
        {
            urls: [
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302',
            ]
        }
    ]
};

/* ---------------- FETCH CAMERA ---------------- */

const fetchUserMedia = () => {
    return new Promise(async (resolve, reject) => {
        try {

            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: 640,
                    height: 480
                },
                audio: true
            });

            localVideoEl.srcObject = stream;

            localVideoEl.onloadedmetadata = () => {
                localVideoEl.play();
            };

            localStream = stream;
            cameraVideoTrack = stream.getVideoTracks()[0] || null;
            await localVideoEl.play();
            syncLandmarkCanvasSize();
            await ensureHandsModel();
            startHandDetectionLoop();

            resolve();

        } catch (err) {
            console.log(err);
            reject();
        }
    });
};

/* ---------------- PEER CONNECTION ---------------- */

const createPeerConnection = async (offerObj) => {

    peerConnection = new RTCPeerConnection(peerConfiguration);

    remoteStream = new MediaStream();
    remoteVideoEl.srcObject = remoteStream;

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.addEventListener('track', e => {

        e.streams[0].getTracks().forEach(track => {
            remoteStream.addTrack(track);
        });

    });

    peerConnection.addEventListener('icecandidate', e => {

        if (e.candidate) {

            socket.emit('sendIceCandidateToSignalingServer', {
                iceCandidate: e.candidate,
                iceUserName: userName,
                didIOffer
            });

        }

    });

    if (offerObj) {
        await peerConnection.setRemoteDescription(offerObj.offer);
    }
};

/* ---------------- CALL ---------------- */

const call = async () => {
    if (!localStream) {
        await fetchUserMedia();
    }
    await createPeerConnection();

    const offer = await peerConnection.createOffer();

    await peerConnection.setLocalDescription(offer);

    didIOffer = true;

    socket.emit('newOffer', offer);

    callButton.disabled = true;
    hangupButton.disabled = false;

};

const addNewIceCandidate = async (iceCandidate) => {
    if (!peerConnection || !iceCandidate) return;
    try {
        await peerConnection.addIceCandidate(iceCandidate);
    } catch (err) {
        console.error('Failed to add ICE candidate:', err);
    }
};

const answerOffer = async (offerObj) => {
    if (!localStream) {
        await fetchUserMedia();
    }

    await createPeerConnection(offerObj);

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    offerObj.answer = answer;

    socket.emit('newAnswer', offerObj, (offerIceCandidates) => {
        offerIceCandidates.forEach((candidate) => addNewIceCandidate(candidate));
    });

    callButton.disabled = true;
    hangupButton.disabled = false;
};

const addAnswer = async (offerObj) => {
    if (!peerConnection || !offerObj || !offerObj.answer) return;
    await peerConnection.setRemoteDescription(offerObj.answer);
};

const resetCallState = () => {
    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.close();
        peerConnection = null;
    }

    if (remoteVideoEl.srcObject) {
        remoteVideoEl.srcObject.getTracks().forEach((track) => track.stop());
    }
    remoteVideoEl.srcObject = null;

    callButton.disabled = false;
    hangupButton.disabled = true;
};

const stopScreenShare = async () => {
    if (!screenShareStream) return;

    screenShareStream.getTracks().forEach((track) => track.stop());
    screenShareStream = null;
    screenShareVideo.srcObject = null;

    if (peerConnection && cameraVideoTrack) {
        const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) {
            await sender.replaceTrack(cameraVideoTrack);
        }
    }

    socket.emit('stopScreenShare');
    startScreenShareButton.disabled = false;
    stopScreenShareButton.disabled = true;
};

const startScreenShare = async () => {
    try {
        screenShareStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false
        });

        const screenTrack = screenShareStream.getVideoTracks()[0];
        screenShareVideo.srcObject = screenShareStream;

        if (peerConnection) {
            const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) {
                await sender.replaceTrack(screenTrack);
            }
        }

        socket.emit('startScreenShare', { active: true });

        screenTrack.onended = () => {
            stopScreenShare();
        };

        startScreenShareButton.disabled = true;
        stopScreenShareButton.disabled = false;
    } catch (err) {
        console.error('Screen share failed:', err);
    }
};

const hangup = async () => {
    if (screenShareStream) {
        await stopScreenShare();
    }

    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    localVideoEl.srcObject = null;
    handDetectionStarted = false;
    handDetectedInFrame = false;
    landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);
    socket.emit('hangup', { userName });
    resetCallState();
};

callButton.addEventListener('click', call);
hangupButton.addEventListener('click', hangup);
startScreenShareButton.addEventListener('click', startScreenShare);
stopScreenShareButton.addEventListener('click', stopScreenShare);
hangupButton.disabled = true;

/* ---------------- SIGN LANGUAGE FRAME CAPTURE ---------------- */

const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d");

/* FIXED RESOLUTION */
captureCanvas.width = 640;
captureCanvas.height = 480;

const syncLandmarkCanvasSize = () => {
    landmarkCanvas.width = localVideoEl.videoWidth || 640;
    landmarkCanvas.height = localVideoEl.videoHeight || 480;
};

const ensureHandsModel = async () => {
    if (handsModel) return handsModel;
    if (typeof Hands === 'undefined') {
        console.error('MediaPipe Hands library not loaded.');
        return null;
    }

    handsModel = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    handsModel.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
    });

    handsModel.onResults((results) => {
        console.log('hands results:', results);

        landmarkCtx.save();
        landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);

        handDetectedInFrame = Boolean(
            results &&
            results.multiHandLandmarks &&
            results.multiHandLandmarks.length > 0
        );

        if (handDetectedInFrame) {
            results.multiHandLandmarks.forEach((landmarks) => {
                drawConnectors(landmarkCtx, landmarks, HAND_CONNECTIONS, {
                    color: '#00FF00',
                    lineWidth: 3
                });
                drawLandmarks(landmarkCtx, landmarks, {
                    color: '#FF0000',
                    lineWidth: 1,
                    radius: 3
                });
            });
        }

        landmarkCtx.restore();
    });

    return handsModel;
};

const startHandDetectionLoop = () => {
    if (handDetectionStarted) return;
    if (!handsModel) return;
    handDetectionStarted = true;

    const loop = async () => {
        if (!localVideoEl.srcObject) {
            handDetectionStarted = false;
            return;
        }

        if (
            handsModel &&
            localVideoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            !localVideoEl.paused &&
            !localVideoEl.ended
        ) {
            syncLandmarkCanvasSize();
            await handsModel.send({ image: localVideoEl });
        }

        requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
};

function sendFrameToServer() {

    if (!localVideoEl.srcObject) return;
    if (!handDetectedInFrame) return;

    captureCtx.drawImage(localVideoEl, 0, 0, 640, 480);

    const frame = captureCanvas.toDataURL("image/jpeg", 0.7);

    socket.emit("signFrame", frame);
}

/* send frame every 150ms */
setInterval(sendFrameToServer, 150);

/* ---------------- RECEIVE PREDICTION ---------------- */

socket.on("signPrediction", (prediction) => {

    signPredictionText.innerText = prediction;

});

// Save original camera track when local stream becomes available.

