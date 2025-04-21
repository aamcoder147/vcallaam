'use strict';

// Get references to HTML elements
const startButton = document.getElementById('startButton');
const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

// --- State Variables ---
let localStream;        // Our own video/audio stream
let remoteStream;       // The remote peer's stream
let peerConnection;     // RTCPeerConnection object
let isCaller = false;   // Are we the one initiating the call?

// --- Socket.IO Setup ---
// Connect to the Flask-SocketIO server
// Use window.location.origin if Flask is serving on the same host/port
// Or specify manually e.g., 'http://localhost:5000'
const socket = io(window.location.origin);

socket.on('connect', () => {
    console.log('Socket connected!', socket.id);
});

socket.on('disconnect', (reason) => {
    console.log(`Socket disconnected: ${reason}`);
    // Handle potential cleanup if needed
    handleHangup(); // Clean up call state if disconnected abruptly
});

socket.on('user-left', (data) => {
    console.log(`User left: ${data.sid}`);
    // If the user who left was the one we were talking to
    // You might need more robust logic here to track which SID is the remote peer
    if (remoteStream) { // Simple check: if we have a remote stream, assume it was them
       console.log("Remote peer left, hanging up.");
       handleHangup();
    }
});


// --- WebRTC Configuration ---
const pcConfig = {
    iceServers: [
        // Using public Google STUN servers
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Add TURN servers here if needed for complex networks
        // {
        //   urls: 'turn:your-turn-server.com:3478',
        //   username: 'user',
        //   credential: 'password'
        // }
    ]
};

// --- Event Listeners for Buttons ---
startButton.onclick = startCamera;
callButton.onclick = startCall;
hangupButton.onclick = handleHangup;

// --- Core Functions ---

async function startCamera() {
    console.log('Requesting local media stream...');
    startButton.disabled = true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        console.log('Received local stream');
        localVideo.srcObject = stream;
        localStream = stream;
        callButton.disabled = false; // Enable call button
    } catch (e) {
        console.error('getUserMedia() error:', e);
        alert(`Error getting media: ${e.name}`);
        startButton.disabled = false; // Re-enable if failed
    }
}

function createPeerConnection() {
    console.log('Creating Peer Connection');
    try {
        peerConnection = new RTCPeerConnection(pcConfig);

        // Event handler for when remote peer adds a track
        peerConnection.ontrack = handleRemoteTrack;

        // Event handler for when finding ICE candidates
        peerConnection.onicecandidate = handleIceCandidate;

        // Event handler for ICE connection state changes (useful for debugging)
        peerConnection.oniceconnectionstatechange = handleIceConnectionStateChange;

        console.log('RTCPeerConnection created');

        // Add local stream tracks to the connection
        localStream.getTracks().forEach(track => {
            console.log('Adding local track:', track.kind);
            peerConnection.addTrack(track, localStream);
        });
        console.log('Local tracks added');

    } catch (e) {
        console.error('Failed to create PeerConnection:', e);
        alert('Cannot create RTCPeerConnection object.');
        return;
    }
}

async function startCall() {
    console.log('Starting call');
    callButton.disabled = true;
    hangupButton.disabled = false;
    isCaller = true;

    createPeerConnection();

    try {
        console.log('Creating offer...');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        console.log('Offer created and set as local description');
        console.log('Sending offer to peer');
        // Send the offer via signaling server
        sendMessage({ type: 'offer', sdp: offer.sdp });
    } catch (e) {
        console.error('Error creating or sending offer:', e);
        handleHangup(); // Clean up on error
    }
}

async function handleOffer(offerSdp) {
    if (!peerConnection) { // If we haven't created connection yet (e.g., receiving call)
        createPeerConnection();
    }

    console.log('Received offer, setting remote description');
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
        console.log('Remote description set from offer');
        console.log('Creating answer...');
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('Answer created and set as local description');
        console.log('Sending answer to peer');
        // Send the answer via signaling server
        sendMessage({ type: 'answer', sdp: answer.sdp });

        // Update UI (already in call now)
        callButton.disabled = true;
        hangupButton.disabled = false;

    } catch (e) {
        console.error('Error handling offer or creating answer:', e);
        handleHangup();
    }
}

