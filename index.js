import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
const server = createServer(app);
const io = new Server(server);

const __dirname = dirname(fileURLToPath(import.meta.url));

// 1. URLごとの画面の振り分け設定
app.get('/', (req, res) => res.sendFile(join(__dirname, 'login.html')));
app.get('/chat', (req, res) => res.sendFile(join(__dirname, 'chat.html')));

const registeredUsers = {}; 
const activeSockets = {};    
const bannedUsers = new Set();
const bannedIPs = new Set();

io.on('connection', (socket) => {
  let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  if (ip.includes(',')) ip = ip.split(',').trim();

  if (bannedIPs.has(ip)) {
    socket.emit('auth_error', 'お使いのIPアドレスは永続BANされています。');
    return socket.disconnect(true);
  }

  socket.on('register', ({ username, password, inviteCode }) => {
    if (!username || !password) return socket.emit('auth_error', '未入力の項目があります。');
    if (bannedUsers.has(username)) return socket.emit('auth_error', 'このアカウントはBANされています。');
    if (registeredUsers[username]) return socket.emit('auth_error', 'そのユーザー名は既に使われています。');

    let role = 'user';
    // 【セキュリティ確認】あなただけの秘密のコードに自由に変えてください！
    if (inviteCode === 'Aap@003kok25') role = 'admin';       
    if (inviteCode === '003kok25') role = 'moderator';    

    registeredUsers[username] = { password, role };
    socket.emit('auth_success', { message: '登録が完了しました！ログインしてください。' });
  });

  socket.on('login', ({ username, password }) => {
    if (bannedUsers.has(username)) return socket.emit('auth_error', 'このアカウントはBANされています。');

    const user = registeredUsers[username];
    if (!user || user.password !== password) return socket.emit('auth_error', 'ユーザー名またはパスワードが違います。');

    activeSockets[socket.id] = { username, role: user.role, ip };
    socket.username = username;
    socket.role = user.role;
    socket.room = 'ロビー';
    socket.join('ロビー');

    // 認証成功時に役職データなどを渡す
    socket.emit('login_ok', { username, role: user.role });
  });

  // チャット画面側から「入室準備完了」の合図を受け取った時の処理
  socket.on('chat_ready', ({ username, role }) => {
    activeSockets[socket.id] = { username, role, ip, room: 'ロビー' };
    socket.username = username;
    socket.role = role;
    socket.room = 'ロビー';
    socket.join('ロビー');
    
    io.to('ロビー').emit('chat', { name: 'システム', text: `${username}さんが入室しました`, role: 'system' });
    updateUserList();
  });

  socket.on('message', (data) => {
    const session = activeSockets[socket.id];
    if (!session) return;
    const messageText = typeof data === 'object' ? data.text : data;

    if (messageText.startsWith('/ip ')) {
      if (session.role !== 'admin') {
        return socket.emit('chat', { name: 'システム', text: 'エラー: IP確認コマンドは管理者専用です。', role: 'system' });
      }
      const targetName = messageText.replace('/ip ', '').trim();
      let targetIp = null;
      for (const sid in activeSockets) {
        if (activeSockets[sid].username === targetName) { targetIp = activeSockets[sid].ip; break; }
      }
      if (targetIp) {
        io.to(socket.room).emit('chat', { name: 'システム', text: `【IP情報】${targetName} さんのIPアドレスは [ ${targetIp} ] です。`, role: 'system' });
      } else {
        socket.emit('chat', { name: 'システム', text: `エラー: ${targetName} さんは見つかりません。`, role: 'system' });
      }
      return;
    }
    io.to(socket.room).emit('chat', { name: session.username, text: messageText, role: session.role });
  });

  socket.on('admin_action', ({ action, targetName }) => {
    const mySession = activeSockets[socket.id];
    if (!mySession) return;
    if (action === 'kick' && mySession.role !== 'admin' && mySession.role !== 'moderator') return;
    if ((action === 'ban' || action === 'ipban') && mySession.role !== 'admin') return;

    let targetSocketId = null;
    let targetIp = null;
    for (const sid in activeSockets) {
      if (activeSockets[sid].username === targetName) { targetSocketId = sid; targetIp = activeSockets[sid].ip; break; }
    }

    if (action === 'kick' && targetSocketId) {
      io.to(targetSocketId).emit('kick_notice', 'キックされました。');
      io.sockets.sockets.get(targetSocketId)?.disconnect(true);
    } else if (action === 'ban') {
      bannedUsers.add(targetName);
      if (targetSocketId) { io.to(targetSocketId).emit('kick_notice', 'アカウントがBANされました。'); io.sockets.sockets.get(targetSocketId)?.disconnect(true); }
    } else if (action === 'ipban' && targetIp) {
      bannedIPs.add(targetIp); bannedUsers.add(targetName);
      for (const sid in activeSockets) {
        if (activeSockets[sid].ip === targetIp) { io.to(sid).emit('kick_notice', 'IPアドレスがBANされました。'); io.sockets.sockets.get(sid)?.disconnect(true); }
      }
    }
  });

  socket.on('disconnect', () => {
    if (activeSockets[socket.id]) {
      delete activeSockets[socket.id];
      updateUserList();
    }
  });

  function updateUserList() {
    const list = Object.keys(activeSockets).map(sid => ({
      username: activeSockets[sid].username,
      role: activeSockets[sid].role,
      room: activeSockets[sid].room || 'ロビー',
      ip: activeSockets[sid].ip
    }));
    io.emit('user_list', list);
  }
});

server.listen(3000, () => console.log('Server running!'));
