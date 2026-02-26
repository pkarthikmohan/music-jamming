import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import YouTube from 'react-youtube';
import EmojiPicker from 'emoji-picker-react';
import { Search, ListMusic, MessageSquare, Send, Play, Pause, Users, LogIn, Plus as PlusIcon, SkipBack, SkipForward, Trash2, LogOut, Menu, X, UserCircle, Heart, Maximize, Smile, Image as ImageIcon, Link as LinkIcon, Check, LogOut as SignOutIcon, ChevronUp, Music } from 'lucide-react';
import axios from 'axios';
import { GoogleLogin, googleLogout } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { DndContext, closestCenter, KeyboardSensor, MouseSensor, PointerSensor, useSensor, useSensors, TouchSensor } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const socket = io();

// --- COMPONENTS FOR DRAG & DROP ---
function SortableItem(props) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.idString });
    
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 'auto',
        position: 'relative',
        touchAction: 'none', // Prevent scrolling while dragging
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
            {props.children}
        </div>
    );
}
// ----------------------------------

const REACTION_GIFS = [
    { url: "https://media.giphy.com/media/GeimqsH0TLDt4tScGw/giphy.gif", name: "Vibe Cat" },
    { url: "https://media.giphy.com/media/yr7n0u3qzO9nG/giphy.gif", name: "Fire" },
    { url: "https://media.giphy.com/media/blSTtZ4jSB01q/giphy.gif", name: "Dance" },
    { url: "https://media.giphy.com/media/l3q2u6MXJjekqyJqw/giphy.gif", name: "Applause" },
    { url: "https://media.giphy.com/media/OPU6wzx8JrHna/giphy.gif", name: "Cry" },
    { url: "https://media.giphy.com/media/gcemn4N9bB7DW/giphy.gif", name: "Cool" }
];

