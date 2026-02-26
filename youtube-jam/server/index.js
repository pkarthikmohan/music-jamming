const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
// const YouTube = require('youtube-sr').default; // Disabled due to instability
const ytSearch = require('yt-search');
const db = require('./db');
const youtubedl = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// --- Authentication & User Data ---

// Login/Sync User
app.post('/api/auth', (req, res) => {
    const { googleId, name, email, picture } = req.body;
    if (!googleId) return res.status(400).json({ error: "Missing googleId" });
    
    // Save or Update user info
    const user = db.saveUser(googleId, { name, email, picture });
    res.json(user);
});

// Get Likes
app.get('/api/user/:id/likes', (req, res) => {
    const { id } = req.params;
    const likes = db.getLikes(id);
    res.json(likes);
});

// Toggle Like
app.post('/api/user/:id/likes', (req, res) => {
    const { id } = req.params;
    const { video } = req.body; // { id, title, thumb }
    if (!video || !video.id) return res.status(400).json({ error: "Invalid video data" });

    const updatedLikes = db.toggleLike(id, video);
    if (!updatedLikes) return res.status(404).json({ error: "User not found" });
    
    res.json(updatedLikes);
});

// Proxy to Python Recommendation Engine
// In production (Render), set REC_SERVICE_URL env var to your Python service URL.
// Defaults to localhost:8000 for local development.
const REC_SERVICE_URL = process.env.REC_SERVICE_URL || 'http://localhost:8000';

app.post('/api/rec/recommend', async (req, res) => {
    try {
        // Forward the body (candidates, user_interactions) to the Python service
        // Fix: The Python usage in client calls `/recommend`, but the proxy was defined as `/rerank`
        // Consolidating everything to use `/recommend` based on what the client sends.
        // Actually, the client sends `/recommend` to the proxy endpoint? 
        // No, client uses `REC_ENGINE_URL + '/recommend'`.
        // REC_ENGINE_URL is `/api/rec`.
        // So client POSTs to `/api/rec/recommend`.
        // This server route was listening on `/api/rec/rerank`. That is a mismatch.
        
        // Changing this route to catch `/api/rec/recommend`
        // Sanitize base URL to prevent double slashes if env var has trailing slash
        const baseUrl = REC_SERVICE_URL.replace(/\/$/, '');
        console.log(`Forwarding recommendation request to: ${baseUrl}/recommend`);
        const response = await axios.post(`${baseUrl}/recommend`, req.body);
        res.json(response.data);
    } catch (err) {
        console.error("Rec Engine Error:", err.message);
        // Fallback: If Rec Engine is down, return empty or original list?
        // Returning 503 lets the client handle fallback.
        res.status(503).json({ error: "Recommendation Service Unavailable" });
    }
});
// ---------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const YOUTUBE_API_KEY = "AIzaSyAEVqWlEuPs5j5h8TjVG8X8BK4YOgD5e6E";
const rooms = {}; 

// Search Endpoint
app.get('/search', async (req, res) => {
    try {
        const { q } = req.query;
        console.log('Search request for:', q);
        
        let results = [];
        try {
            // Use yt-search (Scraper)
            const r = await ytSearch(q);
            if (r && r.videos.length > 0) {
                 results = r.videos.slice(0, 12).map(v => ({
                    id: v.videoId,
                    title: v.title,
                    thumb: v.thumbnail,
                    description: v.description,
                    channelTitle: v.author.name
                }));
            }
            console.log('Search results (yt-search):', results.length);
        } catch (err) {
            console.error('Search failed:', err.message);
            results = [];
        }
        
        // Filter out lofi fallback if it ever sneaks in
        results = results.filter(v => !v.title.toLowerCase().includes("lofi hip hop radio - beats to relax/study to"));
        
        res.json(results);
    } catch (err) {
        console.error('Search handler error:', err.message);
        res.status(500).json({ error: "Search failed", details: err.message });
    }
});

