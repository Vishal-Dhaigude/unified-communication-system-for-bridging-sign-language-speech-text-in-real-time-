
const fs = require("fs");
const https = require("https");
const express = require("express");
const socketio = require("socket.io");
const { spawn } = require("child_process");
const path = require("path");

const app = express();
app.use(express.static(__dirname));

// ================= HTTPS CERTIFICATES =================

const key = fs.readFileSync("cert.key");
const cert = fs.readFileSync("cert.crt");

const expressServer = https.createServer({ key, cert }, app);

const io = socketio(expressServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

expressServer.listen(5000, () => {
    console.log("Server running on https://localhost:5000");
});

// ================= START PYTHON MODEL =================

const pythonScript = path.join(__dirname, "..", "Backend", "src", "real_time_prediction.py");
const PYTHON_RESTART_DELAY_MS = 2000;
const FRAME_THROTTLE_MS = 120;

let pythonProcess = null;
let pythonReady = false;
let restartingPython = false;
let writeInProgress = false;

const startPythonProcess = () => {
    console.log("Starting Python script:", pythonScript);
    pythonProcess = spawn("python", [pythonScript]);
    pythonReady = true;

    // Python output (prediction)
    pythonProcess.stdout.on("data", (data) => {
        const prediction = data.toString().trim();
        if (!prediction) return;

        io.emit("signPrediction", prediction);
    });

    // Python errors
    pythonProcess.stderr.on("data", (data) => {
        console.error("Python Error:", data.toString());
    });

    // Python exit
    pythonProcess.on("close", (code) => {
        console.log("Python process exited with code:", code);
        pythonReady = false;
        pythonProcess = null;

        if (!restartingPython) {
            restartingPython = true;
            setTimeout(() => {
                restartingPython = false;
                startPythonProcess();
            }, PYTHON_RESTART_DELAY_MS);
        }
    });
};

startPythonProcess();

// ================= VIDEO CALL DATA =================

const offers = [];
const connectedSockets = [];

const removeSocketFromConnectedList = (socketId) => {
    const index = connectedSockets.findIndex((s) => s.socketId === socketId);
    if (index !== -1) {
        connectedSockets.splice(index, 1);
    }
};

const removeOffersForUser = (userName) => {
    for (let i = offers.length - 1; i >= 0; i -= 1) {
        if (
            offers[i].offererUserName === userName ||
            offers[i].answererUserName === userName
        ) {
            offers.splice(i, 1);
        }
    }
};

// ================= SOCKET CONNECTION =================

io.on("connection", (socket) => {

    console.log("User connected:", socket.id);

    const userName = socket.handshake.auth.userName;
    const password = socket.handshake.auth.password;

    if (password !== "x") {
        socket.disconnect(true);
        return;
    }

    connectedSockets.push({
        socketId: socket.id,
        userName
    });
    let lastFrameSentAt = 0;

    if (offers.length) {
        socket.emit("availableOffers", offers);
    }

    // ================= SEND FRAME TO PYTHON =================

   socket.on("signFrame", (frame) => {

    try {

        if (!frame) return;
        if (!pythonReady || !pythonProcess || !pythonProcess.stdin || !pythonProcess.stdin.writable) return;
        if (writeInProgress) return;

        const now = Date.now();
        if (now - lastFrameSentAt < FRAME_THROTTLE_MS) return;
        lastFrameSentAt = now;

        writeInProgress = true;
        const writeOk = pythonProcess.stdin.write(frame.replace(/\n/g, "") + "\n", () => {
            writeInProgress = false;
        });

        // If internal buffer is full, wait for drain before accepting more writes.
        if (!writeOk && pythonProcess && pythonProcess.stdin) {
            pythonProcess.stdin.once("drain", () => {
                writeInProgress = false;
            });
        }

    } catch (err) {

        console.error("Frame send error:", err);

    }



    });

    // ================= WEBRTC OFFER =================

    socket.on("newOffer", newOffer => {

        offers.push({
            offererUserName: userName,
            offer: newOffer,
            offerIceCandidates: [],
            answererUserName: null,
            answer: null,
            answererIceCandidates: []
        });

        socket.broadcast.emit("newOfferAwaiting", offers.slice(-1));

    });

    // ================= WEBRTC ANSWER =================

    socket.on("newAnswer", (offerObj, ackFunction) => {

        const socketToAnswer = connectedSockets.find(
            s => s.userName === offerObj.offererUserName
        );

        if (!socketToAnswer) return;

        const socketIdToAnswer = socketToAnswer.socketId;

        const offerToUpdate = offers.find(
            o => o.offererUserName === offerObj.offererUserName
        );

        if (!offerToUpdate) return;

        ackFunction(offerToUpdate.offerIceCandidates);

        offerToUpdate.answer = offerObj.answer;
        offerToUpdate.answererUserName = userName;

        socket.to(socketIdToAnswer)
              .emit("answerResponse", offerToUpdate);

    });

    // ================= ICE CANDIDATES =================

    socket.on("sendIceCandidateToSignalingServer", iceCandidateObj => {

        const { didIOffer, iceUserName, iceCandidate } = iceCandidateObj;

        if (didIOffer) {

            const offerInOffers = offers.find(o => o.offererUserName === iceUserName);

            if (offerInOffers) {

                offerInOffers.offerIceCandidates.push(iceCandidate);

                if (offerInOffers.answererUserName) {

                    const socketToSendTo = connectedSockets.find(
                        s => s.userName === offerInOffers.answererUserName
                    );

                    if (socketToSendTo) {

                        socket.to(socketToSendTo.socketId)
                              .emit("receivedIceCandidateFromServer", iceCandidate);

                    }

                }

            }

        } else {

            const offerInOffers = offers.find(o => o.answererUserName === iceUserName);

            if (!offerInOffers) return;

            const socketToSendTo = connectedSockets.find(
                s => s.userName === offerInOffers.offererUserName
            );

            if (socketToSendTo) {

                socket.to(socketToSendTo.socketId)
                      .emit("receivedIceCandidateFromServer", iceCandidate);

            }

        }

    });

    // ================= HANGUP =================

    socket.on("hangup", ({ userName }) => {

        socket.broadcast.emit("callEnded", { userName });

        removeOffersForUser(userName);

    });

    // ================= SPEECH TO SYMBOL =================

    socket.on("speechToSymbol", (data) => {
        socket.broadcast.emit("updateSpeechToSymbol", data);
    });

    // ================= SCREEN SHARE =================

    socket.on("startScreenShare", (data) => {
        socket.broadcast.emit("receivedScreenShareStream", data);
    });

    socket.on("stopScreenShare", () => {
        socket.broadcast.emit("screenShareStopped");
    });

    socket.on("disconnect", () => {
        removeSocketFromConnectedList(socket.id);
        removeOffersForUser(userName);
        socket.broadcast.emit("callEnded", { userName });
        console.log("User disconnected:", socket.id, userName);
    });

});