async function handleAnswer(answerSdp) {
    console.log('Received answer, setting remote description');
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));
        console.log('Remote description set from answer');
        // Connection should now be established or establishing
    } catch (e) {
        console.error('Error setting remote description from answer:', e);
        handleHangup();
    }
}

async function handleCandidate(candidateData) {
    console.log('Received ICE candidate');
    try {
        // Create RTCIceCandidate object from the received data
        const candidate = new RTCIceCandidate({
            sdpMLineIndex: candidateData.label,
            candidate: candidateData.candidate
        });
        await peerConnection.addIceCandidate(candidate);
        console.log('Added received ICE candidate');
    } catch (e) {
        // Ignore benign errors like candidate already added or connection closed
        if (!e.message.includes("Cannot add ICE candidate")) {
           console.error('Error adding received ICE candidate:', e);
        }
    }
}


function handleRemoteTrack(event) {
    console.log('Remote track received:', event.track.kind);
    if (event.streams && event.streams[0]) {
        // Don't set srcObject again if it's already set.
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            remoteStream = event.streams[0];
            console.log('Assigned remote stream to remoteVideo element');
        }
    } else {
        // Fallback for older browser versions or specific scenarios
        if (!remoteStream) {
             remoteStream = new MediaStream();
             remoteVideo.srcObject = remoteStream;
        }
        remoteStream.addTrack(event.track);
         console.log('Added remote track to fallback stream');
    }
}


function handleIceCandidate(event) {
    if (event.candidate) {
        console.log('Found ICE candidate:', event.candidate.candidate);
        // Send the candidate via signaling server
        sendMessage({
            type: 'candidate',
            label: event.candidate.sdpMLineIndex,
            id: event.candidate.sdpMid, // Usually not needed for recipient but good practice
            candidate: event.candidate.candidate
        });
    } else {
        console.log('End of ICE candidates.');
    }
}

function handleIceConnectionStateChange() {
    if (peerConnection) {
        console.log('ICE connection state change:', peerConnection.iceConnectionState);
        // Possible states: 'new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'
        if (peerConnection.iceConnectionState === 'failed' ||
            peerConnection.iceConnectionState === 'disconnected' ||
            peerConnection.iceConnectionState === 'closed') {
            console.warn(`ICE connection state is ${peerConnection.iceConnectionState}. May need to hang up.`);
            // Optionally, attempt ICE restart or just hang up
            // handleHangup(); // Be cautious with auto-hangup here
        }
    }
}


function handleHangup() {
    console.log('Ending call');
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null; // Clean up the connection object
    }
    if(localStream) {
        localStream.getTracks().forEach(track => track.stop()); // Stop camera/mic
        localStream = null;
    }
    if(remoteStream) {
         remoteVideo.srcObject = null; // Clear remote video display
         remoteStream = null;
    }

    // Reset UI
    startButton.disabled = false;
    callButton.disabled = true;
    hangupButton.disabled = true;
    isCaller = false; // Reset caller status
    localVideo.srcObject = null; // Clear local video preview too

    // Optionally notify the other peer you are hanging up via signaling
    // sendMessage({ type: 'bye' }); // Implement 'bye' handling on server/client if needed

    console.log('Call ended and resources released.');
}


// --- Signaling Message Handling ---
function sendMessage(message) {
    // console.log('Sending message via SocketIO:', message);
    socket.emit('signal', message);
}

// Listen for signaling messages from the server
socket.on('signal', (message) => {
    // console.log('Received message via SocketIO:', message);

    if (!localStream && (message.type === 'offer' || message.type === 'answer')) {
        console.warn("Received signal but local stream is not ready yet.");
        // Potentially queue the message or request user to start camera first
        return;
    }

    switch (message.type) {
        case 'offer':
            // Received an offer from a peer - we are the callee
            if (!isCaller) { // Only handle offer if we didn't initiate the call
                 handleOffer(message.sdp);
            }
            break;
        case 'answer':
            // Received an answer from the peer we called
            if (isCaller) { // Only handle answer if we initiated the call
                handleAnswer(message.sdp);
            }
            break;
        case 'candidate':
            // Received an ICE candidate from the peer
            if(peerConnection) { // Only handle if connection exists
                 handleCandidate(message);
            }
            break;
        // case 'bye': // Example for handling explicit hangup signal
        //     handleHangup();
        //     break;
        default:
            console.log('Unrecognized message type:', message.type);
            break;
    }
});