// Download Endpoint
app.get('/api/download', async (req, res) => {
    try {
        const { videoId, quality, startTime, endTime } = req.query;
        if (!videoId) return res.status(400).json({ error: "Missing videoId" });

        const url = `https://www.youtube.com/watch?v=${videoId}`;
        
        let format = 'bestvideo+bestaudio[ext=m4a]/bestvideo+bestaudio/best';
        if (quality === 'audio') {
            format = 'bestaudio[ext=m4a]/bestaudio/best';
        } else if (quality === '1080p') {
            format = 'bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
        } else if (quality === '720p') {
            format = 'bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
        } else if (quality === '480p') {
            format = 'bestvideo[height<=480]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]';
        }

        const tmpFile = path.join(os.tmpdir(), `download_${videoId}_${Date.now()}.${quality === 'audio' ? 'm4a' : 'mp4'}`);

        const args = {
            format: format,
            ffmpegLocation: ffmpegPath,
            output: tmpFile,
        };

        if (startTime || endTime) {
            const start = startTime || '00:00:00';
            const end = endTime || 'inf';
            // yt-dlp requires the format *start-end for download-sections
            args.downloadSections = `*${start}-${end}`;
            // Removed forceKeyframesAtCuts to prevent extremely slow re-encoding
        }

        if (quality !== 'audio') {
            args.mergeOutputFormat = 'mp4';
        }

        await youtubedl(url, args);

        const filename = quality === 'audio' ? `audio_${videoId}.m4a` : `video_${videoId}.mp4`;
        res.download(tmpFile, filename, (err) => {
            if (err) {
                console.error('Error sending file:', err);
            }
            fs.unlink(tmpFile, (unlinkErr) => {
                if (unlinkErr) console.error('Error deleting temp file:', unlinkErr);
            });
        });

    } catch (err) {
        console.error('Download error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "Download failed", details: err.message });
        }
    }
});

