from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key!' # Change this!
# Use eventlet for async mode, suitable for WebSocket handling
socketio = SocketIO(app, async_mode='eventlet')

# In-memory store for simplicity (replace with DB in production)
# We'll use a single room 'chat_room' for this demo
connected_users = {} # Store sid -> user info (if needed)

@app.route('/')
def index():
    """Serve the main HTML page."""
    return render_template('index.html')

# --- SocketIO Signaling Events ---

@socketio.on('connect')
def handle_connect():
    """Client connected."""
    print(f"Client connected: {request.sid}")
    connected_users[request.sid] = {"sid": request.sid}
    # For simplicity, automatically join everyone to the same room
    join_room('chat_room')
    print(f"Client {request.sid} joined room 'chat_room'")
    # Notify others (optional, can be used for user lists)
    # emit('user-joined', {'sid': request.sid}, room='chat_room', skip_sid=request.sid)


@socketio.on('disconnect')
def handle_disconnect():
    """Client disconnected."""
    print(f"Client disconnected: {request.sid}")
    if request.sid in connected_users:
        del connected_users[request.sid]
    # Automatically handles leaving rooms on disconnect
    leave_room('chat_room')
    print(f"Client {request.sid} left room 'chat_room'")
    # Notify others the user left
    emit('user-left', {'sid': request.sid}, room='chat_room') # Broadcast to the room


@socketio.on('signal')
def handle_signal(message):
    """Relay signaling messages (offer, answer, candidate) between peers."""
    print(f"Received signal from {request.sid}: Type {message.get('type')}")
    # Send the message to all *other* clients in the room
    emit('signal', message, room='chat_room', skip_sid=request.sid)


# --- Main Execution ---
if __name__ == '__main__':
    print("Starting Flask-SocketIO server...")
    # Use socketio.run for development with WebSocket support
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)