export default function JamRoom() {
    const [inRoom, setInRoom] = useState(false);
    const [roomId, setRoomId] = useState("");
    const [username, setUsername] = useState("");
    
    const [userCount, setUserCount] = useState(0);
    const [users, setUsers] = useState([]); // List of connected users
    const [showUserList, setShowUserList] = useState(false); // Toggle user list dropdown
    const [userProfile, setUserProfile] = useState(null); // { googleId, name, email, picture, likes: [] }
    const [likedSongs, setLikedSongs] = useState([]);
    const [showLikedSheet, setShowLikedSheet] = useState(false);
    
    const [searchQuery, setSearchQuery] = useState("");
    const [lowerSearchQuery, setLowerSearchQuery] = useState(""); // Independent search bar below
    const [viewMode, setViewMode] = useState("vibes"); // 'vibes' or 'results'
    const [searchResults, setSearchResults] = useState([]);
    const [queue, setQueue] = useState([]);
    const [relatedQueue, setRelatedQueue] = useState([]); // Auto-fetched recommendations
    const [suggestedVideos, setSuggestedVideos] = useState([]);
    const [messages, setMessages] = useState([]);
    const [inputMsg, setInputMsg] = useState("");
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [activeTab, setActiveTab] = useState('emoji');
    const [gifSearch, setGifSearch] = useState("");
    const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
    const [isAudioMode, setIsAudioMode] = useState(false);
    const [showStickyPlayer, setShowStickyPlayer] = useState(false);
    const [downloadVideoId, setDownloadVideoId] = useState(null);

    useEffect(() => {
        const handleMouseMove = (e) => {
            setMousePos({ x: e.clientX, y: e.clientY });
        };
        
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    useEffect(() => {
        const handleScroll = () => {
            if (videoContainerRef.current) {
                const rect = videoContainerRef.current.getBoundingClientRect();
                // If video bottom is above viewport top (scrolled past)
                setShowStickyPlayer(rect.bottom < 0);
            }
        };

        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);
    
    // DnD Sensors
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), // Mouse: Drag needs 8px movement, allowing clicks
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }), // Touch: Drag needs hold, allowing simple taps
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const handleDragEnd = (event) => {
        const { active, over } = event;
        if (active.id !== over.id) {
            setQueue((items) => {
                // Check if it's Mobile (mq-) or Desktop (dq-) based on ID prefix
                const prefix = active.id.startsWith('mq-') ? 'mq-' : 'dq-';
                
                // Reconstruct the IDs for the current items to find indices
                const currentIds = items.map((item, i) => `${prefix}${i}-${item.id}`);
                
                const oldIndex = currentIds.indexOf(active.id);
                const newIndex = currentIds.indexOf(over.id);
                
                if (oldIndex !== -1 && newIndex !== -1) {
                    const newQueue = arrayMove(items, oldIndex, newIndex);
                    // Emit reorder event
                    socket.emit('reorder-queue', { roomId, newQueue });
                    return newQueue;
                }
                return items;
            });
        }
    };

    const [gifResults, setGifResults] = useState([]);
    const [currentVideoId, setCurrentVideoId] = useState(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [progress, setProgress] = useState(0);
    const [duration, setDuration] = useState(0);
    const [currentTitle, setCurrentTitle] = useState("Loading...");
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isInvite, setIsInvite] = useState(false);
    const [mobileTab, setMobileTab] = useState('chat'); // 'chat' | 'queue' | 'vibes'
    const playerRef = useRef(null);

    // Swipe Handling
    const touchStart = useRef(null);
    const touchEnd = useRef(null);

    const onTouchStart = (e) => {
        touchEnd.current = null;
        touchStart.current = e.targetTouches[0].clientX;
    };

    const onTouchMove = (e) => {
        touchEnd.current = e.targetTouches[0].clientX;
    };

    const onTouchEnd = () => {
        if (!touchStart.current || !touchEnd.current) return;
        const distance = touchStart.current - touchEnd.current;
        const isLeftSwipe = distance > 50;
        const isRightSwipe = distance < -50;
        
        if (isLeftSwipe || isRightSwipe) {
            const tabs = ['vibes', 'chat', 'queue'];
            const currentIndex = tabs.indexOf(mobileTab);
            let newIndex = currentIndex;
            
            if (isLeftSwipe) {
                 newIndex = (currentIndex + 1) % tabs.length;
            } else {
                 newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
            }
            setMobileTab(tabs[newIndex]);
        }
    };
    
    const videoContainerRef = useRef(null);
    const serverStateRef = useRef(null);
    const isRemoteUpdate = useRef(false);
    const lastTimeRef = useRef(0);
    const chatContainerRef = useRef(null);
    const mobileChatRef = useRef(null);
    const drawerRef = useRef(null);
    const mobileDrawerRef = useRef(null);
    const userListRef = useRef(null);
    const likedSheetRef = useRef(null);

    const normalizeVideo = (video) => ({
        id: video.id,
        title: video.title || currentTitle || "Untitled",
        thumb: video.thumb || `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`
    });

    const persistLikedSongs = (songs) => {
        if (userProfile || sessionStorage.getItem('jam_user_profile')) {
            sessionStorage.setItem('jam_liked_songs', JSON.stringify(songs));
        }
    };

    // Click Outside Handler for Emoji Drawer & User List
    useEffect(() => {
        const handleClickOutside = (event) => {
            const clickedInsideMobile = mobileDrawerRef.current && mobileDrawerRef.current.contains(event.target);
            const clickedInsideDesktop = drawerRef.current && drawerRef.current.contains(event.target);
            
            if (!clickedInsideMobile && !clickedInsideDesktop && !event.target.closest('.drawer-toggle')) {
                setIsDrawerOpen(false);
            }
            if (userListRef.current && !userListRef.current.contains(event.target) && !event.target.closest('.user-list-toggle')) {
                setShowUserList(false);
            }
            if (likedSheetRef.current && !likedSheetRef.current.contains(event.target) && !event.target.closest('.liked-sheet-toggle')) {
                setShowLikedSheet(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
             document.removeEventListener('mousedown', handleClickOutside);
        };
    }, []);

    const getColor = (str) => {
        const colors = [
            '#FF9AA2', '#FFB7B2', '#FFDAC1', '#E2F0CB', '#B5EAD7', '#C7CEEA',
            '#F49AC2', '#CB99C9', '#C23B22', '#FFD1DC', '#DEA5A4', '#FF6961',
            '#77DD77', '#AEC6CF', '#F49AC2', '#03C03C', '#FDFD96', '#84b6f4'
        ];
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
    };

    const searchGifs = async (query) => {
        if (!query.trim()) {
            setGifResults([]);
            return;
        }
        try {
            // Switched to Tenor API (Reliable Public Key)
            const API_KEY = 'LIVDSRZULELA'; 
            const res = await axios.get(`https://g.tenor.com/v1/search?q=${query}&key=${API_KEY}&limit=20`);
            
            // Map Tenor result format to our app format
            const mapped = res.data.results.map(g => ({ 
                url: g.media[0].tinygif.url, 
                name: g.content_description || "GIF"
            }));
            setGifResults(mapped);
        } catch (e) {
            console.error("GIF Search Failed", e);
        }
    };

    const scrollToBottom = () => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
        if (mobileChatRef.current) {
            mobileChatRef.current.scrollTop = mobileChatRef.current.scrollHeight;
        }
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    // Restore session on refresh OR handle invite link
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const roomParam = params.get('room');

        if (roomParam) {
            setRoomId(roomParam);
            setIsInvite(true);
            // Pre-fill name if available
            const savedUser = sessionStorage.getItem('jam_username');
            const savedProfile = sessionStorage.getItem('jam_user_profile');
            if (savedUser) setUsername(savedUser);
            if (savedProfile) {
                try {
                    const p = JSON.parse(savedProfile);
                    // CRITICAL FIX: Check if profile is valid (has googleId). If not, clear it.
                    if (p && p.googleId) {
                        setUserProfile(p);
                        const savedLikes = sessionStorage.getItem('jam_liked_songs');
                        if (savedLikes) setLikedSongs(JSON.parse(savedLikes));
                        axios.get(`/api/user/${p.googleId}/likes`).then(r => {
                            setLikedSongs(r.data);
                            persistLikedSongs(r.data);
                        }).catch(console.error);
                    } else {
                        console.warn("Corrupted profile detected, clearing session.");
                        sessionStorage.removeItem('jam_user_profile');
                        sessionStorage.removeItem('jam_liked_songs');
                    }
                } catch (e) {
                    sessionStorage.removeItem('jam_user_profile');
                }
            }
        } else {
            const savedRoom = sessionStorage.getItem('jam_roomId');
            const savedUser = sessionStorage.getItem('jam_username');
            const savedProfile = sessionStorage.getItem('jam_user_profile');
            
            if (savedRoom && savedUser) {
                setRoomId(savedRoom);
                setUsername(savedUser);
                if (savedProfile) {
                     try {
                        const p = JSON.parse(savedProfile);
                        // CRITICAL FIX: Validation
                        if (p && p.googleId) {
                            setUserProfile(p);
                            const savedLikes = sessionStorage.getItem('jam_liked_songs');
                            if (savedLikes) setLikedSongs(JSON.parse(savedLikes));
                            axios.get(`/api/user/${p.googleId}/likes`).then(r => {
                                setLikedSongs(r.data);
                                persistLikedSongs(r.data);
                            }).catch(console.error);
                        } else {
                            console.warn("Corrupted profile detected, clearing session.");
                            sessionStorage.removeItem('jam_user_profile');
                            sessionStorage.removeItem('jam_liked_songs');
                        }
                     } catch (e) {
                         sessionStorage.removeItem('jam_user_profile');
                     }
                }
                socket.emit('join-room', { roomId: savedRoom, username: savedUser });
                setInRoom(true);
            }
        }
    }, []);
    
    // Polling for manual seek detection & Invisible Sync
    useEffect(() => {
        let tickCount = 0;
        const interval = setInterval(async () => {
             if (!playerRef.current || !inRoom) return;
             try {
                const player = playerRef.current.internalPlayer;
                const currentTime = await player.getCurrentTime();
                const totalDuration = await player.getDuration();
                
                setProgress(currentTime);
                setDuration(totalDuration);
                
                // Auto-play from queue logic
                if (totalDuration > 0 && Math.abs(totalDuration - currentTime) < 1 && isPlaying) {
                   // Video ending, check queue
                   if (queue.length > 0) {
                      // Player state change listener usually handles this on 'ended', 
                      // but having a failsafe here
                   } else if (relatedQueue.length > 0) {
                      // Auto-play related if queue empty?
                      // Wait for actual 'end' event.
                   }
                }

                // --- Heartbeat: Tell server where we are occassionally ---
                tickCount++;
                if (tickCount % 4 === 0 && isPlaying) { // Every 2s
                    socket.emit('video-action', { roomId, type: 'time-update', value: currentTime });
                }

                // --- 1. Detect Manual Seek ---
                const diff = currentTime - lastTimeRef.current;
                const isSeek = Math.abs(diff) > 1.5; // Threshold for manual jump

                if (isSeek) {
                    if (!isRemoteUpdate.current && Math.abs(currentTime - 0) > 1) { 
                         console.log('Seek detected:', diff);
                         socket.emit('video-action', { roomId, type: 'seek', value: currentTime });
                         
                         const state = await player.getPlayerState();
                         if (state === 1) { 
                             socket.emit('video-action', { roomId, type: 'play', value: currentTime });
                         }
                    }
                }
                lastTimeRef.current = currentTime;

                // --- 2. Invisible Sync Correction ---
                // Only run if we have a server state and we are supposed to be playing
                if (serverStateRef.current && serverStateRef.current.isPlaying) {
                     // Current Server Time = recorded time + elapsed since update
                     const timeByServer = serverStateRef.current.videoTime + (Date.now() - serverStateRef.current.lastUpdate) / 1000;
                     const drift = currentTime - timeByServer;
                     
                     // If drift is HUGE (> 2s), we forced a seek in socket.on('sync-state'), 
                     // but we should also check here just in case we drifted continually.
                     if (Math.abs(drift) > 2.5) {
                         console.log(`Major drift detected (${drift.toFixed(2)}s). Hard syncing...`);
                         isRemoteUpdate.current = true;
                         player.seekTo(timeByServer, true);
                         setTimeout(() => { isRemoteUpdate.current = false; }, 1000);
                     } 
                     // Small Drift Correction (0.1s to 2.5s)
                     else if (Math.abs(drift) > 0.15) {
                         // Aagressive catchup: 1.05x if behind, 0.95x if ahead
                         const targetRate = drift > 0 ? 0.95 : 1.05;
                         
                         const currentRate = await player.getPlaybackRate();
                         if (currentRate !== targetRate) {
                             console.log(`Micro-sync: Adjusting rate to ${targetRate} (Drift: ${drift.toFixed(3)}s)`);
                             player.setPlaybackRate(targetRate);
                         }
                     } else {
                         // We are insync (< 0.15s), restore normal speed
                         const currentRate = await player.getPlaybackRate();
                         if (currentRate !== 1) {
                             player.setPlaybackRate(1);
                         }
                     }
                } else if (serverStateRef.current && !serverStateRef.current.isPlaying) {
                    // FIX: Hard sync for PAUSED state
                    const state = await player.getPlayerState();
                    if (state === 1) { 
                         // If playing when we should be paused, STOP.
                         player.pauseVideo();
                    }
                    // If we drifted while paused (e.g. mobile "counting"), snap back.
                    if (Math.abs(currentTime - serverStateRef.current.videoTime) > 0.5) {
                         player.seekTo(serverStateRef.current.videoTime, true);
                    }
                }

            } catch (e) {
                // Ignore player errors
            }
        }, 500); 
        return () => clearInterval(interval);
    }, [inRoom, roomId, isPlaying]); // Added isPlaying dependency for heartbeat

    const handleGoogleSuccess = async (credentialResponse) => {
        try {
            const decoded = jwtDecode(credentialResponse.credential);
            console.log("Google User:", decoded);
            
            // Sync with backend
            const res = await axios.post('/api/auth', {
                googleId: decoded.sub,
                name: decoded.name,
                email: decoded.email,
                picture: decoded.picture
            });

            // Ensure googleId is part of the state and saved immediately
            const profileData = { ...res.data, googleId: decoded.sub };
            setUserProfile(profileData);
            setUsername(profileData.name);
            setLikedSongs(profileData.likes || []);
            
            // FIX: Persist immediately to prevent loss of googleId on refresh
            sessionStorage.setItem('jam_user_profile', JSON.stringify(profileData));
            sessionStorage.setItem('jam_username', profileData.name);
            if (profileData.likes) {
                sessionStorage.setItem('jam_liked_songs', JSON.stringify(profileData.likes));
            }
            
        } catch (error) {
            console.error("Login Failed", error);
        }
    };

    // Join Room Logic
    const handleJoin = (e) => {
        e?.preventDefault();
        if (roomId && username) {
            sessionStorage.setItem('jam_roomId', roomId);
            sessionStorage.setItem('jam_username', username);
            if (userProfile) {
                sessionStorage.setItem('jam_user_profile', JSON.stringify(userProfile));
            }
            socket.emit('join-room', { roomId, username });
            setInRoom(true);
        }
    };

    // Toggle Like Song
    const handleLike = async (video) => {
        if (!userProfile) return alert("Please sign in to like songs");
        if (!userProfile.googleId) {
            // Fallback for weird edge cases
            alert("Session invalid. Please sign out and sign in again.");
            return;
        }
        
        const normalized = normalizeVideo(video);
        const alreadyLiked = likedSongs.some(s => s.id === normalized.id);
        const optimistic = alreadyLiked 
            ? likedSongs.filter(s => s.id !== normalized.id) 
            : [...likedSongs, normalized];

        setLikedSongs(optimistic);
        persistLikedSongs(optimistic);

        try {
             const res = await axios.post(`/api/user/${userProfile.googleId}/likes`, { video: normalized, action: alreadyLiked ? 'remove' : 'add' });
             if (res.data) {
                 setLikedSongs(res.data);
                 persistLikedSongs(res.data);
             }
        } catch (e) {
            console.error("Like failed", e);
            // revert optimistic update
            setLikedSongs(alreadyLiked ? [...likedSongs] : likedSongs.filter(s => s.id !== normalized.id));
            persistLikedSongs(alreadyLiked ? [...likedSongs] : likedSongs.filter(s => s.id !== normalized.id));
        }
    };

    useEffect(() => {
        if (!inRoom) return;

        console.log('Setting up socket listeners...');

        // Verify we are joined on reconnect
        socket.on('connect', () => {
            console.log('Reconnected to server');
            if (roomId && username) {
                socket.emit('join-room', { roomId, username });
            }
        });

        socket.on('room-update', (data) => {
            console.log('Room update:', data);
            setUserCount(data.userCount);
            if (data.users) setUsers(data.users);
            if (data.message) {
                setMessages(prev => [...prev, { user: 'System', message: data.message, id: Date.now() }]);
            }
        });
        
        socket.on('receive-message', (msg) => setMessages(prev => [...prev, msg]));
        socket.on('update-queue', (newQueue) => setQueue(newQueue));
        socket.on('change-video', (vidId) => {
             setCurrentVideoId(vidId);
             // When video changes, fetch smart recommendations 
             // but don't clear search if user is actively searching? 
             // Requirement: "below you give the search results inplace of suggested vibes"
             // But logic is: if user searches, we show results. If user just plays, maybe reset to vibes?
             setViewMode('vibes'); 
             isRemoteUpdate.current = true; // prevent loop
             
             // Fetch smart queue
             socket.emit('get-related', vidId);
        });

        socket.on('related-videos-result', (videos) => {
             setRelatedQueue(videos);
             // Also populate suggested Vibes for the vibes tab
             setSuggestedVideos(videos.slice(0, 3));
        });

        socket.on('video-action', ({ type, value }) => {
            if (type === 'time-update') {
                 // Silent update: Update our model of "Truth" so our local sync loop can react
                 if (serverStateRef.current) {
                     serverStateRef.current.videoTime = value;
                     serverStateRef.current.lastUpdate = Date.now();
                 }
                 return; // Do nothing else, let the loop handle it
            }

            isRemoteUpdate.current = true;
            lastTimeRef.current = value; // Prevent echo
            // Fix: Only set playing=true if explicit 'play' event. 'seek' should respect current state.
            const playing = (type === 'play') ? true : (type === 'pause' ? false : serverStateRef.current?.isPlaying);
            setIsPlaying(playing);

            if (serverStateRef.current) {
                serverStateRef.current.videoTime = value;
                serverStateRef.current.isPlaying = playing;
                serverStateRef.current.lastUpdate = Date.now();
            }
            
            // Sync local progress bar
            setProgress(value);

            const player = playerRef.current?.internalPlayer;
            if (type === 'play') {
                    // Always seek if difference is significant, just to be sure
                    const time = value;
                    player?.getCurrentTime().then(curr => {
                        // Increase threshold to 2.0s to avoid buffering lag on Play
                        // This allows the video to start immediately even if slightly off, 
                        // letting the micro-sync loop catch up later.
                        if (Math.abs(curr - time) > 2.0) {
                            player.seekTo(time);
                        }
                        player.playVideo();
                    });
            }
            if (type === 'pause') {
                player?.seekTo(value);
                player?.pauseVideo();
            }
            if (type === 'seek') {
                 // Ensure we just seek and STAY paused if we were paused
                 player?.seekTo(value, true);
                 
                 // CRITICAL FIX: Explicitly pause if server says we are paused.
                 // This prevents the "resume after seek" behavior some players have.
                 if (!serverStateRef.current?.isPlaying) {
                     player?.pauseVideo();
                 } else {
                     player?.playVideo();
                 }
            }
            setTimeout(() => { isRemoteUpdate.current = false; }, 1000); // Debounce remote actions
        });
        
        socket.on('sync-state', (state) => {
            setQueue(state.queue || []);
            if (state.messages) setMessages(state.messages);
            setCurrentVideoId(state.currentVideoId);
            setIsPlaying(state.isPlaying);
            if (state.videoTime) setProgress(state.videoTime);
            
            // CRITICAL: Anchor server state to LOCAL time to avoid clock drift issues
            serverStateRef.current = {
                ...state,
                lastUpdate: Date.now() 
            };

            // FORCE SYNC: If the player is active, ensure we align with the server
            // mainly for mobile (reconnects) or late joiners where onReady fired before sync
            const player = playerRef.current?.internalPlayer;
            if (player && state) {
                if (state.isPlaying) {
                     // Since server already adjusted videoTime to "Now" in syncPacket, 
                     // we don't need to add (Date.now() - lastUpdate) again.
                     // Just align to the received time.
                     const targetTime = state.videoTime || 0;
                     
                     player.getCurrentTime().then(curr => {
                         // If we are drifting by more than 2 seconds (common in mobile background throttles)
                         // OR if we are seemingly behind due to double-counting bug fixed above
                         if (Math.abs(curr - targetTime) > 2.0) {
                             console.log(`Force Sync: Jumping from ${curr} to ${targetTime}`);
                             player.seekTo(targetTime, true);
                             player.playVideo();
                         } else {
                             // Even if times are close, ensure we are playing if server says playing
                             if (player.getPlayerState && typeof player.getPlayerState === 'function') {
                                 player.getPlayerState().then(status => {
                                     // 2 = Paused, 1 = Playing
                                     if (status !== 1) player.playVideo();
                                 });
                             }
                         }
                     });
                } else {
                    // Server is paused
                    if (state.videoTime) {
                        player.seekTo(state.videoTime, true);
                        player.pauseVideo();
                    }
                }
            }
        });

        socket.on('related-videos', (videos) => {
            console.log('Received related videos:', videos.length);
            setSuggestedVideos(videos);
            setRelatedQueue(videos);
        });

        return () => {
            socket.off('room-update');
            socket.off('receive-message');
            socket.off('update-queue');
            socket.off('video-action');
            socket.off('sync-state');
            socket.off('change-video');
            socket.off('related-videos');
        };
    }, [inRoom]);

    // Fetch recommendations when video changes
    useEffect(() => {
        if (inRoom && currentVideoId) {
            console.log('Requesting related for:', currentVideoId);
            socket.emit('get-related', { videoId: currentVideoId });
        }
    }, [currentVideoId, inRoom]);

    // Real Search Logic
    const handleSearch = async (query) => {
        const q = typeof query === 'string' ? query : searchQuery;
        if (!q || !q.trim()) return;
        try {
            console.log('Searching for:', q);
            const res = await axios.get('/search', { params: { q: q } });
            console.log('Search response:', res.data);
            setSearchResults(res.data);
            setViewMode('results'); // Switch view mode to results
            setMobileTab('vibes'); // Force mobile tab to 'vibes' to see results
        } catch (error) {
            console.error('Search failed:', error);
        }
    };

    // --- Recommendation Engine Integration ---
    // Use relative path so requests go through Node server proxy
    const REC_ENGINE_URL = "/api/rec";

    const performSmartSort = async (candidates) => {
        if (!candidates || candidates.length === 0) return [];
        
        // Construct User Interactions from Liked Songs
        const interactions = likedSongs.map(s => ({
            video_id: s.id,
            interaction_type: 'like',
            timestamp: new Date().toISOString(),
            channel_title: s.channelTitle || "", 
            video_title: s.title
        }));

        const formattedCandidates = candidates.map(s => ({
            id: s.id,
            title: s.title,
            description: s.description || "",
            thumbnail_url: s.thumb || s.thumbnail_url, // Handle both formats if mixed
            channel_title: s.channelTitle || ""
        }));

        try {
            const res = await axios.post(`${REC_ENGINE_URL}/recommend`, {
                user_id: userProfile?.googleId || "guest",
                candidate_videos: formattedCandidates,
                user_interactions: interactions
            });
            
            // Map back to frontend format
            return res.data.map(v => ({
                id: v.id,
                title: v.title,
                thumb: v.thumbnail_url,
                description: v.description,
                channelTitle: v.channel_title
            }));
        } catch (e) {
            console.error("Smart Sort failed", e);
            alert("AI Engine offline or error.");
            return null; // Return null to indicate failure
        }
    };

    const handleSearchSort = async () => {
        const sorted = await performSmartSort(searchResults);
        if (sorted && sorted.length > 0) {
            setSearchResults(sorted);
            alert("✨ Search results re-ranked!");
        }
    };

    const handleVibesSort = async () => {
        const sorted = await performSmartSort(suggestedVideos);
        if (sorted && sorted.length > 0) {
            setSuggestedVideos(sorted);
            alert("✨ Vibes re-ranked!");
        }
    };

    const handleQueueSort = async () => {
        // We only sort the 'Recommended Next' (relatedQueue) locally
        const sorted = await performSmartSort(relatedQueue);
        if (sorted.length > 0) {
            setRelatedQueue(sorted);
            alert("✨ Recommendations re-ranked!");
        }
    };
    // -----------------------------------------

    const playRelated = (video) => {
        // When clicking a related video (from vibes or queue suggestion)
        playNow(video.id);
    };

    const sendMessage = () => {
        if (!inputMsg.trim()) return;
        socket.emit('send-message', { roomId, message: inputMsg, user: username });
        setInputMsg("");
    };

    const addToQueue = (vidId, title, e) => {
        e?.stopPropagation();
        socket.emit('add-to-queue', { roomId, video: { id: vidId, title } });
        // Don't close search results, let them keep searching/adding
        console.log(`Added "${title}" to queue`);
    };

    const playNow = (vidId) => {
        // UNLOCK SYNC
        isRemoteUpdate.current = false;
        socket.emit('change-video', { roomId, videoId: vidId });
        // setSearchResults([]); // User requested to keep search results visible
        // setSearchQuery("");
    };

    const handlePrevious = () => {
        socket.emit('play-previous', { roomId });
    };

    const handleNext = () => {
         // Optimistically we try, server logic handles empty queue/forward history
         socket.emit('play-next', { roomId });
    };
    const handleTogglePlay = async () => {
        const player = playerRef.current?.internalPlayer;
        if (!player) return;
        
        // UNLOCK SYNC: User interaction overrides remote lock
        isRemoteUpdate.current = false;

        // Robust Toggle: Check actual player state
        // 1 = Playing, 2 = Paused, 5 = Cued, -1 = Unstarted, 3 = Buffering
        try {
            const state = await player.getPlayerState();
            if (state === 1) {
                 player.pauseVideo();
                 // Optimistic update handled in onPause
            } else {
                 player.playVideo();
                 // Optimistic update handled in onPlay
            }
        } catch(e) {
            console.error("Player toggle error:", e);
            // Fallback to state check
            if (isPlaying) player.pauseVideo(); else player.playVideo();
        }
    };

    const handleSeekChange = (e) => {
        const time = parseFloat(e.target.value);
        setProgress(time);
        
        // UNLOCK SYNC: User interaction overrides remote lock
        isRemoteUpdate.current = false;

        // CRITICAL FIX: Update local refs IMMEDIATELY so the "Invisible Sync" loop 
        // doesn't think we are drifting and snap us back to the old time.
        lastTimeRef.current = time;
        if (serverStateRef.current) {
            serverStateRef.current.videoTime = time;
            serverStateRef.current.lastUpdate = Date.now();
            if (isPlaying) serverStateRef.current.isPlaying = true;
        }

        playerRef.current?.internalPlayer.seekTo(time, true);
        
        // Emit seek event
        socket.emit('video-action', { roomId, type: 'seek', value: time });
         
         if (isPlaying) {
             socket.emit('video-action', { roomId, type: 'play', value: time });
         }
    };

    const formatTime = (seconds) => {
        if (!seconds) return "00:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    };

    const toggleFullscreen = () => {
        if (!videoContainerRef.current) return;
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            videoContainerRef.current.requestFullscreen();
        }
    };

    const handleLeave = () => {
        sessionStorage.removeItem('jam_roomId');
        sessionStorage.removeItem('jam_username');
        // Hard reload to clean state
        window.location.reload();
    };
    
    const removeFromQueue = (e, index) => {
        e.stopPropagation();
        socket.emit('remove-from-queue', { roomId, index });
    };

    // Landing Page (Entry Screen)
    if (!inRoom) {
        return (
            <div className="min-h-screen bg-[#0a0a0c] flex items-center justify-center p-6 relative overflow-hidden">
                <div className="bg-white/5 border border-white/10 p-8 rounded-[2.5rem] w-full max-w-md backdrop-blur-xl relative z-10">
                    <div className="text-center mb-6">
                        <div className="w-16 h-16 bg-gradient-to-tr from-purple-600 to-pink-500 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-500/20 mx-auto mb-4">
                            <Play fill="white" size={32} />
                        </div>
                        <h1 className="text-3xl font-black tracking-tighter text-white">JAM.<span className="text-purple-500">LIVE</span></h1>
                        <p className="text-gray-400 text-sm mt-2">Watch YouTube together in sync</p>
                    </div>

                    {!userProfile ? (
                         <div className="mb-6">
                            <div className="flex justify-center">
                                <GoogleLogin
                                    onSuccess={handleGoogleSuccess}
                                    onError={() => console.log('Login Failed')}
                                    theme="filled_black"
                                    text="continue_with"
                                    shape="pill"
                                />
                            </div>
                            <div className="relative my-6">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-white/10"></div>
                                </div>
                                <div className="relative flex justify-center text-xs uppercase">
                                    <span className="bg-black/40 px-2 text-gray-500 rounded backdrop-blur-md">Or continue as guest</span> 
                                </div>
                            </div>
                         </div>
                    ) : (
                         <div className="mb-6 p-4 bg-white/5 rounded-2xl border border-white/10 flex items-center gap-3">
                            <img src={userProfile.picture} alt={userProfile.name} className="w-10 h-10 rounded-full border border-white/20"/>
                            <div className="flex-1 min-w-0">
                                <p className="text-xs text-gray-400 font-medium">Logged in as</p>
                                <p className="text-white font-bold truncate">{userProfile.name}</p>
                            </div>
                            <button 
                                onClick={() => {
                                    googleLogout();
                                    setUserProfile(null);
                                    setUsername("");
                                    setLikedSongs([]);
                                    sessionStorage.removeItem('jam_liked_songs');
                                }}
                                className="p-2 hover:bg-white/10 rounded-full transition text-gray-400 hover:text-white"
                                title="Sign Out"
                            >
                                <LogOut size={16} />
                            </button>
                        </div>
                    )}

                    <form onSubmit={handleJoin} className="space-y-4">
                        <input 
                            required 
                            className={`w-full bg-white/10 border border-white/20 rounded-2xl py-4 px-6 outline-none focus:ring-2 ring-purple-500 transition text-white placeholder-gray-400 font-medium ${userProfile ? 'opacity-50 cursor-not-allowed text-gray-400' : ''}`} 
                            placeholder="Your Name" 
                            value={username}
                            onChange={e => setUsername(e.target.value)} 
                            disabled={!!userProfile}
                        />
                        <input 
                            required 
                            className={`w-full bg-white/10 border border-white/20 rounded-2xl py-4 px-6 outline-none focus:ring-2 ring-purple-500 transition text-white placeholder-gray-400 font-medium ${isInvite ? 'opacity-50 cursor-not-allowed' : ''}`}
                            placeholder="Room ID (e.g. ChillVibes)" 
                            value={roomId}
                            onChange={e => !isInvite && setRoomId(e.target.value)}
                            readOnly={isInvite}
                        />
                        <button 
                            type="submit" 
                            className="w-full bg-purple-600 hover:bg-purple-500 py-4 rounded-2xl font-bold transition flex items-center justify-center gap-2 shadow-lg shadow-purple-600/20"
                        >
                            <LogIn size={20} /> {userProfile ? 'Join as ' + userProfile.name.split(' ')[0] : 'Join Jam'}
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    // Main App UI
    return (
        <div className="min-h-screen bg-[#0f0f13] text-gray-100 p-4 md:p-8 font-sans relative">
            {/* Mouse Hover Glow (Desktop Only) */}
            <div 
                className="hidden lg:block pointer-events-none fixed inset-0 z-0 transition-opacity duration-300"
                style={{
                    background: `radial-gradient(800px circle at ${mousePos.x}px ${mousePos.y}px, rgba(147, 51, 234, 0.25), transparent 80%)`
                }}
            />

            {/* Sidebar Menu Overlay */}
            <div 
                className={`fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${isMenuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => setIsMenuOpen(false)}
            />

            {/* Sidebar Slide-in Panel */}
            <div className={`fixed left-0 top-0 h-full w-80 bg-[#121216] border-r border-white/10 z-[60] transform transition-transform duration-300 ease-in-out shadow-2xl p-6 flex flex-col ${isMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
                <div className="flex items-center justify-between mb-10">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gradient-to-tr from-purple-600 to-pink-500 rounded-xl flex items-center justify-center">
                            <Play fill="white" size={20} />
                        </div>
                        <h1 className="text-xl font-black tracking-tighter">JAM.<span className="text-purple-500">LIVE</span></h1>
                    </div>
                    <button onClick={() => setIsMenuOpen(false)} className="p-2 hover:bg-white/10 rounded-full transition">
                        <X size={20} />
                    </button>
                </div>

                <div className="flex items-center gap-4 mb-8 p-4 bg-white/5 rounded-2xl border border-white/5">
                    {userProfile ? (
                        <img src={userProfile.picture} className="w-12 h-12 rounded-full border border-purple-500" alt={userProfile.name} />
                    ) : (
                        <div className="w-12 h-12 rounded-full bg-purple-600 flex items-center justify-center text-xl font-bold">
                            {username.charAt(0).toUpperCase()}
                        </div>
                    )}
                    <div className="min-w-0">
                        <p className="font-bold text-white truncate">{username}</p>
                        <p className="text-xs text-gray-500 truncate">In Room: {roomId}</p>
                    </div>
                </div>

                <nav className="space-y-2 flex-1">
                    <button 
                        onClick={() => userProfile ? alert(`Logged in as:\n${userProfile.name}\n${userProfile.email}`) : alert("Please sign in first.")}
                        className="w-full flex items-center gap-4 p-4 rounded-xl hover:bg-white/5 transition text-gray-300 hover:text-white group"
                    >
                        <UserCircle className="group-hover:text-purple-500 transition" />
                        <span className="font-medium">My Profile</span>
                    </button>
                    <button 
                        className="liked-sheet-toggle w-full flex items-center gap-4 p-4 rounded-xl hover:bg-white/5 transition text-gray-300 hover:text-white group"
                        onClick={() => {
                            if (userProfile) {
                                setShowLikedSheet(true);
                                setIsMenuOpen(false);
                            } else {
                                alert("Please sign in to view liked songs");
                            }
                        }}
                    >
                        <Heart className="group-hover:text-pink-500 transition" />
                        <span className="font-medium">Liked Songs</span>
                    </button>
                    <button 
                        onClick={() => alert("Saved Playlists coming soon!")}
                        className="w-full flex items-center gap-4 p-4 rounded-xl hover:bg-white/5 transition text-gray-300 hover:text-white group"
                    >
                        <ListMusic className="group-hover:text-blue-500 transition" />
                        <span className="font-medium">My Playlists</span>
                    </button>
                </nav>

                <div className="mt-auto pt-6 border-t border-white/10">
                     <button 
                         onClick={handleLeave}
                         className="w-full flex items-center gap-4 p-4 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 transition font-bold"
                    >
                        <LogOut size={20} /> Leave Room
                    </button>
                </div>
            </div>

            {/* Header */}
            <header className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
                <div className="flex items-center gap-3 w-full md:w-auto">
                    <button 
                        onClick={() => setIsMenuOpen(true)}
                        className="p-2 mr-2 hover:bg-white/10 rounded-lg transition"
                    >
                        <Menu size={24} />
                    </button>
                    <div className="w-10 h-10 bg-gradient-to-tr from-purple-600 to-pink-500 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/20">
                        <Play fill="white" size={20} />
                    </div>
                    <h1 className="text-2xl font-black tracking-tighter">JAM.<span className="text-purple-500">LIVE</span></h1>
                    
                    {/* Desktop Invite Link */}
                    <button 
                        onClick={(e) => {
                            const url = `${window.location.origin}?room=${roomId}`;
                            navigator.clipboard.writeText(url);
                            const el = e.currentTarget.querySelector('span');
                            if (el) {
                                el.innerText = "Link Copied!";
                                el.classList.add("text-green-400");
                                setTimeout(() => {
                                    el.innerText = `Room: ${roomId}`;
                                    el.classList.remove("text-green-400");
                                }, 2000);
                            }
                        }}
                        className="hidden md:flex items-center gap-2 bg-white/5 hover:bg-white/10 py-2 px-3 rounded-xl border border-white/5 hover:border-green-500/50 transition cursor-pointer group ml-2"
                        title="Copy Invite Link"
                    >
                        <span className="text-xs text-gray-500 group-hover:text-green-400 font-mono whitespace-nowrap transition-colors">Room: {roomId}</span>
                        <LinkIcon size={14} className="text-gray-600 group-hover:hidden transition-all" />
                        <div className="hidden group-hover:flex gap-0.5 items-end h-3 transition-all">
                            <div className="w-1 bg-green-500 rounded-full animate-dance" style={{ animationDelay: '0s' }}></div>
                            <div className="w-1 bg-green-500 rounded-full animate-dance" style={{ animationDelay: '0.1s' }}></div>
                            <div className="w-1 bg-green-500 rounded-full animate-dance" style={{ animationDelay: '0.2s' }}></div>
                        </div>
                    </button>

                    {/* Mobile Leave Button */}
                    <button 
                        onClick={handleLeave}
                        className="md:hidden ml-auto flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 px-3 py-2 rounded-xl border border-red-500/20 transition group"
                    >
                        <LogOut size={16} />
                        <span className="text-sm font-bold">Leave</span>
                    </button>
                </div>
                
                <div className="flex-1 max-w-2xl w-full relative group">
                    <Search className="absolute left-4 top-3 text-gray-500 group-focus-within:text-purple-500 transition" size={20} />
                    <input 
                        className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 px-12 focus:outline-none focus:ring-2 ring-purple-600/50 transition shadow-inner" 
                        placeholder="Search YouTube songs..." 
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    />
                    {searchQuery && (
                        <button 
                            onClick={handleSearch}
                            className="absolute right-3 top-2 px-3 py-1.5 bg-purple-600 rounded-lg hover:bg-purple-500 transition text-xs font-bold"
                        >
                            Search
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-2 justify-center w-full md:w-auto">
                    <button 
                        onClick={() => setShowUserList(!showUserList)}
                        className="user-list-toggle flex items-center gap-3 bg-white/5 px-4 py-2 rounded-2xl border border-white/10 hover:bg-white/10 transition cursor-pointer"
                    >
                        <Users size={16} className="text-purple-500" />
                        <span className="text-sm font-bold">{userCount} Listening</span>
                    </button>
                    
                    {/* Mobile Invite Link */}
                    <button 
                        onClick={(e) => {
                            const url = `${window.location.origin}?room=${roomId}`;
                            navigator.clipboard.writeText(url);
                            const el = e.currentTarget.querySelector('span');
                            if (el) {
                                el.innerText = "Link Copied!";
                                el.classList.add("text-green-400");
                                setTimeout(() => {
                                    el.innerText = `Room: ${roomId}`;
                                    el.classList.remove("text-green-400");
                                }, 2000);
                            }
                        }}
                        className="md:hidden flex items-center gap-2 bg-white/5 hover:bg-white/10 py-2 px-3 rounded-xl border border-white/5 hover:border-green-500/50 transition cursor-pointer group"
                        title="Copy Invite Link"
                    >
                        <span className="text-xs text-gray-500 group-hover:text-green-400 font-mono whitespace-nowrap transition-colors">Room: {roomId}</span>
                        <LinkIcon size={14} className="text-gray-600 group-hover:hidden transition-all" />
                        <div className="hidden group-hover:flex gap-0.5 items-end h-3 transition-all">
                            <div className="w-1 bg-green-500 rounded-full animate-dance" style={{ animationDelay: '0s' }}></div>
                            <div className="w-1 bg-green-500 rounded-full animate-dance" style={{ animationDelay: '0.1s' }}></div>
                            <div className="w-1 bg-green-500 rounded-full animate-dance" style={{ animationDelay: '0.2s' }}></div>
                        </div>
                    </button>

                    {/* Desktop Leave Button */}
                    <button 
                        onClick={handleLeave}
                        className="hidden md:flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 px-4 py-2 rounded-2xl border border-red-500/20 transition group"
                    >
                        <LogOut size={16} className="group-hover:-translate-x-1 transition-transform" />
                        <span className="text-sm font-bold">Leave</span>
                    </button>
                </div>
            </header>

            <main 
                className="max-w-7xl mx-auto grid grid-cols-12 gap-8"
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
            >
                {/* User List Dropdown */}
                {showUserList && (
                    <div 
                        ref={userListRef}
                        className="fixed top-24 right-4 z-50 w-72 bg-[#121216] border border-white/10 rounded-2xl shadow-2xl p-4 space-y-3 animate-fade-in"
                    >
                        <div className="flex items-center justify-between pb-2 border-b border-white/5">
                            <div className="flex items-center gap-2">
                                <Users className="text-purple-500" size={16} />
                                <h4 className="text-sm font-bold">Listeners ({users.length})</h4>
                            </div>
                            <button onClick={() => setShowUserList(false)} className="p-1 hover:text-white text-gray-400"><X size={14} /></button>
                        </div>
                        <div className="max-h-[300px] overflow-y-auto space-y-2 scrollbar-thin">
                            {users.map((u, i) => (
                                <div key={i} className="flex items-center gap-3 p-2 rounded-xl bg-white/5 hover:bg-white/10 transition group">
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500/20 to-blue-500/20 flex items-center justify-center border border-white/10">
                                        <UserCircle size={18} className="text-gray-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold text-gray-200 truncate">{u === username ? `${u} (You)` : u}</p>
                                        <p className="text-[10px] text-gray-500">Listening</p>
                                    </div>
                                    {u === username && <div className="w-2 h-2 rounded-full bg-green-500 shadow-lg shadow-green-500/50"></div>}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Liked Songs Sheet */}
                {showLikedSheet && userProfile && (
                    <div 
                        ref={likedSheetRef}
                        className="fixed top-24 right-4 z-50 w-80 bg-[#121216] border border-white/10 rounded-2xl shadow-2xl p-4 space-y-3 animate-fade-in"
                    >
                        <div className="flex items-center justify-between pb-2 border-b border-white/5">
                            <div className="flex items-center gap-2">
                                <Heart className="text-pink-500" size={16} />
                                <h4 className="text-sm font-bold">Liked Songs</h4>
                            </div>
                            <button onClick={() => setShowLikedSheet(false)} className="p-1 hover:text-white text-gray-400"><X size={14} /></button>
                        </div>
                        <div className="max-h-[320px] overflow-y-auto space-y-2 scrollbar-thin">
                            {likedSongs.length > 0 ? likedSongs.map((song, i) => (
                                <div 
                                    key={`${song.id}-${i}`} 
                                    className="flex items-center gap-3 p-2 rounded-xl bg-white/5 hover:bg-white/10 transition"
                                >
                                    <img src={song.thumb || `https://img.youtube.com/vi/${song.id}/default.jpg`} className="w-12 h-12 rounded-lg object-cover" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-semibold text-gray-200 truncate">{song.title}</p>
                                    </div>
                                    <button 
                                        onClick={() => playNow(song.id)}
                                        className="p-1.5 rounded-lg hover:bg-purple-600 text-white bg-purple-500/70 transition"
                                        title="Play"
                                    >
                                        <Play size={14} />
                                    </button>
                                    <button 
                                        onClick={(e) => addToQueue(song.id, song.title, e)}
                                        className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 transition"
                                        title="Add to Queue"
                                    >
                                        <PlusIcon size={14} />
                                    </button>
                                    <button 
                                        onClick={() => setDownloadVideoId(song.id)}
                                        className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition"
                                        title="Download"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                    </button>
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); handleLike(song); }}
                                        className="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-400 hover:text-red-500 transition ml-1"
                                        title="Remove from Liked"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            )) : (
                                <p className="text-xs text-gray-500 text-center py-4">No liked songs yet.</p>
                            )}
                        </div>
                    </div>
                )}

                {/* Search Results */}
                {searchResults.length > 0 && (
                    <div className="col-span-12">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-xl font-bold flex items-center gap-2">
                                <span className="w-2 h-6 bg-purple-500 rounded-full"></span> Search Results
                            </h2>
                            <div className="flex gap-4">
                                <button 
                                    onClick={handleSearchSort}
                                    className="text-sm text-purple-400 hover:text-purple-300 transition font-bold flex items-center gap-1"
                                >
                                    ✨ AI Sort
                                </button>
                                <button 
                                    onClick={() => { setSearchResults([]); setSearchQuery(""); }}
                                    className="text-sm text-gray-400 hover:text-white transition"
                                >
                                    Clear
                                </button>
                            </div>
                        </div>
                        {/* Modified to List Style as requested */}
                        <div className="flex flex-col gap-2 mb-8">
                            {searchResults.map((video) => (
                                <div 
                                    key={video.id} 
                                    onClick={() => { 
                                        playNow(video.id); 
                                        setSearchResults([]); 
                                        setSearchQuery("");
                                        setViewMode('vibes');
                                    }}
                                    className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer relative"
                                >
                                    <div className="w-16 h-10 rounded-lg overflow-hidden relative shrink-0">
                                        <img src={video.thumb} className="w-full h-full object-cover group-hover:scale-110 transition duration-500" alt={video.title} />
                                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                                            <Play fill="white" size={16} />
                                        </div>
                                    </div>
                                    
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium truncate text-gray-200 group-hover:text-purple-400 transition">{video.title}</p>
                                    </div>

                                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition justify-end">
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); setDownloadVideoId(video.id); }}
                                            className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition"
                                            title="Download Video"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                        </button>
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); handleLike(video); }}
                                            className={`p-1.5 rounded-lg transition ${likedSongs.some(s => s.id === video.id) ? 'text-pink-600' : 'text-gray-400 hover:text-pink-600'}`}
                                            title={likedSongs.some(s => s.id === video.id) ? "Unlike Song" : "Like Song"}
                                        >
                                           <Heart size={16} fill={likedSongs.some(s => s.id === video.id) ? "currentColor" : "none"} />
                                        </button>
                                        <button 
                                            onClick={(e) => addToQueue(video.id, video.title, e)}
                                            className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition"
                                            title="Add to Queue"
                                        >
                                           <PlusIcon size={16} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
            )}

            <div className="col-span-12 lg:col-span-8">
                    {/* Main Player Container */}
                    <div ref={videoContainerRef} className="rounded-[2rem] overflow-hidden border border-white/10 shadow-2xl bg-black aspect-video mb-8 ring-1 ring-white/5 relative group">
                        
                        {/* 1) Empty State */}
                        {!currentVideoId ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500 bg-white/5">
                                <ListMusic size={48} className="mb-4 opacity-50" />
                                <p className="text-lg">Search for a song or add to queue to start jamming!</p>
                            </div>
                        ) : (
                        /* 2) Combined Audio/Video State */
                        <>
                            {/* Audio Mode Animation Overlay */}
                            <div 
                                className={`absolute inset-0 flex flex-col items-center justify-center z-50 transition-all duration-500 ${isAudioMode ? 'opacity-100 pointer-events-auto visible' : 'opacity-0 pointer-events-none invisible'}`}
                                style={{ backgroundColor: '#09090b' }} // Explicit hex (zinc-950) to ensure darkness
                            >
                                <div className="flex items-end gap-1 mb-4 md:mb-6 h-10 md:h-16">
                                    {[...Array(8)].map((_, i) => (
                                        <div 
                                            key={i} 
                                            className="w-2 md:w-3 bg-purple-500 rounded-t-sm animate-pulse" 
                                            style={{ 
                                                height: '100%', 
                                                animationDuration: `${0.6 + i * 0.1}s`,
                                                animationDelay: `${i * 0.05}s`,
                                                opacity: 0.8
                                            }} 
                                        />
                                    ))}
                                </div>
                                <img 
                                    src={`https://img.youtube.com/vi/${currentVideoId}/mqdefault.jpg`} 
                                    className={`w-24 h-24 md:w-32 md:h-32 rounded-full object-cover border-4 border-white/10 shadow-2xl shrink-0 ${isPlaying ? 'animate-[spin_10s_linear_infinite]' : ''}`}
                                    alt="vinyl"
                                />
                                <p className="mt-4 md:mt-6 text-gray-400 font-mono text-xs md:text-sm tracking-widest uppercase">Audio Mode</p>
                            </div>

                            {/* Video Overlays - Only visible in Video Mode */}
                            <div className={`absolute inset-0 z-40 pointer-events-none ${isAudioMode ? 'hidden' : ''}`}>
                                <div className="absolute top-0 left-0 right-0 p-6 bg-gradient-to-b from-black/80 to-transparent flex justify-between items-start opacity-0 group-hover:opacity-100 transition duration-300 pointer-events-auto">
                                    <h3 className="text-white font-bold text-lg line-clamp-1 flex-1 pr-4 drop-shadow-md">{currentTitle}</h3>
                                    <div className="flex gap-2">
                                    <button onClick={toggleFullscreen} className="p-2 hover:bg-white/20 rounded-full transition text-white">
                                        <Maximize size={24} />
                                    </button>
                                    </div>
                                </div>
                                {/* Blocker for Watch Later / Share */}
                                <div className="absolute top-0 right-0 w-32 h-24 pointer-events-auto" />
                            </div>

                            {/* Main YouTube Player */}
                            <div className={`absolute inset-0 z-0 transition-opacity duration-500 ${isAudioMode ? 'opacity-0 invisible' : 'opacity-100 visible'}`}>
                                <YouTube 
                                    key={currentVideoId}
                                    videoId={currentVideoId} 
                                    className="w-full h-full"
                                    iframeClassName="w-full h-full"
                                    ref={playerRef}
                                    onReady={(e) => {
                                    // Capture Title
                                    const data = e.target.getVideoData();
                                    if (data && data.title) setCurrentTitle(data.title);

                                    const state = serverStateRef.current;
                                    if (state) {
                                         // CRITICAL: Block emission during initial sync to prevent echo/reset loops
                                         isRemoteUpdate.current = true;
                                         
                                         if (state.isPlaying) {
                                             // Calculate real-time position based on server timestamp
                                             const timePassed = (Date.now() - state.lastUpdate) / 1000;
                                             const seekTime = (state.videoTime || 0) + timePassed;
                                             
                                             console.log(`Syncing joiner to ${seekTime}s (Offset: ${timePassed}s)`);
                                             e.target.seekTo(seekTime, true);
                                             e.target.playVideo();
                                         } else {
                                             e.target.seekTo(state.videoTime || 0, true);
                                             e.target.pauseVideo();
                                         }
    
                                         // Re-enable emitting after player settles (buffer can take time on mobile)
                                         setTimeout(() => { isRemoteUpdate.current = false; }, 2500);
                                    }
                                    // Initial duration set
                                    setDuration(e.target.getDuration());
                                }}
                                onPlay={async (e) => {
                                    const data = e.target.getVideoData();
                                    if (data && data.title) setCurrentTitle(data.title);

                                    setIsPlaying(true);
                                    setDuration(e.target.getDuration());

                                    // Immediate Sync Check on Play Start to fix "Buffering Lag"
                                    if (serverStateRef.current && serverStateRef.current.isPlaying) {
                                        const timeByServer = serverStateRef.current.videoTime + (Date.now() - serverStateRef.current.lastUpdate) / 1000;
                                        const drift = e.target.getCurrentTime() - timeByServer;
                                        if (Math.abs(drift) > 2.0) {
                                             console.log("Initial Play Sync: Hard Seeking to", timeByServer);
                                             isRemoteUpdate.current = true;
                                             e.target.seekTo(timeByServer, true);
                                             setTimeout(() => { isRemoteUpdate.current = false; }, 1000);
                                        }
                                    }

                                    if (!isRemoteUpdate.current) {
                                        // Optimistically update serverStateRef to prevent our own drift loop from fighting us
                                        if (serverStateRef.current) {
                                            serverStateRef.current.isPlaying = true;
                                            serverStateRef.current.videoTime = e.target.getCurrentTime();
                                            serverStateRef.current.lastUpdate = Date.now();
                                        }
                                        socket.emit('video-action', { roomId, type: 'play', value: e.target.getCurrentTime() });
                                    }
                                    // Enable Background Play logic
                                    if ('mediaSession' in navigator) {
                                        navigator.mediaSession.metadata = new MediaMetadata({
                                            title: data.title,
                                            artist: data.author,
                                            artwork: [{ src: `https://img.youtube.com/vi/${currentVideoId}/mqdefault.jpg` }]
                                        });
                                        navigator.mediaSession.setActionHandler('play', () => e.target.playVideo());
                                        navigator.mediaSession.setActionHandler('pause', () => e.target.pauseVideo());
                                        navigator.mediaSession.setActionHandler('previoustrack', handlePrevious);
                                        navigator.mediaSession.setActionHandler('nexttrack', handleNext);
                                    }
                                }}
                                onPause={(e) => {
                                    // This prevents one user's backgrounding from pausing the music for everyone.
                                    if (document.visibilityState === 'hidden') {
                                        console.log("Background auto-pause ignored");
                                        setIsPlaying(false);
                                        return;
                                    }
    
                                    setIsPlaying(false);
                                    if (!isRemoteUpdate.current) {
                                        // Optimistically update serverStateRef to STOP the ghost drag immediately
                                        if (serverStateRef.current) {
                                            serverStateRef.current.isPlaying = false;
                                            serverStateRef.current.videoTime = e.target.getCurrentTime();
                                            serverStateRef.current.lastUpdate = Date.now();
                                        }
                                        socket.emit('video-action', { roomId, type: 'pause', value: e.target.getCurrentTime() });
                                    }
                                }}
                                onEnd={() => {
                                    if (queue.length > 0) {
                                        socket.emit('play-next', { roomId });
                                    } else if (suggestedVideos.length > 0) {
                                        // Auto-play first suggestion if queue is empty
                                        playNow(suggestedVideos[0].id);
                                    }
                                }}
                                opts={{ 
                                    width: '100%', 
                                    height: '100%', 
                                    playerVars: { 
                                        autoplay: 0,        // DISABLED to allow onReady to control start time 
                                        playsinline: 1,
                                        controls: 0,        // Hide default controls (progress bar, etc)
                                        rel: 0,             // Minimize recommendations
                                        iv_load_policy: 3,  // Hide annotations
                                        disablekb: 1,       // Disable default keyboard shortcuts
                                        fs: 0               // Remove native fullscreen button
                                    } 
                                }} 
                            />
                            </div>
                        </>
                        )}
                    </div>

                    <div className="flex items-center justify-between px-4 mb-4 mt-2">
                        <div className="flex-1 min-w-0 mr-4">
                            <h2 className="text-xl font-bold truncate text-white leading-tight">{currentTitle}</h2>
                            <p className="text-sm font-medium text-gray-400">Now Playing</p>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setIsAudioMode(!isAudioMode)}
                                className={`p-3 rounded-full transition-all duration-300 ${isAudioMode ? 'bg-purple-500 text-white' : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10'}`}
                                title={isAudioMode ? "Show Video" : "Audio Only Mode"}
                            >
                                <Music size={24} />
                            </button>
                            <button 
                                onClick={() => setDownloadVideoId(currentVideoId)}
                                className="p-3 rounded-full transition-all duration-300 bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
                                title="Download Video"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            </button>
                            <button 
                                onClick={() => handleLike({ id: currentVideoId, title: currentTitle })}
                                className={`p-3 rounded-full transition-all duration-300 ${likedSongs.some(s => s.id === currentVideoId) ? 'bg-pink-500/20 text-pink-500 scale-110' : 'bg-white/5 text-gray-400 hover:text-white hover:bg-white/10'}`}
                            >
                                <Heart size={24} className={likedSongs.some(s => s.id === currentVideoId) ? "fill-current" : ""} />
                            </button>
                        </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="flex items-center gap-3 mb-6 px-4">
                        <span className="text-xs font-mono text-gray-400 min-w-[40px] text-right">{formatTime(progress)}</span>
                        <input 
                            type="range" 
                            min="0" 
                            max={duration || 100} 
                            value={progress} 
                            onChange={handleSeekChange}
                            style={{
                                backgroundSize: `${(progress / (duration || 100)) * 100}% 100%`,
                                backgroundImage: `linear-gradient(#a855f7, #a855f7)`
                            }}
                            className="flex-1 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer bg-no-repeat [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-4 [&::-webkit-slider-thumb]:border-purple-500 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-125 transition-all outline-none"
                        />
                        <span className="text-xs font-mono text-gray-400 min-w-[40px]">{formatTime(duration)}</span>
                    </div>

                    {/* Playback Controls */}
                    <div className="flex items-center justify-center gap-6 mb-8">
                        <button 
                            onClick={handlePrevious} 
                            className="group p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-all duration-300 hover:scale-110 active:scale-95 ring-1 ring-white/5 hover:ring-white/20"
                            title="Previous Song"
                        >
                            <SkipBack size={28} className="fill-white/20 group-hover:fill-white transition-all" />
                        </button>
                        
                        <button 
                            onClick={handleTogglePlay} 
                            className="p-5 bg-white rounded-full hover:bg-gray-200 text-black transition-all duration-300 hover:scale-110 active:scale-95 shadow-xl shadow-white/10 hover:shadow-white/30"
                            title={isPlaying ? "Pause" : "Play"}
                        >
                            {isPlaying ? <Pause size={32} fill="black" /> : <Play size={32} fill="black" className="ml-1" />}
                        </button>

                        <button 
                            onClick={handleNext} 
                            className="group p-3 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-all duration-300 hover:scale-110 active:scale-95 ring-1 ring-white/5 hover:ring-white/20"
                            title="Next Song"
                        >
                            <SkipForward size={28} className="fill-white/20 group-hover:fill-white transition-all" />
                        </button>

                    </div>

                    {/* Mobile Tabs */}
                    <div className="flex lg:hidden bg-white/5 rounded-xl p-1 mb-6 border border-white/5">
                        <button 
                            onClick={() => setMobileTab('vibes')}
                            className={`flex-1 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition ${mobileTab === 'vibes' ? 'bg-purple-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            <Play size={16} /> Vibes
                        </button>
                        <button 
                            onClick={() => setMobileTab('chat')}
                            className={`flex-1 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition ${mobileTab === 'chat' ? 'bg-purple-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            <MessageSquare size={16} /> Chat
                        </button>
                        <button 
                            onClick={() => setMobileTab('queue')}
                            className={`flex-1 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition ${mobileTab === 'queue' ? 'bg-purple-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            <ListMusic size={16} /> Playlist
                        </button>
                    </div>

                    {/* Mobile Carousel Viewport */}
                    <div className="block lg:hidden overflow-hidden w-full relative mb-6">
                       <div 
                          className="flex transition-transform duration-300 ease-in-out w-[300%]" 
                          style={{ transform: `translateX(-${['vibes', 'chat', 'queue'].indexOf(mobileTab) * (100/3)}%)` }}
                        >
                            {/* Slide 1: Content (Vibes or Results) */}
                            <div className="w-1/3 px-1 h-full min-h-[400px]">
                                {viewMode === 'results' ? (
                                    <>
                                        <div className="flex items-center justify-between mb-4">
                                            <h2 className="text-xl font-bold flex items-center gap-2 italic"><span className="w-2 h-6 bg-purple-500 rounded-full"></span> Results</h2>
                                            <button onClick={() => setViewMode('vibes')} className="text-xs text-gray-400 hover:text-white">Back to Suggestions</button>
                                        </div>
                                         <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-2 mb-4">
                                            <Search size={16} className="text-gray-500" />
                                            <input 
                                                className="flex-1 bg-transparent border-none py-2 focus:outline-none placeholder-gray-500 text-sm" 
                                                placeholder="Search more songs..." 
                                                value={lowerSearchQuery}
                                                onChange={e => setLowerSearchQuery(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && handleSearch(lowerSearchQuery)}
                                            />
                                        </div>
                                        <div className="flex flex-col gap-2 overflow-y-auto max-h-[300px]">
                                            {searchResults.map((video) => (
                                                <div 
                                                    key={video.id} 
                                                    onClick={() => playNow(video.id)}
                                                    className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer relative"
                                                >
                                                    <img src={video.thumb} className="w-12 h-12 rounded-lg object-cover shrink-0" alt={video.title} />
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-xs font-medium truncate text-gray-200">{video.title}</p>
                                                    </div>
                                                    
                                                    <button 
                                                        onClick={(e) => { e.stopPropagation(); handleLike(video); }}
                                                        className={`p-1.5 rounded-lg transition z-10 ${likedSongs.some(s => s.id === video.id) ? 'text-pink-500' : 'text-gray-600 hover:text-pink-500'}`}
                                                    >
                                                        <Heart size={14} fill={likedSongs.some(s => s.id === video.id) ? "currentColor" : "none"} />
                                                    </button>
                                                    <button 
                                                        onClick={(e) => addToQueue(video.id, video.title, e)}
                                                        className="p-1.5 rounded-lg text-gray-600 hover:text-white hover:bg-white/10 transition z-10"
                                                    >
                                                        <PlusIcon size={14} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex items-center justify-between mb-4">
                                            <h2 className="text-xl font-bold flex items-center gap-2 italic"><span className="w-2 h-6 bg-purple-500 rounded-full"></span> Suggested Vibes</h2>
                                            {suggestedVideos.length > 0 && (
                                                <button 
                                                    onClick={handleVibesSort}
                                                    className="text-xs text-purple-400 hover:text-purple-300 font-bold"
                                                >
                                                    ✨ AI Sort
                                                </button>
                                            )}
                                        </div>
                                        
                                        {/* Added Search Bar to Suggested Vibes View in Mobile */}
                                        <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-2 mb-4">
                                            <button onClick={() => handleSearch(lowerSearchQuery)}>
                                                <Search size={16} className="text-gray-500 hover:text-white transition" />
                                            </button>
                                            <input 
                                                className="flex-1 bg-transparent border-none py-2 focus:outline-none placeholder-gray-500 text-sm" 
                                                placeholder="Search song..." 
                                                value={lowerSearchQuery}
                                                onChange={e => setLowerSearchQuery(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && handleSearch(lowerSearchQuery)}
                                            />
                                        </div>

                                        <div className="flex flex-col gap-2 overflow-y-auto max-h-[400px]">
                                        {suggestedVideos.length > 0 ? suggestedVideos.slice(0, 10).map((vid, i) => (
                                             <div 
                                                key={i} 
                                                onClick={() => playRelated(vid)} 
                                                className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer relative"
                                            >
                                                <img src={vid.thumb} className="w-12 h-12 rounded-lg object-cover shrink-0" />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium truncate text-gray-200">{vid.title}</p>
                                                    <p className="text-[10px] text-gray-500 truncate">Suggested</p>
                                                </div>
                                                
                                                <button 
                                                    onClick={(e) => { 
                                                        e.stopPropagation(); 
                                                        setDownloadVideoId(vid.id);
                                                    }}
                                                    className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition"
                                                    title="Download"
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                </button>

                                                <button 
                                                    onClick={(e) => { 
                                                        e.stopPropagation(); 
                                                        handleLike(vid); 
                                                    }}
                                                    className={`p-2 rounded-lg transition ${likedSongs.some(s => s.id === vid.id) ? 'text-pink-500' : 'text-gray-400 hover:text-pink-500'}`}
                                                    title="Like"
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                >
                                                    <Heart size={16} fill={likedSongs.some(s => s.id === vid.id) ? "currentColor" : "none"} />
                                                </button>
                                                <button 
                                                    onClick={(e) => addToQueue(vid.id, vid.title, e)}
                                                    className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition"
                                                >
                                                    <PlusIcon size={16} />
                                                </button>
                                            </div>
                                        )) : (
                                            <p className="text-gray-500 col-span-2">{suggestedVideos.length === 0 && !currentVideoId ? "Play a song to get suggestions" : "Loading suggestions..."}</p>
                                        )}
                                        </div>
                                    </>
                                )}
                            </div>
                            
                            {/* Slide 2: Chat */}
                            <div className="w-1/3 px-1 h-full min-h-[400px]">
                                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-4 flex flex-col h-[400px] relative">
                                    <div className="flex items-center justify-between mb-4">
                                        <h3 className="font-bold flex items-center gap-2"><MessageSquare size={18} className="text-purple-500" /> Chat Room</h3>
                                    </div>
                                    <div ref={mobileChatRef} className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2 scrollbar-hide">
                                        {messages.map(m => (
                                            <div key={m.id} className="flex gap-3 hover:bg-white/5 p-2 rounded-xl transition group animate-fade-in">
                                                <img 
                                                    src={`https://api.dicebear.com/7.x/identicon/svg?seed=${m.user}`} 
                                                    className="w-8 h-8 rounded-full bg-black/20 shrink-0 border border-white/10" 
                                                    alt={m.user}
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-baseline gap-2 mb-0.5">
                                                        <span 
                                                            className="text-xs font-bold truncate" 
                                                            style={{ color: getColor(m.user) }}
                                                        >
                                                            {m.user}
                                                        </span>
                                                        <span className="text-[10px] text-gray-600 group-hover:text-gray-400 transition">
                                                            {new Date(m.id).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                                        </span>
                                                    </div>
                                                    {m.message.startsWith('AG_GIF::') ? (
                                                        <img src={m.message.replace('AG_GIF::', '')} className="rounded-lg max-w-[150px] mt-1 border border-white/10" alt="GIF" />
                                                    ) : (
                                                        <p className="text-sm text-gray-200 break-words leading-snug">{m.message}</p>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    
                                    {/* Mobile Emoji Drawer */}
                                    {isDrawerOpen && (
                                        <div ref={mobileDrawerRef} className="absolute bottom-16 left-2 right-2 z-50 bg-[#1e1e24] border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[320px]">
                                            {/* Tabs */}
                                            <div className="flex border-b border-white/10 shrink-0">
                                                <button 
                                                    className={`flex-1 p-3 text-sm font-bold transition flex items-center justify-center gap-2 ${activeTab === 'emoji' ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'}`}
                                                    onClick={() => setActiveTab('emoji')}
                                                >
                                                    <Smile size={16} /> Emojis
                                                </button>
                                                <button 
                                                    className={`flex-1 p-3 text-sm font-bold transition flex items-center justify-center gap-2 ${activeTab === 'gif' ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'}`}
                                                    onClick={() => setActiveTab('gif')}
                                                >
                                                    <ImageIcon size={16} /> GIFs
                                                </button>
                                            </div>
                                    
                                            {/* Content */}
                                            <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
                                                {activeTab === 'emoji' ? (
                                                     <EmojiPicker 
                                                        theme="dark"
                                                        width="100%"
                                                        height="100%"
                                                        searchDisabled
                                                        skinTonesDisabled
                                                        previewConfig={{ showPreview: false }}
                                                        onEmojiClick={(e) => {
                                                            setInputMsg(prev => prev + e.emoji);
                                                        }} 
                                                    />
                                                ) : (
                                                    <div className="flex flex-col h-full">
                                                        <div className="p-2 sticky top-0 bg-[#1e1e24] z-10">
                                                            <div className="flex items-center bg-white/5 rounded-lg border border-white/10 px-2">
                                                                <Search size={14} className="text-gray-400 shrink-0" />
                                                                <input 
                                                                    className="w-full bg-transparent border-none p-2 text-xs text-white placeholder-gray-500 focus:outline-none"
                                                                    placeholder="Search GIFs..."
                                                                    value={gifSearch}
                                                                    onChange={(e) => {
                                                                        setGifSearch(e.target.value);
                                                                        searchGifs(e.target.value);
                                                                    }}
                                                                />
                                                                {gifSearch && <button onClick={() => { setGifSearch(''); setGifResults([]); }}><X size={14} className="text-gray-400 hover:text-white shrink-0" /></button>}
                                                            </div>
                                                        </div>
                                                        <div className="columns-2 gap-2 p-2 pt-0 overflow-y-auto scrollbar-thin">
                                                             {(gifResults.length > 0 ? gifResults : REACTION_GIFS).map((g, i) => (
                                                                <button 
                                                                    key={i} 
                                                                    onClick={() => {
                                                                        socket.emit('send-message', { roomId, message: `AG_GIF::${g.url}`, user: username });
                                                                        setIsDrawerOpen(false);
                                                                    }}
                                                                    className="relative group w-full mb-2 rounded-lg overflow-hidden border border-white/5 hover:border-purple-500 transition break-inside-avoid"
                                                                >
                                                                    <img src={g.url} className="w-full h-auto object-cover" loading="lazy" />
                                                                    <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[10px] text-center py-1 opacity-0 group-hover:opacity-100 transition whitespace-nowrap overflow-hidden px-1">{g.name || 'GIF'}</span>
                                                                </button>
                                                             ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Mobile Input Group */}
                                    <div className="relative flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-2">
                                        <button 
                                            onClick={() => setIsDrawerOpen(!isDrawerOpen)}
                                            className={`drawer-toggle p-2 rounded-lg transition ${isDrawerOpen ? 'text-purple-400 bg-white/10' : 'text-gray-400 hover:text-purple-400'}`}
                                        >
                                            <Smile size={20} />
                                        </button>
                                        <input 
                                            value={inputMsg}
                                            onChange={(e) => setInputMsg(e.target.value)}
                                            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                                            className="flex-1 bg-transparent border-none py-3 px-2 focus:outline-none placeholder-gray-500 text-sm" 
                                            placeholder="Type a message..." 
                                        />
                                        <button onClick={sendMessage} className="p-2 bg-purple-600 rounded-lg hover:bg-purple-500 transition shadow-lg shadow-purple-600/20">
                                            <Send size={16} />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Slide 3: Queue */}
                            <div className="w-1/3 px-1 h-full min-h-[400px]">
                                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-6 flex flex-col h-[400px]">
                                    <h3 className="font-bold flex items-center gap-2 mb-4"><ListMusic size={18} className="text-purple-500" /> Up Next</h3>
                                    
                                    <DndContext 
                                        sensors={sensors} 
                                        collisionDetection={closestCenter} 
                                        onDragEnd={handleDragEnd}
                                    >
                                    <div className="flex-1 overflow-y-auto space-y-3 mb-4">
                                        <SortableContext items={queue.map((item, i) => `mq-${i}-${item.id}`)} strategy={verticalListSortingStrategy}>
                                            {queue.map((item, i) => (
                                                <SortableItem key={`mq-${i}-${item.id}`} idString={`mq-${i}-${item.id}`}>
                                                    <div 
                                                        onClick={() => playNow(item.id)}
                                                        className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer relative"
                                                    >
                                                        <img src={`https://img.youtube.com/vi/${item.id}/default.jpg`} className="w-12 h-12 rounded-lg object-cover" />
                                                        <p className="text-xs font-medium truncate flex-1">{item.title}</p>
                                                        <Play size={12} className="opacity-0 group-hover:opacity-100 text-purple-500" />
                                                
                                                        <button 
                                                            onClick={(e) => { 
                                                                e.stopPropagation(); 
                                                                setDownloadVideoId(item.id);
                                                            }}
                                                            className="p-1.5 rounded-lg hover:bg-white/10 text-gray-600 hover:text-white transition mr-1 z-10"
                                                            title="Download"
                                                            onMouseDown={(e) => e.stopPropagation()}
                                                            onTouchStart={(e) => e.stopPropagation()}
                                                        >
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                        </button>

                                                        <button 
                                                            onClick={(e) => { 
                                                                e.stopPropagation(); 
                                                                handleLike({ ...item, thumb: item.thumb || `https://img.youtube.com/vi/${item.id}/hqdefault.jpg` }); 
                                                            }}
                                                            className={`p-1.5 rounded-lg transition mr-1 z-10 ${likedSongs.some(s => s.id === item.id) ? 'text-pink-500' : 'text-gray-600 hover:text-pink-500'}`}
                                                            title="Like"
                                                            onMouseDown={(e) => e.stopPropagation()}
                                                            onTouchStart={(e) => e.stopPropagation()}
                                                        >
                                                            <Heart size={14} fill={likedSongs.some(s => s.id === item.id) ? "currentColor" : "none"} />
                                                        </button>

                                                        <button 
                                                            onClick={(e) => removeFromQueue(e, i)}
                                                            className="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-600 hover:text-red-500 transition ml-2 z-10"
                                                            title="Remove"
                                                            onMouseDown={(e) => e.stopPropagation()}
                                                            onTouchStart={(e) => e.stopPropagation()}
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                </SortableItem>
                                            ))}
                                        </SortableContext>

                                        {/* Auto-Queue Separator */}
                                        {relatedQueue.length > 0 && (
                                            <>
                                                <div className="border-t border-white/5 my-4 pt-2 flex items-center justify-between">
                                                    <p className="text-[10px] uppercase font-bold text-gray-500">Recommended Next</p>
                                                    <button 
                                                        onClick={(e) => { e.stopPropagation(); handleQueueSort(); }}
                                                        className="text-[10px] text-purple-400 hover:text-purple-300 font-bold flex items-center gap-1"
                                                    >
                                                        ✨ AI Sort
                                                    </button>
                                                </div>
                                                {relatedQueue.slice(0, 10).map((item, i) => (
                                                    <div 
                                                        key={`r-${i}`}
                                                        onClick={() => playRelated(item)}
                                                        className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer opacity-70 hover:opacity-100"
                                                    >
                                                        <img src={item.thumb || `https://img.youtube.com/vi/${item.id}/default.jpg`} className="w-10 h-10 rounded-lg object-cover grayscale group-hover:grayscale-0 transition" />
                                                        <p className="text-xs font-medium truncate flex-1 text-gray-400 group-hover:text-white transition">{item.title}</p>
                                                        <button 
                                                            onClick={(e) => { 
                                                                e.stopPropagation(); 
                                                                setDownloadVideoId(item.id);
                                                            }}
                                                            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition"
                                                            title="Download"
                                                            onPointerDown={(e) => e.stopPropagation()}
                                                        >
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                        </button>
                                                        <button 
                                                            onClick={(e) => { 
                                                                e.stopPropagation(); 
                                                                handleLike({ ...item, thumb: item.thumb || `https://img.youtube.com/vi/${item.id}/hqdefault.jpg` }); 
                                                            }}
                                                            className={`p-2 rounded-lg transition ${likedSongs.some(s => s.id === item.id) ? 'text-pink-500' : 'text-gray-400 hover:text-pink-500'}`}
                                                            title="Like"
                                                            onPointerDown={(e) => e.stopPropagation()}
                                                        >
                                                            <Heart size={16} fill={likedSongs.some(s => s.id === item.id) ? "currentColor" : "none"} />
                                                        </button>
                                                    </div>
                                                ))}
                                            </>
                                        )}

                                        {queue.length === 0 && relatedQueue.length === 0 && <p className="text-center text-xs text-gray-500 mt-10">Queue is empty... <br/>Add some songs!</p>}
                                    </div>
                                    </DndContext>
                                </div>
                            </div>

                       </div>
                    </div>

                    {/* Suggested Vibes (Desktop: Always Visible) */}
                    <div className="hidden lg:block">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-xl font-bold flex items-center gap-2 italic">
                                <span className="w-2 h-6 bg-purple-500 rounded-full"></span> 
                                {viewMode === 'results' ? "Search Results" : "Suggested Vibes"}
                            </h2>
                            {viewMode === 'vibes' && suggestedVideos.length > 0 && (
                                <button 
                                    onClick={handleVibesSort}
                                    className="text-sm text-purple-400 hover:text-purple-300 transition font-bold flex items-center gap-1"
                                >
                                    ✨ AI Sort Vibes
                                </button>
                            )}
                            {viewMode === 'results' && (
                                <button onClick={() => setViewMode('vibes')} className="text-sm text-gray-400 hover:text-white transition">
                                    Back to Suggestions
                                </button>
                            )}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {(viewMode === 'results' ? searchResults : suggestedVideos).length > 0 ? (viewMode === 'results' ? searchResults : suggestedVideos).map((vid, i) => (
                                <div 
                                    key={i} 
                                    onClick={() => playNow(vid.id)} 
                                    className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer relative"
                                >
                                    <div className="w-16 h-10 rounded-lg overflow-hidden relative shrink-0">
                                        <img src={vid.thumb || `https://img.youtube.com/vi/${vid.id}/mqdefault.jpg`} className="w-full h-full object-cover group-hover:scale-110 transition duration-500" />
                                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                                            <Play fill="white" size={16} />
                                        </div>
                                    </div>
                                    
                                    <div className="flex-1 min-w-0">
                                        <h4 className="text-sm font-medium truncate text-gray-200 group-hover:text-purple-400 transition">{vid.title}</h4>
                                    </div>

                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); setDownloadVideoId(vid.id); }}
                                            className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition"
                                            title="Download Video"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                        </button>
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); handleLike(vid); }}
                                            className={`p-1.5 rounded-lg transition ${likedSongs.some(s => s.id === vid.id) ? 'text-pink-600' : 'text-gray-400 hover:text-pink-600'}`}
                                            title="Like Song"
                                        >
                                           <Heart size={14} fill={likedSongs.some(s => s.id === vid.id) ? "currentColor" : "none"} />
                                        </button>
                                        <button 
                                            onClick={(e) => addToQueue(vid.id, vid.title, e)}
                                            className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition"
                                            title="Add to Queue"
                                        >
                                           <PlusIcon size={14} />
                                        </button>
                                    </div>
                                </div>
                            )) : (
                                // Loading Skeleton or Fallback
                                <p className="text-gray-500 col-span-2">{viewMode === 'results' ? "No results found." : "Loading suggestions..."}</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* Sidebar: Chat & Queue (Desktop Only) */}
                <div className="col-span-12 lg:col-span-4 hidden lg:flex flex-col gap-6">
                    {/* Chat Box (Desktop: Always, Mobile: Only if tab active) */}
                    <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-4 flex flex-col h-[400px]">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-bold flex items-center gap-2"><MessageSquare size={18} className="text-purple-500" /> Chat Room</h3>
                        </div>
                        <div ref={chatContainerRef} className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2 scrollbar-hide">
                            {messages.map(m => (
                                <div key={m.id} className="flex gap-3 hover:bg-white/5 p-2 rounded-xl transition group animate-fade-in">
                                    <img 
                                        src={`https://api.dicebear.com/7.x/identicon/svg?seed=${m.user}`} 
                                        className="w-8 h-8 rounded-full bg-black/20 shrink-0 border border-white/10" 
                                        alt={m.user}
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-baseline gap-2 mb-0.5">
                                            <span 
                                                className="text-xs font-bold truncate" 
                                                style={{ color: getColor(m.user) }}
                                            >
                                                {m.user}
                                            </span>
                                            <span className="text-[10px] text-gray-600 group-hover:text-gray-400 transition">
                                                {new Date(m.id).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                            </span>
                                        </div>
                                        {m.message.startsWith('AG_GIF::') ? (
                                            <img src={m.message.replace('AG_GIF::', '')} className="rounded-lg max-w-[150px] mt-1 border border-white/10" alt="GIF" />
                                        ) : (
                                            <p className="text-sm text-gray-200 break-words leading-snug">{m.message}</p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                        
                        {/* Unified Emoji & GIF Drawer */}
                        {isDrawerOpen && (
                            <div ref={drawerRef} className="absolute bottom-20 right-4 z-50 bg-[#1e1e24] border border-white/10 rounded-2xl shadow-2xl w-[320px] overflow-hidden flex flex-col h-[400px]">
                                {/* Tabs */}
                                <div className="flex border-b border-white/10">
                                    <button 
                                        className={`flex-1 p-3 text-sm font-bold transition flex items-center justify-center gap-2 ${activeTab === 'emoji' ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'}`}
                                        onClick={() => setActiveTab('emoji')}
                                    >
                                        <Smile size={16} /> Emojis
                                    </button>
                                    <button 
                                        className={`flex-1 p-3 text-sm font-bold transition flex items-center justify-center gap-2 ${activeTab === 'gif' ? 'bg-white/10 text-white' : 'text-gray-400 hover:bg-white/5'}`}
                                        onClick={() => setActiveTab('gif')}
                                    >
                                        <ImageIcon size={16} /> GIFs
                                    </button>
                                </div>
                        
                                {/* Content */}
                                <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
                                    {activeTab === 'emoji' ? (
                                         <EmojiPicker 
                                            theme="dark"
                                            width="100%"
                                            height="350px"
                                            searchDisabled
                                            skinTonesDisabled
                                            previewConfig={{ showPreview: false }}
                                            onEmojiClick={(e) => {
                                                setInputMsg(prev => prev + e.emoji);
                                            }} 
                                        />
                                    ) : (
                                        <div className="flex flex-col h-full">
                                            <div className="p-2 sticky top-0 bg-[#1e1e24] z-10">
                                                <div className="flex items-center bg-white/5 rounded-lg border border-white/10 px-2">
                                                    <Search size={14} className="text-gray-400 shrink-0" />
                                                    <input 
                                                        className="w-full bg-transparent border-none p-2 text-xs text-white placeholder-gray-500 focus:outline-none"
                                                        placeholder="Search GIFs via Tenor..."
                                                        value={gifSearch}
                                                        onChange={(e) => {
                                                            setGifSearch(e.target.value);
                                                            searchGifs(e.target.value);
                                                        }}
                                                    />
                                                    {gifSearch && <button onClick={() => { setGifSearch(''); setGifResults([]); }}><X size={14} className="text-gray-400 hover:text-white shrink-0" /></button>}
                                                </div>
                                            </div>
                                            <div className="columns-2 gap-2 p-2 pt-0 overflow-y-auto scrollbar-thin">
                                                 {(gifResults.length > 0 ? gifResults : REACTION_GIFS).map((g, i) => (
                                                    <button 
                                                        key={i} 
                                                        onClick={() => {
                                                            socket.emit('send-message', { roomId, message: `AG_GIF::${g.url}`, user: username });
                                                            setIsDrawerOpen(false);
                                                        }}
                                                        className="relative group w-full mb-2 rounded-lg overflow-hidden border border-white/5 hover:border-purple-500 transition break-inside-avoid"
                                                    >
                                                        <img src={g.url} className="w-full h-auto object-cover" loading="lazy" />
                                                        <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[10px] text-center py-1 opacity-0 group-hover:opacity-100 transition whitespace-nowrap overflow-hidden px-1">{g.name || 'GIF'}</span>
                                                    </button>
                                                 ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="relative flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-2">
                            <button 
                                onClick={() => setIsDrawerOpen(!isDrawerOpen)}
                                className={`drawer-toggle p-2 rounded-lg transition ${isDrawerOpen ? 'text-purple-400 bg-white/10' : 'text-gray-400 hover:text-purple-400'}`}
                            >
                                <Smile size={20} />
                            </button>
                            <input 
                                value={inputMsg}
                                onChange={(e) => setInputMsg(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                                className="flex-1 bg-transparent border-none py-3 px-2 focus:outline-none placeholder-gray-500 text-sm" 
                                placeholder="Type a message..." 
                            />
                            <button onClick={sendMessage} className="p-2 bg-purple-600 rounded-lg hover:bg-purple-500 transition shadow-lg shadow-purple-600/20">
                                <Send size={16} />
                            </button>
                        </div>
                    </div>

                    {/* Queue Box (Desktop: Always, Mobile: Only if tab active) */}
                    <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-6 flex-1 h-[300px] overflow-hidden flex flex-col">
                        <h3 className="font-bold flex items-center gap-2 mb-4"><ListMusic size={18} className="text-purple-500" /> Up Next</h3>
                        
                        <DndContext 
                            sensors={sensors} 
                            collisionDetection={closestCenter} 
                            onDragEnd={handleDragEnd}
                        >
                            <div className="flex-1 overflow-y-auto space-y-3">
                                <SortableContext items={queue.map((item, i) => `dq-${i}-${item.id}`)} strategy={verticalListSortingStrategy}>
                                    {queue.map((item, i) => (
                                        <SortableItem key={`dq-${i}-${item.id}`} idString={`dq-${i}-${item.id}`}>
                                            <div 
                                                onClick={() => playNow(item.id)}
                                                className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer relative"
                                            >
                                                <img src={`https://img.youtube.com/vi/${item.id}/default.jpg`} className="w-12 h-12 rounded-lg object-cover" />
                                                <p className="text-xs font-medium truncate flex-1">{item.title}</p>
                                                <Play size={12} className="opacity-0 group-hover:opacity-100 text-purple-500" />
                                                
                                                <button 
                                                    onClick={(e) => { 
                                                        e.stopPropagation(); 
                                                        setDownloadVideoId(item.id);
                                                    }}
                                                    className="p-1.5 rounded-lg hover:bg-white/10 text-gray-600 hover:text-white transition mr-1 z-10"
                                                    title="Download"
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onTouchStart={(e) => e.stopPropagation()}
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                </button>

                                                <button 
                                                    onClick={(e) => { 
                                                        e.stopPropagation(); 
                                                        handleLike({ ...item, thumb: item.thumb || `https://img.youtube.com/vi/${item.id}/hqdefault.jpg` }); 
                                                    }}
                                                    className={`p-1.5 rounded-lg transition mr-1 z-10 ${likedSongs.some(s => s.id === item.id) ? 'text-pink-500' : 'text-gray-600 hover:text-pink-500'}`}
                                                    title="Like"
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onTouchStart={(e) => e.stopPropagation()}
                                                >
                                                    <Heart size={14} fill={likedSongs.some(s => s.id === item.id) ? "currentColor" : "none"} />
                                                </button>

                                                <button 
                                                    onClick={(e) => removeFromQueue(e, i)}
                                                    className="p-1.5 rounded-lg hover:bg-red-500/20 text-gray-600 hover:text-red-500 transition ml-2 z-10"
                                                    title="Remove"
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onTouchStart={(e) => e.stopPropagation()}
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        </SortableItem>
                                    ))}
                                </SortableContext>

                                {/* Auto-Queue Separator */}
                                {relatedQueue.length > 0 && (
                                    <>
                                        <div className="border-t border-white/5 my-4 pt-2">
                                            <p className="text-[10px] uppercase font-bold text-gray-500 mb-2">Recommended Next</p>
                                        </div>
                                        {relatedQueue.slice(0, 10).map((item, i) => (
                                            <div 
                                                key={`r-${i}`}
                                                onClick={() => playRelated(item)}
                                                className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-pointer opacity-70 hover:opacity-100"
                                            >
                                                <img src={item.thumb || `https://img.youtube.com/vi/${item.id}/default.jpg`} className="w-10 h-10 rounded-lg object-cover grayscale group-hover:grayscale-0 transition" />
                                                <p className="text-xs font-medium truncate flex-1 text-gray-400 group-hover:text-white transition">{item.title}</p>
                                                <button 
                                                    onClick={(e) => { 
                                                        e.stopPropagation(); 
                                                        setDownloadVideoId(item.id);
                                                    }}
                                                    className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition"
                                                    title="Download"
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                </button>
                                                <button 
                                                    onClick={(e) => { 
                                                        e.stopPropagation(); 
                                                        handleLike({ ...item, thumb: item.thumb || `https://img.youtube.com/vi/${item.id}/hqdefault.jpg` }); 
                                                    }}
                                                    className={`p-2 rounded-lg transition ${likedSongs.some(s => s.id === item.id) ? 'text-pink-500' : 'text-gray-400 hover:text-pink-500'}`}
                                                    title="Like"
                                                    onPointerDown={(e) => e.stopPropagation()}
                                                >
                                                    <Heart size={16} fill={likedSongs.some(s => s.id === item.id) ? "currentColor" : "none"} />
                                                </button>
                                            </div>
                                        ))}
                                    </>
                                )}

                                {queue.length === 0 && relatedQueue.length === 0 && <p className="text-center text-xs text-gray-500 mt-10">Queue is empty... <br/>Add some songs!</p>}
                            </div>
                        </DndContext>
                    </div>
                </div>
            </main>

            {/* Sticky Audio Player Floating Glass Design */}
            {(showStickyPlayer || isAudioMode) && currentVideoId && (
                <div className="fixed bottom-0 left-0 right-0 z-50 flex justify-center pb-4 px-4 pointer-events-none">
                    <div className="w-full max-w-4xl bg-black/60 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 shadow-2xl flex items-center justify-between gap-4 pointer-events-auto overflow-hidden relative group">
                        
                         {/* Ambient Glow Background */}
                        <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-pink-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
                        
                        {/* Progress Bar (Top Border Line) */}
                        <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/10">
                            <div 
                                className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300"
                                style={{ width: `${(progress / (duration || 100)) * 100}%` }}
                            />
                        </div>

                        {/* Song Info */}
                        <div className="flex items-center gap-4 flex-1 min-w-0 relative z-10">
                            <div className={`w-14 h-14 rounded-full overflow-hidden border-2 border-white/10 shadow-lg shrink-0 ${isPlaying ? 'animate-[spin_4s_linear_infinite]' : ''}`}>
                                 <img 
                                    src={`https://img.youtube.com/vi/${currentVideoId}/mqdefault.jpg`} 
                                    className="w-full h-full object-cover" 
                                    alt="vinyl" 
                                />
                            </div>
                            <div className="min-w-0 flex flex-col justify-center">
                                <h4 className="text-white font-bold text-sm truncate">{currentTitle}</h4>
                                <p className="text-purple-300 text-xs truncate font-medium flex items-center gap-2">
                                    {isPlaying ? <span className="flex gap-0.5 h-2 items-end"><span className="w-0.5 bg-purple-400 animate-dance h-full"></span><span className="w-0.5 bg-purple-400 animate-dance delay-75 h-2/3"></span><span className="w-0.5 bg-purple-400 animate-dance delay-150 h-full"></span></span> : <Music size={10} />}
                                    {formatTime(progress)} / {formatTime(duration)}
                                </p>
                            </div>
                        </div>
                        
                        {/* Controls */}
                        <div className="flex items-center gap-3 relative z-10">
                            <button 
                                onClick={(e) => { e.stopPropagation(); setDownloadVideoId(currentVideoId); }}
                                className="p-2 rounded-full transition text-gray-400 hover:text-white hover:bg-white/10"
                                title="Download Video"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            </button>
                            <button 
                                onClick={(e) => { e.stopPropagation(); handleLike({ id: currentVideoId, title: currentTitle }); }}
                                className={`p-2 rounded-full transition ${likedSongs.some(s => s.id === currentVideoId) ? 'text-pink-500 bg-pink-500/10' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
                            >
                                <Heart size={18} fill={likedSongs.some(s => s.id === currentVideoId) ? "currentColor" : "none"} />
                            </button>

                            <div className="h-8 w-[1px] bg-white/10 mx-1"></div>

                            <button 
                                onClick={handlePrevious}
                                className="p-2 text-white hover:text-purple-300 hover:scale-110 transition"
                            >
                                <SkipBack size={22} fill="currentColor" />
                            </button>
                            
                            <button 
                                onClick={handleTogglePlay}
                                className="p-3 bg-white text-black rounded-full hover:scale-110 active:scale-95 transition shadow-lg shadow-purple-500/20"
                            >
                                {isPlaying ? <Pause size={24} fill="black" /> : <Play size={24} fill="black" className="ml-1" />}
                            </button>
                            
                            <button 
                                onClick={handleNext}
                                className="p-2 text-white hover:text-purple-300 hover:scale-110 transition"
                            >
                                <SkipForward size={22} fill="currentColor" />
                            </button>

                            <button 
                                onClick={() => {
                                    window.scrollTo({ top: 0, behavior: 'smooth' });
                                    setIsAudioMode(false);
                                }}
                                className="p-2 ml-2 text-gray-500 hover:text-white hover:bg-white/10 rounded-full transition hidden sm:block"
                                title="Expand Player"
                            >
                                <Maximize size={18} />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Download Modal */}
            {downloadVideoId && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
                    <div className="bg-gray-900 border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-xl font-bold text-white flex items-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-400"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                Download Video
                            </h2>
                            <button onClick={() => setDownloadVideoId(null)} className="text-gray-400 hover:text-white transition">
                                <X size={24} />
                            </button>
                        </div>
                        
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-400 mb-1">Quality</label>
                                <select id="download-quality" className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 transition">
                                    <option value="best">Best Video</option>
                                    <option value="1080p">1080p</option>
                                    <option value="720p">720p</option>
                                    <option value="480p">480p</option>
                                    <option value="audio">Audio Only (M4A)</option>
                                </select>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-400 mb-1">Start Time (Optional)</label>
                                    <input type="text" id="download-start" placeholder="e.g. 00:01:30" className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 transition" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-400 mb-1">End Time (Optional)</label>
                                    <input type="text" id="download-end" placeholder="e.g. 00:02:45" className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white focus:outline-none focus:border-purple-500 transition" />
                                </div>
                            </div>
                            <p className="text-xs text-gray-500">Format: HH:MM:SS. Leave blank to download full video.</p>
                            
                            <button 
                                onClick={() => {
                                    const quality = document.getElementById('download-quality').value;
                                    const start = document.getElementById('download-start').value;
                                    const end = document.getElementById('download-end').value;
                                    
                                    let url = `/api/download?videoId=${downloadVideoId}&quality=${quality}`;
                                    if (start || end) {
                                        if (start) url += `&startTime=${start}`;
                                        if (end) url += `&endTime=${end}`;
                                    }
                                    
                                    window.open(url, '_blank');
                                    setDownloadVideoId(null);
                                }}
                                className="w-full mt-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-bold py-3 px-4 rounded-xl transition shadow-lg shadow-purple-500/25 flex justify-center items-center gap-2"
                            >
                                Start Download
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
