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

// rooms: Map<roomId, { hostId, title, viewers: Map<socketId, {username}>, chat: [], startTime, fakeViewers, bannedWords }>
const rooms = new Map();
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

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
      startTime: Date.now(),
      fakeViewers: 0,
      bannedWords: [],
      poll: null,
      silentMode: false
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
      hostId: room.hostId,
      activePoll: room.poll ? {
        question: room.poll.question,
        options: room.poll.options,
        total: room.poll.options.reduce((s, o) => s + o.votes, 0)
      } : null
    });

    // Ask host to send an offer to this viewer
    io.to(room.hostId).emit('viewer:new', {
      viewerId: socket.id,
      username: name,
      viewerCount: room.viewers.size
    });

    // Broadcast updated count to everyone in room
    io.to(roomId).emit('viewer:count', { count: room.viewers.size + room.fakeViewers });
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
      if (room.silentMode) return;
      const viewer = room.viewers.get(socket.id);
      if (viewer && viewer.chatBanned) return;
    }
    const lower = message.trim().toLowerCase();
    if (room.bannedWords.some(w => lower.includes(w.toLowerCase()))) return;

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

  // ─── SILENT MODE ───────────────────────────────────────────────────────────

  socket.on('host:silent-mode', ({ active }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    room.silentMode = active;
    // Notify all viewers
    io.to(socket.roomId).emit('silent:mode', { active });
    console.log(`[silent-mode] room ${socket.roomId} → ${active}`);
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

  // ─── ADMIN ─────────────────────────────────────────────────────────────────

  function adminAuth(pass, roomId) {
    if (pass !== ADMIN_PASS) return null;
    return rooms.get(roomId) || null;
  }

  socket.on('admin:fake-viewers', ({ pass, roomId, count }) => {
    const room = adminAuth(pass, roomId);
    if (!room) return socket.emit('admin:error', 'Senha ou sala inválida.');
    room.fakeViewers = Math.max(0, parseInt(count) || 0);
    io.to(roomId).emit('viewer:count', { count: room.viewers.size + room.fakeViewers });
    socket.emit('admin:ok', `Espectadores falsos: ${room.fakeViewers}`);
  });

  socket.on('admin:fake-message', ({ pass, roomId, username, message }) => {
    const room = adminAuth(pass, roomId);
    if (!room) return socket.emit('admin:error', 'Senha ou sala inválida.');
    if (!message.trim()) return;
    const msg = {
      id: Date.now(),
      username: username || 'Espectador',
      message: message.trim().slice(0, 300),
      timestamp: Date.now(),
      isHost: false
    };
    room.chat.push(msg);
    if (room.chat.length > 500) room.chat.shift();
    io.to(roomId).emit('chat:message', msg);
    socket.emit('admin:ok', 'Mensagem enviada.');
  });

  socket.on('admin:add-word', ({ pass, roomId, word }) => {
    const room = adminAuth(pass, roomId);
    if (!room) return socket.emit('admin:error', 'Senha ou sala inválida.');
    const w = word.trim().toLowerCase();
    if (w && !room.bannedWords.includes(w)) room.bannedWords.push(w);
    socket.emit('admin:words', room.bannedWords);
  });

  socket.on('admin:remove-word', ({ pass, roomId, word }) => {
    const room = adminAuth(pass, roomId);
    if (!room) return socket.emit('admin:error', 'Senha ou sala inválida.');
    room.bannedWords = room.bannedWords.filter(w => w !== word.toLowerCase());
    socket.emit('admin:words', room.bannedWords);
  });

  socket.on('admin:get-room', ({ pass, roomId }) => {
    const room = adminAuth(pass, roomId);
    if (!room) return socket.emit('admin:error', 'Senha ou sala inválida.');
    socket.emit('admin:room-info', {
      title: room.title,
      viewers: room.viewers.size,
      fakeViewers: room.fakeViewers,
      bannedWords: room.bannedWords,
      recentChat: room.chat.slice(-30)
    });
  });

  socket.on('chat:reaction', ({ emoji }) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    io.to(socket.roomId).emit('chat:reaction', { emoji });
  });

  // ─── POLL ──────────────────────────────────────────────────────────────────

  socket.on('poll:create', ({ question, options }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id) return;
    if (!question || !options || options.length < 2) return;
    room.poll = {
      question: question.trim().slice(0, 200),
      options: options.map(t => ({ text: t.trim().slice(0, 100), votes: 0 })),
      active: true,
      voters: new Set()
    };
    io.to(socket.roomId).emit('poll:started', {
      question: room.poll.question,
      options: room.poll.options
    });
  });

  socket.on('poll:vote', ({ optionIndex }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.poll || !room.poll.active) return;
    if (room.poll.voters.has(socket.id)) return;
    if (optionIndex < 0 || optionIndex >= room.poll.options.length) return;
    room.poll.voters.add(socket.id);
    room.poll.options[optionIndex].votes++;
    const total = room.poll.options.reduce((s, o) => s + o.votes, 0);
    io.to(socket.roomId).emit('poll:update', { options: room.poll.options, total });
  });

  socket.on('poll:end', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.hostId !== socket.id || !room.poll) return;
    const total = room.poll.options.reduce((s, o) => s + o.votes, 0);
    io.to(socket.roomId).emit('poll:ended', { options: room.poll.options, total });
    room.poll = null;
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
      io.to(roomId).emit('viewer:count', { count: room.viewers.size + room.fakeViewers });
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
