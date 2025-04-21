'use strict';

// Get references to HTML elements
const startMicButton = document.getElementById('startMicButton');
const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
const remoteAudio = document.getElementById('remoteAudio');
const statusDiv = document.getElementById('status');

// --- State Variables ---
let localStream;        // Our own audio stream
let remoteStream;       // The remote peer's stream (kept for reference/cleanup)
let peerConnection;     // RTCPeerConnection object
let isCaller = false;   // Are we the one initiating the call?

// --- Utility Function ---
function updateStatus(message) {
    console.log("Status:", message); // Log to console as well
    statusDiv.textContent = message;
}

// --- Socket.IO Setup ---
const socket = io(window.location.origin);

socket.on('connect', () => {
    console.log('Socket connected!', socket.id);
    updateStatus('Connected to server. Ready.');
    startMicButton.disabled = false; // Enable mic button once connected
});

socket.on('disconnect', (reason) => {
    console.log(`Socket disconnected: ${reason}`);
    updateStatus(`Server disconnected: ${reason}`);
    handleHangup(false); // Clean up call state, don't send 'bye'
    startMicButton.disabled = true;
    callButton.disabled = true;
    hangupButton.disabled = true;
});

socket.on('user-left', (data) => {
    console.log(`User left: ${data.sid}`);
    if (peerConnection) { // Simple check: if we are in a call
       updateStatus("Remote peer left. Call ended.");
       handleHangup(false); // Clean up without sending 'bye' again
    }
});

// --- WebRTC Configuration ---
const pcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Add TURN servers here if needed
    ]
};

// --- Event Listeners for Buttons ---
startMicButton.onclick = startMic;
callButton.onclick = startCall;
hangupButton.onclick = () => handleHangup(true); // Pass true to send 'bye'

// --- Core Functions ---

async function startMic() {
    console.log('Requesting local media stream (audio only)...');
    updateStatus('Requesting Mic access...');
    startMicButton.disabled = true;
    try {
        // Request audio only
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log('Received local audio stream');
        localStream = stream;
        callButton.disabled = false; // Enable call button
        updateStatus('Mic ready. You can now Call.');
        // We don't need to display local audio, browser handles loopback internally if needed
    } catch (e) {
        console.error('getUserMedia() error:', e);
        alert(`Error getting microphone: ${e.name}\n\nPlease ensure you grant permission.`);
        updateStatus(`Error: ${e.message}`);
        startMicButton.disabled = false; // Re-enable if failed
    }
}

function createPeerConnection() {
    console.log('Creating Peer Connection');
    updateStatus('Setting up connection...');
    try {
        peerConnection = new RTCPeerConnection(pcConfig);
        peerConnection.ontrack = handleRemoteTrack;
        peerConnection.onicecandidate = handleIceCandidate;
        peerConnection.oniceconnectionstatechange = handleIceConnectionStateChange;
        console.log('RTCPeerConnection created');

        // Add local stream tracks to the connection
        localStream.getTracks().forEach(track => {
            if (track.kind === 'audio') { // Ensure we only add audio
                 console.log('Adding local audio track');
                 peerConnection.addTrack(track, localStream);
            }
        });
        console.log('Local tracks added');

    } catch (e) {
        console.error('Failed to create PeerConnection:', e);
        alert('Cannot create RTCPeerConnection object.');
        updateStatus('Connection setup failed.');
        return;
    }
}

async function startCall() {
    console.log('Starting call');
    updateStatus('Calling...');
    callButton.disabled = true;
    hangupButton.disabled = false;
    isCaller = true;

    createPeerConnection();

    try {
        console.log('Creating offer...');
        const offer = await peerConnection.createOffer({
             // Optional: Offer audio only explicitly if needed (usually defaults work)
             // offerToReceiveAudio: 1,
             // offerToReceiveVideo: 0
        });
        await peerConnection.setLocalDescription(offer);
        console.log('Offer created and set as local description');
        console.log('Sending offer to peer');
        updateStatus('Sending call request...');
        sendMessage({ type: 'offer', sdp: offer.sdp });
    } catch (e) {
        console.error('Error creating or sending offer:', e);
        updateStatus('Call initiation failed.');
        handleHangup(false); // Clean up on error
    }
}