const fetchAndEmitRelated = async (videoId, socket) => {
    if (!videoId) return;
    try {
        const videoDetails = await ytSearch({ videoId: videoId });
        
        const isMusicOnly = (v) => {
            const t = v.title.toLowerCase();
            const blockList = [
                'tutorial', 'how to', 'lesson', 'course', 'review', 'reaction', 'gameplay', 
                'walkthrough', 'unboxing', 'coding', 'programming', 'setup', 'install', 
                'explained', 'lecture', 'news', 'update', 'trailer', 'vlog'
            ];
            if (blockList.some(k => t.includes(k))) return false;
            return true;
        };

        const titleRef = videoDetails ? videoDetails.title.replace(/\(.*\)|official video|lyrics/gi, '') : "";
        const query = `songs similar to ${titleRef}`;
        
        const r = await ytSearch(query);
        let results = [];
        if (r && r.videos.length > 0) {
             results = r.videos
                .filter(isMusicOnly)
                .slice(0, 15)
                .map(v => ({
                    id: v.videoId,
                    title: v.title,
                    thumb: v.thumbnail,
                    duration: v.timestamp,
                    channel: v.author.name
                }));
        }
        
        socket.emit('related-videos-result', results);
        socket.emit('related-videos', results);
    } catch (e) {
        console.error('fetchAndEmitRelated error:', e.message);
    }
};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('get-related', async (arg) => {
        try {
            // Handle both string and object inputs
            const videoId = typeof arg === 'object' ? arg.videoId : arg;
            if (!videoId) return;

            // Use yt-search for better reliability
            const videoDetails = await ytSearch({ videoId: videoId });
            let results = [];

             // Helper to filter out non-music content
            const isMusicOnly = (v) => {
                const t = v.title.toLowerCase();
                // Block Explicit Non-Music Types
                const blockList = [
                    'tutorial', 'how to', 'lesson', 'course', 'review', 'reaction', 'gameplay', 
                    'walkthrough', 'unboxing', 'coding', 'programming', 'setup', 'install', 
                    'explained', 'lecture', 'news', 'update', 'trailer', 'vlog'
                ];
                if (blockList.some(k => t.includes(k))) return false;
                return true;
            };
            
            // yt-search doesn't give "related" list directly in video details usually,
            // so we construct a search query.
            const titleRef = videoDetails ? videoDetails.title.replace(/\(.*\)|official video|lyrics/gi, '') : "";
            const query = `songs similar to ${titleRef}`;
            
            const r = await ytSearch(query);
            
            if (r && r.videos.length > 0) {
                 results = r.videos
                    .filter(isMusicOnly)
                    .slice(0, 15)
                    .map(v => ({
                        id: v.videoId,
                        title: v.title,
                        thumb: v.thumbnail,
                        duration: v.timestamp,
                        channel: v.author.name
                    }));
            }
            
            // Broadcast results
            socket.emit('related-videos-result', results);
            socket.emit('related-videos', results);

            // Also broadcast to room if applicable (legacy behavior support)
            // If the user joined a room, we could try to find it, but the client handles the received event.
            
        } catch (e) {
            console.error('Error in get-related:', e.message);
        }
    });

    socket.on('reorder-queue', ({ roomId, newQueue }) => {
        if(rooms[roomId]) {
            rooms[roomId].queue = newQueue;
            io.to(roomId).emit('update-queue', newQueue);
        }
    });



    socket.on('join-room', async ({ roomId, username }) => {
        socket.join(roomId);
        socket.username = username;
        socket.roomId = roomId;

        if (!rooms[roomId]) {
            rooms[roomId] = { 
                queue: [], 
                history: [],
                messages: [],
                forwardHistory: [],
                currentVideoId: null,
                isPlaying: false,
                videoTime: 0,
                lastUpdate: Date.now()
            };
        }

        // Get actual count of users in this room
        const sockets = await io.in(roomId).fetchSockets();
        const userCount = sockets.length;
        const users = sockets.map(s => s.username).filter(u => u);

        console.log(`${username} joined room ${roomId}. Count: ${userCount}`);
        
        io.to(roomId).emit('room-update', { 
            userCount, 
            users,
            message: `${username} joined the jam!` 
        });

        // Construct a sync payload with adjusted time so client doesn't need server clock
        const room = rooms[roomId];
        let syncPacket = { ...room };
        
        if (room.isPlaying) {
             const now = Date.now();
             const elapsed = (now - room.lastUpdate) / 1000;
             syncPacket.videoTime = (room.videoTime || 0) + elapsed;
             // We don't change lastUpdate here because the client should overwrite it 
             // with its local reception time to establish a valid anchor.
        }

        socket.emit('sync-state', syncPacket);
        
        // Initial suggestions
        fetchAndEmitRelated(rooms[roomId].currentVideoId, socket);
    });

    socket.on('video-action', ({ roomId, type, value }) => {
        const room = rooms[roomId];
        if (!room) return;

        console.log(`Action in ${roomId}: ${type} at ${value} by ${socket.username}`);

        // "Most Forward" Protection Logic
        if (type === 'play' && room.isPlaying) {
             const offset = (Date.now() - room.lastUpdate) / 1000;
             const serverTime = room.videoTime + offset;
             
             if (serverTime - value > 2.0) {
                 console.log(`IGNORED lagging play from ${socket.username}. Server: ${serverTime.toFixed(1)}s, Client: ${value.toFixed(1)}s`);
                 socket.emit('sync-state', room);
                 return; 
             }
        }

        // Leader Sync: If a client reports they are ahead of the server model, we accept it.
        // This lets the "Fastest Loader" drive the session forward.
        if (type === 'time-update') {
             if (room.isPlaying) {
                 const offset = (Date.now() - room.lastUpdate) / 1000;
                 const serverEstimatedTime = room.videoTime + offset;
                 
                 // If client is ahead by > 1.0s, update server to match (drag forward)
                 // BUT: If they are WAY ahead (> 4.0s), they likely missed a Seek-Back event.
                 // In that case, we REJECT their update and force them to sync.
                 if (value > serverEstimatedTime + 1.0) {
                     
                     if (value > serverEstimatedTime + 6.0) {
                          console.log(`Rejecting rogue future time-update from ${socket.username} (Value: ${value.toFixed(1)}, Server: ${serverEstimatedTime.toFixed(1)})`);
                          socket.emit('sync-state', room);
                          return;
                     }

                     // Update server state for small forward drifts (1-6s) usually caused by buffering catchups
                     rooms[roomId].videoTime = value;
                     rooms[roomId].lastUpdate = Date.now();
                     
                     // Broadcast silent update to everyone else so they realize they are behind
                     socket.to(roomId).emit('video-action', { type: 'time-update', value });
                     return; 
                 } else {
                     // Client is behind or on time.
                     return;
                 }
             } else {
                 // Room is paused, but client is sending time updates (rogue play state)
                 // Force them to stop.
                 console.log(`Client ${socket.username} sent time-update while room paused. Enforcing sync.`);
                 socket.emit('sync-state', room);
                 return;
             }
        }

        rooms[roomId].lastUpdate = Date.now();
        if (type === 'play') {
            rooms[roomId].isPlaying = true;
            rooms[roomId].videoTime = value;
        } else if (type === 'pause') {
            rooms[roomId].isPlaying = false;
            rooms[roomId].videoTime = value;
        } else if (type === 'seek') {
            rooms[roomId].videoTime = value;
        }
        
        socket.to(roomId).emit('video-action', { type, value });
    });

    socket.on('change-video', ({ roomId, videoId }) => {
        console.log(`Change video in ${roomId} to ${videoId}`);
        if (!rooms[roomId]) return;
        
        if (!rooms[roomId].history) rooms[roomId].history = [];
        rooms[roomId].history.push(rooms[roomId].currentVideoId);
        
        // Clear forward history because we started a new path
        rooms[roomId].forwardHistory = [];

        rooms[roomId].currentVideoId = videoId;
        rooms[roomId].videoTime = 0;
        rooms[roomId].isPlaying = true;
        rooms[roomId].lastUpdate = Date.now();
        
        // Broadcast full state update to ensure sync reset
        io.to(roomId).emit('sync-state', rooms[roomId]);
        // Also emit specific change event for UI reactions
        io.to(roomId).emit('change-video', videoId);
        
        // Trigger recommendations update for everyone in room
        // We'll let the client ask for it, or we could broadcast it here if we want to be proactive
    });

    socket.on('get-related', async ({ videoId }) => {
        fetchAndEmitRelated(videoId, socket);
    });

    socket.on('play-next', ({ roomId }) => {
        console.log(`Play next requested in ${roomId}`);
        const room = rooms[roomId];
        if (!room) return;

        // Check Forward History first (User hit "Back" previously)
        if (room.forwardHistory && room.forwardHistory.length > 0) {
            const nextId = room.forwardHistory.pop();

            if (!room.history) room.history = [];
            room.history.push(room.currentVideoId);
            
            room.currentVideoId = nextId;
            room.videoTime = 0;
            room.isPlaying = true;
            room.lastUpdate = Date.now();
            
            io.to(roomId).emit('sync-state', room);
            io.to(roomId).emit('change-video', nextId);
        
        } else if (room.queue.length > 0) {
            // Play queue
            const nextVideo = room.queue.shift();

            if (!room.history) room.history = [];
            room.history.push(room.currentVideoId);

            room.currentVideoId = nextVideo.id;
            room.videoTime = 0;
            room.isPlaying = true;
            room.lastUpdate = Date.now();
            
            io.to(roomId).emit('sync-state', room);
            io.to(roomId).emit('change-video', nextVideo.id);
        } else {
            socket.emit('queue-empty');
        }
    });

    socket.on('play-previous', ({ roomId }) => {
        console.log(`Play previous requested in ${roomId}`);
        const room = rooms[roomId];
        if (!room) return;

        if (room.history && room.history.length > 0) {
            const prevId = room.history.pop();
            
            // Save current state to forward history so "Next" goes back to it
            if (!room.forwardHistory) room.forwardHistory = [];
            room.forwardHistory.push(room.currentVideoId);
            
            room.currentVideoId = prevId;
            room.videoTime = 0;
            room.isPlaying = true;
            room.lastUpdate = Date.now();
            
            io.to(roomId).emit('sync-state', room);
            io.to(roomId).emit('change-video', prevId);
        }
    });

    socket.on('remove-from-queue', ({ roomId, index }) => {
        if (rooms[roomId] && rooms[roomId].queue) {
            rooms[roomId].queue.splice(index, 1);
            io.to(roomId).emit('update-queue', rooms[roomId].queue);
        }
    });

    socket.on('add-to-queue', ({ roomId, video }) => {
        if (!rooms[roomId]) {
             rooms[roomId] = { 
                queue: [], 
                history: [],
                messages: [],
                forwardHistory: [],
                currentVideoId: null,
                isPlaying: false,
                videoTime: 0,
                lastUpdate: Date.now()
            };
        }
        if (!rooms[roomId].queue) rooms[roomId].queue = [];
        rooms[roomId].queue.push(video);
        io.to(roomId).emit('update-queue', rooms[roomId].queue);
    });

    socket.on('send-message', ({ roomId, message, user }) => {
        const msgObj = { user, message, id: Date.now() };
        
        // Store message in room history (limit to last 50)
        if (rooms[roomId]) {
            if (!rooms[roomId].messages) rooms[roomId].messages = [];
            rooms[roomId].messages.push(msgObj);
            if (rooms[roomId].messages.length > 50) {
                rooms[roomId].messages.shift();
            }
        }
        
        io.to(roomId).emit('receive-message', msgObj);
    });

    socket.on('disconnect', async () => {
        console.log('User disconnected:', socket.id);
        if (socket.roomId) {
            const sockets = await io.in(socket.roomId).fetchSockets();
            const count = sockets.length;
            const users = sockets.map(s => s.username).filter(u => u);

            console.log(`Room ${socket.roomId} now has ${count} users`);
            io.to(socket.roomId).emit('room-update', { userCount: count, users });
        }
    });
});

// Serve static files from the React client
app.use(express.static(path.join(__dirname, '../client/dist')));

// Handle React routing, return all requests to React app
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
