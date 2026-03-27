const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms: Map<roomId, { hostId, title, viewers: Map<socketId, {username}>, chat: [], startTime }>
const rooms = new Map();

function getRoomStats(room) {
  return {
    viewerCount: room.viewers.size,
    uptime: Math.floor((Date.now() - room.startTime) / 1000)
  };
}

io.on('connection', (socket) => {
  console.log('[connect]', socket.id);

  // ─── HOST ──────────────────────────────────────────────────────────────────

  socket.on('host:create', ({ title }) => {
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    rooms.set(roomId, {
      hostId: socket.id,
      title: title || 'Live Stream',
      viewers: new Map(),
      chat: [],
      startTime: Date.now()
    });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isHost = true;
    socket.emit('host:created', { roomId, title });
    console.log(`[room:create] ${roomId} — "${title}"`);
  });

  socket.on('host:end', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(socket.roomId).emit('stream:ended', { message: 'O host encerrou a live.' });
    rooms.delete(socket.roomId);
    console.log(`[room:end] ${socket.roomId}`);
  });

  // ─── VIEWER ────────────────────────────────────────────────────────────────

  socket.on('viewer:join', ({ roomId, username }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Sala não encontrada. Verifique o código.' });
      return;
    }

    const name = username || `Espectador ${room.viewers.size + 1}`;
    room.viewers.set(socket.id, { username: name });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = name;
    socket.isViewer = true;

    // Tell viewer it's good
    socket.emit('viewer:joined:ok', {
      title: room.title,
      viewerCount: room.viewers.size,
      recentChat: room.chat.slice(-50),
      hostId: room.hostId
    });

    // Ask host to send an offer to this viewer
    io.to(room.hostId).emit('viewer:new', {
      viewerId: socket.id,
      username: name,
      viewerCount: room.viewers.size
    });

    // Broadcast updated count to everyone in room
    io.to(roomId).emit('viewer:count', { count: room.viewers.size });
    console.log(`[viewer:join] ${name} → room ${roomId} (total: ${room.viewers.size})`);
  });

  // ─── WEBRTC SIGNALING (host → viewer) ─────────────────────────────────────

  socket.on('webrtc:offer', ({ targetId, offer }) => {
    io.to(targetId).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ─── WEBRTC UPSTREAM (viewer → host mic/camera) ────────────────────────────

  socket.on('upstream:offer', ({ offer }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    io.to(room.hostId).emit('upstream:offer', {
      viewerId: socket.id,
      username: socket.username,
      offer
    });
  });

  socket.on('upstream:answer', ({ viewerId, answer }) => {
    io.to(viewerId).emit('upstream:answer', { answer });
  });

  socket.on('upstream:ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('upstream:ice', { from: socket.id, candidate });
  });

  socket.on('upstream:stop', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    io.to(room.hostId).emit('upstream:stop', { viewerId: socket.id });
  });

  // ─── CHAT ──────────────────────────────────────────────────────────────────

  socket.on('chat:message', ({ message }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !message.trim()) return;
    if (socket.isViewer) {
      const viewer = room.viewers.get(socket.id);
      if (viewer && viewer.chatBanned) return;
    }

    const msg = {
      id: Date.now(),
      username: socket.username || 'Host',
      message: message.trim().slice(0, 300),
      timestamp: Date.now(),
      isHost: socket.isHost || false
    };

    room.chat.push(msg);
    if (room.chat.length > 500) room.chat.shift();

    io.to(socket.roomId).emit('chat:message', msg);
  });

  // ─── HOST ADMIN ACTIONS ────────────────────────────────────────────────────

  socket.on('host:kick', ({ viewerId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(viewerId).emit('kicked', { message: 'Você foi removido da live pelo host.' });
    console.log(`[kick] ${viewerId} from ${socket.roomId}`);
  });

  socket.on('host:mute-viewer', ({ viewerId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(viewerId).emit('host:muted');
  });

  socket.on('host:unmute-viewer', ({ viewerId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(viewerId).emit('host:unmuted');
  });

  socket.on('host:disable-video', ({ viewerId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(viewerId).emit('host:video-off');
  });

  socket.on('host:enable-video', ({ viewerId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(viewerId).emit('host:video-on');
  });

  socket.on('host:ban-chat', ({ viewerId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    const viewer = room.viewers.get(viewerId);
    if (viewer) viewer.chatBanned = true;
    io.to(viewerId).emit('host:chat-banned');
  });

  socket.on('host:unban-chat', ({ viewerId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    const viewer = room.viewers.get(viewerId);
    if (viewer) viewer.chatBanned = false;
    io.to(viewerId).emit('host:chat-unbanned');
  });

  socket.on('chat:reaction', ({ emoji }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    io.to(socket.roomId).emit('chat:reaction', { emoji });
  });

  socket.on('host:pin-message', ({ msgId }) => {
    io.to(socket.roomId).emit('chat:pinned', { msgId });
  });

  // ─── DISCONNECT ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log('[disconnect]', socket.id);
    const roomId = socket.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (socket.isHost) {
      io.to(roomId).emit('stream:ended', { message: 'O host caiu. Stream encerrada.' });
      rooms.delete(roomId);
    } else if (socket.isViewer) {
      room.viewers.delete(socket.id);
      io.to(roomId).emit('viewer:count', { count: room.viewers.size });
      io.to(room.hostId).emit('viewer:left', {
        viewerId: socket.id,
        username: socket.username,
        viewerCount: room.viewers.size
      });
    }
  });
});

// REST: list active rooms (optional discovery)
app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const [id, room] of rooms.entries()) {
    list.push({
      id,
      title: room.title,
      viewerCount: room.viewers.size,
      uptime: Math.floor((Date.now() - room.startTime) / 1000)
    });
  }
  res.json(list);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎥  Streem Elite rodando em http://localhost:${PORT}`);
  console.log(`    Host:   http://localhost:${PORT}/host.html`);
  console.log(`    Viewer: http://localhost:${PORT}/viewer.html\n`);
});