async function handleOffer(offerSdp) {
     // Only process offer if we aren't already in a call or calling
    if (peerConnection) {
         console.warn("Received offer but connection already exists. Ignoring.");
         return; // Avoid processing if already connected or calling
    }
    if (!localStream) {
        console.warn("Received call but mic is not ready. Informing user.");
        updateStatus("Incoming call, please Start Mic first!");
        // Optional: Send a signal back indicating busy or mic not ready
        return;
    }

    isCaller = false; // We are receiving the call
    createPeerConnection();

    console.log('Received offer, setting remote description');
    updateStatus('Incoming call...');
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
        console.log('Remote description set from offer');
        console.log('Creating answer...');
        updateStatus('Answering call...');
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('Answer created and set as local description');
        console.log('Sending answer to peer');
        sendMessage({ type: 'answer', sdp: answer.sdp });

        // Update UI (now in call)
        callButton.disabled = true;
        hangupButton.disabled = false;
        startMicButton.disabled = true; // Can't restart mic while in call
        updateStatus('Call Connected!'); // Update status once answer sent

    } catch (e) {
        console.error('Error handling offer or creating answer:', e);
        updateStatus('Failed to answer call.');
        handleHangup(false);
    }
}

async function handleAnswer(answerSdp) {
    // Only process answer if we were the caller and have a connection
     if (!isCaller || !peerConnection || peerConnection.signalingState !== 'have-local-offer') {
        console.warn("Received answer but wasn't expecting one. Ignoring.");
        return;
    }

    console.log('Received answer, setting remote description');
    updateStatus('Call answered, connecting...');
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));
        console.log('Remote description set from answer');
        // Status usually updates fully on ICE connection completion
        // updateStatus('Call Connected!'); // Can be set here or wait for ICE state 'connected'
    } catch (e) {
        console.error('Error setting remote description from answer:', e);
        updateStatus('Failed to process answer.');
        handleHangup(false);
    }
}

async function handleCandidate(candidateData) {
    if (!peerConnection || peerConnection.signalingState === 'closed') {
        console.warn("Received ICE candidate but connection is not ready or closed. Ignoring.");
        return;
    }
    console.log('Received ICE candidate');
    // updateStatus('Exchanging connection details...'); // Can be noisy
    try {
        const candidate = new RTCIceCandidate({
            sdpMLineIndex: candidateData.label,
            candidate: candidateData.candidate
        });
        await peerConnection.addIceCandidate(candidate);
        console.log('Added received ICE candidate');
    } catch (e) {
        if (!e.message.includes("Cannot add ICE candidate") && !e.message.includes("already been gathered")) {
           console.error('Error adding received ICE candidate:', e);
           // updateStatus('Connection negotiation error.'); // Inform user
        }
    }
}

function handleRemoteTrack(event) {
    console.log('Remote track received:', event.track.kind);
    // Only handle audio tracks
    if (event.track.kind === 'audio') {
        if (remoteAudio.srcObject !== event.streams[0]) {
            console.log('Assigning remote stream to remoteAudio element');
            remoteAudio.srcObject = event.streams[0];
            remoteStream = event.streams[0]; // Keep reference if needed

             // Make sure it plays (browsers might block autoplay without interaction)
            remoteAudio.play().catch(e => console.warn("Remote audio play failed:", e));
        }
    } else {
        console.log("Ignoring non-audio track:", event.track.kind);
    }
}

function handleIceCandidate(event) {
    if (event.candidate) {
        console.log('Found ICE candidate:', event.candidate.candidate ? event.candidate.candidate.substring(0, 40) + '...' : '(empty candidate)');
        sendMessage({
            type: 'candidate',
            label: event.candidate.sdpMLineIndex,
            id: event.candidate.sdpMid,
            candidate: event.candidate.candidate
        });
    } else {
        console.log('End of ICE candidates.');
    }
}

function handleIceConnectionStateChange() {
    if (peerConnection) {
        const state = peerConnection.iceConnectionState;
        console.log('ICE connection state change:', state);
        switch (state) {
            case 'checking':
                updateStatus('Connecting...');
                break;
            case 'connected': // P2P connection active (usually)
                 // Might sometimes jump straight to 'completed'
                updateStatus('Call Connected!');
                startMicButton.disabled = true; // Ensure mic button disabled once fully connected
                callButton.disabled = true;
                hangupButton.disabled = false;
                break;
            case 'completed': // All ICE negotiations finished
                 // updateStatus('Connection check complete.'); // Already shows 'Connected' usually
                 break;
            case 'disconnected':
                updateStatus('Connection lost. Trying to reconnect...');
                // WebRTC might automatically try to reconnect (ICE restart)
                break;
            case 'failed':
                updateStatus('Connection failed. Please hang up.');
                // Requires user action (hangup)
                handleHangup(false); // Or automatically hang up? Be careful.
                break;
            case 'closed':
                updateStatus('Connection closed.');
                // State after hangup or irrecoverable failure
                break;
        }
    }
}

// Modified hangup to accept a flag for sending 'bye' signal
function handleHangup(notifyPeer = true) {
    console.log('Ending call. Notify peer:', notifyPeer);
    updateStatus('Ending call...');

    // Optional: Send 'bye' signal if requested (and if connection exists)
    if (notifyPeer && peerConnection && peerConnection.signalingState !== 'closed') {
        console.log("Sending 'bye' signal");
        sendMessage({ type: 'bye' }); // Implement 'bye' handling below if needed
    }

    if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.oniceconnectionstatechange = null;
        // Stop transceivers (cleaner way to stop sending/receiving)
        peerConnection.getTransceivers().forEach(transceiver => {
           if (transceiver.stop) { // Check if stop method exists
             transceiver.stop();
           }
           // Fallback for older method if needed:
           // if (transceiver.sender && transceiver.sender.track) {
           //     transceiver.sender.track.stop();
           // }
        });
        peerConnection.close();
        peerConnection = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    if (remoteStream) {
         remoteAudio.srcObject = null;
         remoteStream = null;
    }

    // Reset UI
    callButton.disabled = true;
    hangupButton.disabled = true;
    startMicButton.disabled = (socket.connected === false); // Only enable if socket is still ok
    isCaller = false;

    // Give a final status after cleanup
    setTimeout(() => {
       if (statusDiv.textContent.startsWith('Ending')) { // Only reset if still 'Ending'
          updateStatus(socket.connected ? 'Ready' : 'Disconnected');
       }
    }, 500); // Short delay to allow 'closed' state to register

    console.log('Call ended and resources released.');
}

// --- Signaling Message Handling ---
function sendMessage(message) {
    console.log('Sending signal:', message.type); // SDP can be large, avoid logging fully
    socket.emit('signal', message);
}

socket.on('signal', (message) => {
    // console.log('Received signal:', message); // Can be noisy

    if (!localStream && (message.type === 'offer' || message.type === 'answer')) {
        console.warn("Received signal but local mic stream is not ready yet.");
        // Handle offer might already check this, but defensive coding is good
        if(message.type === 'offer') {
             updateStatus("Incoming call, please Start Mic first!");
        }
        return;
    }

    switch (message.type) {
        case 'offer':
            handleOffer(message.sdp);
            break;
        case 'answer':
            handleAnswer(message.sdp);
            break;
        case 'candidate':
            handleCandidate(message);
            break;
        case 'bye': // Handle explicit hangup signal from peer
            console.log("Received 'bye' signal from peer.");
            updateStatus('Peer hung up. Call ended.');
            handleHangup(false); // Clean up locally, don't send 'bye' back
            break;
        default:
            console.log('Unrecognized signal type:', message.type);
            break;
    }
});