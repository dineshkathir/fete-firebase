// ═══════════════════════════════════════════════
// FIREBASE — real Google OAuth only
// ═══════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut as fbSignOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, deleteDoc, doc, getDocs, getFirestore, query, setDoc, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const _fbApp = initializeApp({
  apiKey: "AIzaSyDnY1snuFwjiHRdPSe_Q36dG8krYwkXfb0",
  authDomain: "fete-app-c07ec.firebaseapp.com",
  projectId: "fete-app-c07ec",
  storageBucket: "fete-app-c07ec.firebasestorage.app",
  messagingSenderId: "695388049760",
  appId: "1:695388049760:web:2cc5235d1422b82fa14e05"
});
const _fbAuth = getAuth(_fbApp);
const _fbDb = getFirestore(_fbApp);
const _gProvider = new GoogleAuthProvider();

const Cloud = (() => {
  let _sessionToken = 0;
  let _unsubs = { eventsMem: null, eventsGst: null, guests: [], gifts: [], masterGuestInbox: null, masterGuestSent: null };

  function unsubscribeAll() {
    if (_unsubs.eventsMem) { _unsubs.eventsMem(); _unsubs.eventsMem = null; }
    if (_unsubs.eventsGst) { _unsubs.eventsGst(); _unsubs.eventsGst = null; }
    if (_unsubs.masterGuestInbox) { _unsubs.masterGuestInbox(); _unsubs.masterGuestInbox = null; }
    if (_unsubs.masterGuestSent) { _unsubs.masterGuestSent(); _unsubs.masterGuestSent = null; }
    _unsubs.guests.forEach(unsub => unsub()); _unsubs.guests = [];
    _unsubs.gifts.forEach(unsub => unsub()); _unsubs.gifts = [];
    if (typeof setMasterGuestShareState === 'function') setMasterGuestShareState([], []);
  }

  function cleanData(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function chunk(items, size=10) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
  }

  function normalizeEmail(email) {
    return (email || '').trim().toLowerCase();
  }

  function listenMasterGuestShares(session) {
    const email = normalizeEmail(session?.email);
    if (_unsubs.masterGuestInbox) { _unsubs.masterGuestInbox(); _unsubs.masterGuestInbox = null; }
    if (_unsubs.masterGuestSent) { _unsubs.masterGuestSent(); _unsubs.masterGuestSent = null; }
    if (!email) {
      if (typeof setMasterGuestShareState === 'function') setMasterGuestShareState([], []);
      return;
    }
    const qInbox = query(collection(_fbDb, 'masterGuestShares'), where('recipientEmail', '==', email));
    _unsubs.masterGuestInbox = onSnapshot(qInbox, snapshot => {
      const items = snapshot.docs
        .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      if (typeof setMasterGuestShareState === 'function') {
        setMasterGuestShareState(items, null);
      }
    });
    const qSent = query(collection(_fbDb, 'masterGuestShares'), where('senderEmail', '==', email));
    _unsubs.masterGuestSent = onSnapshot(qSent, snapshot => {
      const items = snapshot.docs
        .map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      if (typeof setMasterGuestShareState === 'function') {
        setMasterGuestShareState(null, items);
      }
    });
  }

  function normalizeTeam(team, fallbackSession) {
    const seen = new Set();
    const normalized = [];
    for (const member of (team || [])) {
      const email = normalizeEmail(member?.email);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      normalized.push({
        userId: member?.userId || (fallbackSession && normalizeEmail(fallbackSession.email) === email ? fallbackSession.id : ''),
        email,
        name: member?.name || email.split('@')[0],
        role: member?.role || 'room',
        addedAt: member?.addedAt || Date.now()
      });
    }
    return normalized;
  }

  function hydrateTeamForSession(team, session) {
    const email = normalizeEmail(session?.email);
    return normalizeTeam((team || []).map(member => {
      if (email && normalizeEmail(member.email) === email) {
        return { ...member, userId: session.id, name: session.name || member.name };
      }
      return member;
    }), session);
  }

function serializeEvent(event, team, session) {
    const normalizedTeam = hydrateTeamForSession(team, session);
    return cleanData({
      id: event.id,
      name: event.name || '',
      date: event.date || '',
      time: event.time || '',
      type: event.type || 'wedding',
      location: event.location || '',
      locLat: event.locLat ?? null,
      locLon: event.locLon ?? null,
      color: event.color || 'rose',
      roomLocs: Array.isArray(event.roomLocs) ? event.roomLocs : [],
      foodMenus: normalizeEventMenus(event.foodMenus),
      eventContacts: normalizeEventContacts(event.eventContacts),
      roomRequestsEnabled: event.roomRequestsEnabled !== false,
      feedbackEnabled: event.feedbackEnabled === true,
      createdAt: event.createdAt || Date.now(),
      updatedAt: Date.now(),
      team: normalizedTeam,
      memberEmails: normalizedTeam.map(member => member.email),
      organizerEmails: normalizedTeam.filter(member => member.role === 'organizer').map(member => member.email),
      roomEmails: normalizedTeam.filter(member => member.role === 'organizer' || member.role === 'room').map(member => member.email)
    });
  }

  let _activeEventIds = '';
  
  function loadEventDataForEvents(eventIds) {
    if (!eventIds.length) {
      _unsubs.guests.forEach(unsub => unsub()); _unsubs.guests = [];
      _unsubs.gifts.forEach(unsub => unsub()); _unsubs.gifts = [];
      DB.guests = [];
      DB.gifts = [];
      save();
      return;
    }
    
    const currentIds = [...eventIds].sort().join(',');
    if (currentIds === _activeEventIds) return; // already listening to these exact events
    _activeEventIds = currentIds;
    
    _unsubs.guests.forEach(unsub => unsub()); _unsubs.guests = [];
    _unsubs.gifts.forEach(unsub => unsub()); _unsubs.gifts = [];
    
    let guestsMap = new Map();
    let giftsMap = new Map();
    
    const flushData = () => {
      DB.guests = Array.from(guestsMap.values());
      DB.gifts = Array.from(giftsMap.values());
      save();
      NotificationCenter.evaluateRoomAllocations(DB.guests, Auth.currentSession());
      render();
    };

    const batches = chunk(eventIds, 10);
    for (const ids of batches) {
      // Split IDs into guest-only and member events
      const guestOnlyIds = ids.filter(id => { const ev = DB.events.find(e => e.id === id); return ev && ev._isGuestOnly; });
      const memberIds = ids.filter(id => !guestOnlyIds.includes(id));

      if (memberIds.length > 0) {
        const qGuests = query(collection(_fbDb, 'guests'), where('eventId', 'in', memberIds));
        _unsubs.guests.push(onSnapshot(qGuests, snapshot => {
          memberIds.forEach(evId => { for(const [gid, gdata] of guestsMap) { if(gdata.eventId === evId) guestsMap.delete(gid); } });
          snapshot.docs.forEach(docSnap => guestsMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
          flushData();
        }));
        
        const qGifts = query(collection(_fbDb, 'gifts'), where('eventId', 'in', memberIds));
        _unsubs.gifts.push(onSnapshot(qGifts, snapshot => {
          memberIds.forEach(evId => { for(const [gid, gdata] of giftsMap) { if(gdata.eventId === evId) giftsMap.delete(gid); } });
          snapshot.docs.forEach(docSnap => giftsMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
          flushData();
        }));
      }

      if (guestOnlyIds.length > 0) {
        const email = normalizeEmail(Auth.currentSession()?.email);
        const guestOnlyMaps = {
          email: new Map(),
          legacy: new Map()
        };
        const mergeGuestOnlyGuests = () => {
          guestOnlyIds.forEach(evId => {
            for (const [gid, gdata] of guestsMap) {
              if (gdata.eventId === evId) guestsMap.delete(gid);
            }
          });
          for (const sourceMap of Object.values(guestOnlyMaps)) {
            sourceMap.forEach((value, key) => guestsMap.set(key, value));
          }
          flushData();
        };
        // Support both the new dedicated email field and older records that stored email in contact.
        const qGuestsGuest = query(collection(_fbDb, 'guests'), where('email', '==', email));
        _unsubs.guests.push(onSnapshot(qGuestsGuest, snapshot => {
          guestOnlyMaps.email.clear();
          snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            if (guestOnlyIds.includes(data.eventId)) {
              guestOnlyMaps.email.set(docSnap.id, { id: docSnap.id, ...data });
            }
          });
          mergeGuestOnlyGuests();
        }));
        const qGuestsGuestLegacy = query(collection(_fbDb, 'guests'), where('contact', '==', email));
        _unsubs.guests.push(onSnapshot(qGuestsGuestLegacy, snapshot => {
          guestOnlyMaps.legacy.clear();
          snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            if (guestOnlyIds.includes(data.eventId)) {
              guestOnlyMaps.legacy.set(docSnap.id, { id: docSnap.id, ...data });
            }
          });
          mergeGuestOnlyGuests();
        }));
      }
    }
  }

  async function syncCollectionForEvent(collectionName, eventId, items) {
    const snap = await getDocs(query(collection(_fbDb, collectionName), where('eventId', '==', eventId)));
    const cloudIds = new Set(snap.docs.map(docSnap => docSnap.id));
    const localIds = new Set();
    for (const item of items) {
      localIds.add(item.id);
      await setDoc(doc(_fbDb, collectionName, item.id), cleanData(item), { merge: true });
    }
    for (const docSnap of snap.docs) {
      if (!localIds.has(docSnap.id)) {
        await deleteDoc(doc(_fbDb, collectionName, docSnap.id));
      }
    }
  }

  async function syncGuestSelf(eventId) {
    const sessionEmail = normalizeEmail(Auth.currentSession()?.email);
    if (!sessionEmail) return;
    const guest = DB.guests.find(item => item.eventId === eventId && (
      normalizeEmail(item.email) === sessionEmail || normalizeEmail(item.contact) === sessionEmail
    ));
    if (!guest) return;
    await setDoc(doc(_fbDb, 'guests', guest.id), cleanData(guest), { merge: true });
  }

  async function syncEventData(eventId) {
    if (!eventId) return;
    const ev = DB.events.find(e => e.id === eventId);
    if (ev && ev._isGuestOnly) {
      await syncGuestSelf(eventId);
      return;
    }
    const guests = DB.guests.filter(guest => guest.eventId === eventId);
    await syncCollectionForEvent('guests', eventId, guests);
    
    // Gifts and Events updates should only be performed by actual team members, not guests handling their own room requests.
    if (ev && !ev._isGuestOnly) {
      await syncCollectionForEvent('gifts', eventId, DB.gifts.filter(gift => gift.eventId === eventId));
      const guestEmails = [...new Set(
        guests
          .flatMap(g => [g.email || '', g.contact || ''])
          .map(v => v.toLowerCase().trim())
          .filter(e => e.includes('@'))
      )];
      try { await setDoc(doc(_fbDb, 'events', eventId), { guestEmails }, { merge: true }); } catch(e){}
    }
  }

  async function deleteDocsForEvent(collectionName, eventId) {
    const snap = await getDocs(query(collection(_fbDb, collectionName), where('eventId', '==', eventId)));
    for (const docSnap of snap.docs) {
      await deleteDoc(doc(_fbDb, collectionName, docSnap.id));
    }
  }

  function applyEventsToLocal(events, session) {
    DB.events = events.map(event => ({
      id: event.id,
      _isGuestOnly: !!event._isGuestOnly,
      name: event.name || '',
      date: event.date || '',
      time: event.time || '',
      type: event.type || 'wedding',
      location: event.location || '',
      locLat: event.locLat ?? null,
      locLon: event.locLon ?? null,
      color: event.color || 'rose',
      roomLocs: Array.isArray(event.roomLocs) ? event.roomLocs : [],
      foodMenus: normalizeEventMenus(event.foodMenus),
      eventContacts: normalizeEventContacts(event.eventContacts),
      roomRequestsEnabled: event.roomRequestsEnabled !== false,
      feedbackEnabled: event.feedbackEnabled === true,
      createdAt: event.createdAt || Date.now()
    }));
    for (const event of events) {
      const team = hydrateTeamForSession(event.team || [], session);
      localStorage.setItem('fete_team_' + event.id, JSON.stringify(team));
    }
    const visibleIds = new Set(DB.events.map(event => event.id));
    Object.keys(localStorage)
      .filter(key => key.startsWith('fete_team_'))
      .forEach(key => {
        const eventId = key.replace('fete_team_', '');
        if (!visibleIds.has(eventId)) localStorage.removeItem(key);
      });
    if (DB.activeEvent && !visibleIds.has(DB.activeEvent)) DB.activeEvent = DB.events[0]?.id || null;
    if (!DB.activeEvent && DB.events.length) DB.activeEvent = DB.events[0].id;
    save();
    NotificationCenter.evaluateTeamInvites(DB.events, session);
  }

  function loadEventsForSession(session) {
    const myToken = ++_sessionToken;
    const email = normalizeEmail(session?.email);
    
    if (_unsubs.eventsMem) { _unsubs.eventsMem(); _unsubs.eventsMem = null; }
    if (_unsubs.eventsGst) { _unsubs.eventsGst(); _unsubs.eventsGst = null; }
    
    if (!email) {
      applyEventsToLocal([], session);
      listenMasterGuestShares(session);
      render();
      return;
    }
    
    let memEvents = new Map();
    let gstEvents = new Map();

    const flushEvents = () => {
      // Members take precedence if both matched
      const allEvents = new Map([...gstEvents, ...memEvents]); 
      applyEventsToLocal(Array.from(allEvents.values()), session);
      loadEventDataForEvents(Array.from(allEvents.keys()));
      render();
    };
    
    const qEventsMem = query(collection(_fbDb, 'events'), where('memberEmails', 'array-contains', email));
    _unsubs.eventsMem = onSnapshot(qEventsMem, snapshot => {
      if (myToken !== _sessionToken) return;
      memEvents.clear();
      snapshot.docs.forEach(docSnap => memEvents.set(docSnap.id, { id: docSnap.id, _isGuestOnly: false, ...docSnap.data() }));
      flushEvents();
    });

    const qEventsGst = query(collection(_fbDb, 'events'), where('guestEmails', 'array-contains', email));
    _unsubs.eventsGst = onSnapshot(qEventsGst, snapshot => {
      if (myToken !== _sessionToken) return;
      gstEvents.clear();
      snapshot.docs.forEach(docSnap => gstEvents.set(docSnap.id, { id: docSnap.id, _isGuestOnly: true, ...docSnap.data() }));
      flushEvents();
    });

    listenMasterGuestShares(session);
  }

  async function saveEvent(event, team, session) {
    const payload = serializeEvent(event, team, session);
    await setDoc(doc(_fbDb, 'events', event.id), payload, { merge: true });
    localStorage.setItem('fete_team_' + event.id, JSON.stringify(payload.team));
  }

  async function deleteEvent(eventId) {
    await deleteDocsForEvent('guests', eventId);
    await deleteDocsForEvent('gifts', eventId);
    await deleteDoc(doc(_fbDb, 'events', eventId));
    localStorage.removeItem('fete_team_' + eventId);
  }

  async function migrateLocalEvents(session) {
    const sessEmail = normalizeEmail(session?.email);
    if (!sessEmail) return;
    const localEvents = STORE.get('events') || [];
    for (const event of localEvents) {
      const team = hydrateTeamForSession(Auth.getTeam(event.id), session);
      const mine = team.find(member => member.email === sessEmail);
      if (!mine || mine.role !== 'organizer') continue;
      await saveEvent(event, team, session);
    }
    await loadEventsForSession(session);
  }

  async function clearAllCloudData(eventIds=[]) {
    for (const eventId of eventIds) {
      await deleteEvent(eventId);
    }
  }

  async function createMasterGuestShare(share) {
    await setDoc(doc(_fbDb, 'masterGuestShares', share.id), cleanData(share), { merge: true });
  }

  async function updateMasterGuestShare(shareId, updates) {
    await setDoc(doc(_fbDb, 'masterGuestShares', shareId), cleanData({ ...updates, updatedAt: Date.now() }), { merge: true });
  }

  return { unsubscribeAll, loadEventsForSession, saveEvent, deleteEvent, migrateLocalEvents, hydrateTeamForSession, syncEventData, clearAllCloudData, createMasterGuestShare, updateMasterGuestShare };
})();

// ═══════════════════════════════════════════════
// AUTH SYSTEM
// ═══════════════════════════════════════════════
const Auth = (() => {
  let _mode = 'signin'; // 'signin' | 'signup'

  function getUsers() { try{return JSON.parse(localStorage.getItem('fete_users'))||[];}catch{return[];} }
  function saveUsers(u) { localStorage.setItem('fete_users', JSON.stringify(u)); }
  function getSession() { try{return JSON.parse(localStorage.getItem('fete_session'))||null;}catch{return null;} }
  function setSession(u) { localStorage.setItem('fete_session', JSON.stringify(u)); }
  function clearSession() { localStorage.removeItem('fete_session'); }

  function getTeam(eventId) { try{return JSON.parse(localStorage.getItem('fete_team_'+eventId))||[];}catch{return[];} }
  function saveTeam(eventId,t) { localStorage.setItem('fete_team_'+eventId, JSON.stringify(t)); }

  function showError(msg) {
    const e=document.getElementById('auth-err');
    e.textContent=msg; e.style.display='block';
  }
  function clearError() {
    const e=document.getElementById('auth-err');
    if(e) e.style.display='none';
  }

  function toggleMode() {
    _mode = _mode==='signin'?'signup':'signin';
    document.getElementById('auth-name').style.display=_mode==='signup'?'block':'none';
    document.getElementById('auth-submit-btn').textContent=_mode==='signup'?'Create Account':'Sign In';
    document.getElementById('auth-toggle-lbl').innerHTML=_mode==='signup'
      ?'Already have an account? <span onclick="Auth.toggleMode()">Sign in</span>'
      :'Don\'t have an account? <span onclick="Auth.toggleMode()">Sign up</span>';
    clearError();
  }

  async function emailSubmit() {
    clearError();
    const email = document.getElementById('auth-email').value.trim().toLowerCase();
    const pass = document.getElementById('auth-pass').value;
    if(!email||!pass){showError('Please fill in all fields.');return;}
    if(!/\S+@\S+\.\S+/.test(email)){showError('Enter a valid email.');return;}
    try{
      if(_mode==='signup') {
        const name = document.getElementById('auth-name').value.trim()||email.split('@')[0];
        if(pass.length<6){showError('Password must be at least 6 characters.');return;}
        const cred = await createUserWithEmailAndPassword(_fbAuth, email, pass);
        if(name) await updateProfile(cred.user, { displayName: name });
      } else {
        await signInWithEmailAndPassword(_fbAuth, email, pass);
      }
    } catch(err) {
      const map = {
        'auth/email-already-in-use': 'Email already registered. Sign in instead.',
        'auth/invalid-credential': 'Incorrect email or password.',
        'auth/invalid-login-credentials': 'Incorrect email or password.',
        'auth/user-not-found': 'Incorrect email or password.',
        'auth/wrong-password': 'Incorrect email or password.',
        'auth/invalid-email': 'Enter a valid email.'
      };
      showError(map[err.code] || 'Sign-in failed. Please try again.');
    }
  }

  async function googleLogin() {
    clearError();
    try {
      await signInWithPopup(_fbAuth, _gProvider);
    } catch(err) {
      if (err.code !== 'auth/popup-closed-by-user') {
        showError('Google sign-in failed. Please try again.');
      }
    }
  }

  async function logout() {
    try { await fbSignOut(_fbAuth); } catch(e) {}
    showAuthScreen();
    document.getElementById('auth-email').value='';
    document.getElementById('auth-pass').value='';
    clearError();
    Cloud.unsubscribeAll();
  }

  function showAppShell() {
    document.getElementById('auth-screen').style.display='none';
    document.getElementById('app').style.display='flex';
    document.getElementById('hdr-team-btn').style.display='block';
    document.documentElement.classList.add('boot-authenticated');
  }

  function showAuthScreen() {
    document.getElementById('auth-screen').style.display='flex';
    document.getElementById('app').style.display='none';
    document.getElementById('hdr-team-btn').style.display='none';
    document.documentElement.classList.remove('boot-authenticated');
  }

  function _onLogin(sess, showWelcomeToast=true) {
    // If first ever user — make them organizer of all events automatically
    showAppShell();
    Cloud.migrateLocalEvents(sess).catch(()=>Cloud.loadEventsForSession(sess).catch(()=>{}));
    NotificationCenter.initKnownState();
    render();
    if(showWelcomeToast) toast(`Welcome, ${sess.name}!`);
  }

  // Role resolution: returns 'organizer'|'cash'|'room'|null for current user + active event
  function currentRole(eventId) {
    const sess = getSession();
    if(!sess) return null;
    const evId = eventId || (typeof DB!=='undefined'?DB.activeEvent:null);
    if(!evId) return null;
    const email = (sess.email||'').trim().toLowerCase();
    const team = Cloud.hydrateTeamForSession(getTeam(evId), sess);
    saveTeam(evId, team);
    const member = team.find(m=>m.userId===sess.id || ((m.email||'').trim().toLowerCase()===email));
    return member ? member.role : null;
  }

  function isOrganizer(eventId) { return currentRole(eventId)==='organizer'; }
  function isCash(eventId) { const r=currentRole(eventId); return r==='organizer'||r==='cash'; }
  function isRoom(eventId) { const r=currentRole(eventId); return r==='organizer'||r==='room'; }
  function canManageGuests(eventId) { return isOrganizer(eventId); }

  // When a new event is created, add the creator as organizer
  function addCreatorAsOrganizer(eventId) {
    const sess = getSession();
    if(!sess) return;
    const email = (sess.email||'').trim().toLowerCase();
    let team = Cloud.hydrateTeamForSession(getTeam(eventId), sess);
    const member = team.find(m=>((m.email||'').trim().toLowerCase()===email));
    if(member){
      member.userId = sess.id;
      member.name = sess.name;
      member.role = 'organizer';
    } else {
      team.push({userId:sess.id, email, name:sess.name, role:'organizer', addedAt:Date.now()});
    }
    saveTeam(eventId, team);
  }

  function renderTeamModal(eventId) {
    const sess = getSession();
    const team = Cloud.hydrateTeamForSession(getTeam(eventId), sess);
    saveTeam(eventId, team);
    const el = document.getElementById('team-member-list');
    const selectedEvent = DB.events.find(ev=>ev.id===eventId);
    const canEdit = isOrganizer(eventId);
    const inviteEmailEl=document.getElementById('team-invite-email');
    const inviteRoleEl=document.getElementById('team-invite-role');
    const inviteBtn=document.querySelector('#mo-team .btn-p[onclick="App.sendTeamInvite()"]');
    if(inviteEmailEl){
      inviteEmailEl.disabled=!canEdit;
      inviteEmailEl.style.opacity=canEdit?'1':'0.6';
      inviteEmailEl.placeholder=canEdit?'colleague@email.com':'Only organisers can invite members';
    }
    if(inviteRoleEl){
      inviteRoleEl.disabled=!canEdit;
      inviteRoleEl.style.opacity=canEdit?'1':'0.6';
    }
    if(inviteBtn){
      inviteBtn.disabled=!canEdit;
      inviteBtn.style.opacity=canEdit?'1':'0.6';
    }
    if(!el) return;
    if(team.length===0){el.innerHTML=`<div class="empty" style="padding:20px 0"><div class="empty-ico" style="color:var(--rose-d)">${uiIcon('guests',38)}</div><div class="empty-t" style="font-size:16px">No team members yet</div><div class="empty-s" style="font-size:12px">${selectedEvent?selectedEvent.name:''}</div></div>`;return;}
    el.innerHTML = team.map(m=>{
      const memberEmail = (m.email||'').trim().toLowerCase();
      const isMe = m.userId===sess?.id || memberEmail===((sess?.email||'').trim().toLowerCase());
      const roleLabel = m.role==='organizer'?'Organizer':m.role==='cash'?'Cash Collector':'Room Coord.';
      const roleCls = m.role==='organizer'?'organizer':m.role==='cash'?'cash':'room';
      const ini = (m.name||m.email||'?')[0].toUpperCase();
      return `<div class="team-member-row">
        <div class="team-av">${ini}</div>
        <div class="team-info">
          <div class="team-name">${m.name||m.email} ${isMe?'<span style="font-size:10px;color:var(--txt4)">(you)</span>':''}</div>
          <div class="team-email">${m.email}</div>
        </div>
        ${isOrganizer(eventId)&&!isMe
          ?`<select class="role-sel" onchange="Auth._changeRole('${eventId}','${memberEmail}',this.value)">
              <option value="organizer" ${m.role==='organizer'?'selected':''}>Organizer</option>
              <option value="cash" ${m.role==='cash'?'selected':''}>Cash</option>
              <option value="room" ${m.role==='room'?'selected':''}>Room</option>
            </select>
            <button onclick="Auth._removeMember('${eventId}','${m.userId}')" style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--txt4);padding:0 4px;font-weight:700">X</button>`
          :`<span class="role-badge role-${roleCls}">${roleLabel}</span>`}
      </div>`;
    }).join('');
  }

  function _changeRole(eventId, userId, role) {
    const team = getTeam(eventId);
    const key = (userId||'').trim().toLowerCase();
    const m = team.find(x=>x.userId===userId || ((x.email||'').trim().toLowerCase()===key));
    if(m) {
      m.role=role;
      saveTeam(eventId, team);
      const ev = DB.events.find(e=>e.id===eventId);
      if(ev) Cloud.saveEvent(ev, team, getSession()).catch(()=>toast('⚠️ Could not sync team changes'));
      renderTeamModal(eventId);
      render();
    }
  }

  function _removeMember(eventId, userId) {
    const key = (userId||'').trim().toLowerCase();
    let team = getTeam(eventId).filter(m=>m.userId!==userId && ((m.email||'').trim().toLowerCase()!==key));
    saveTeam(eventId, team);
    const ev = DB.events.find(e=>e.id===eventId);
    if(ev) Cloud.saveEvent(ev, team, getSession()).catch(()=>toast('⚠️ Could not sync team changes'));
    renderTeamModal(eventId);
    render();
  }

  function sendInvite(eventId, email, role) {
    if(!email||!/\S+@\S+\.\S+/.test(email)){return false;}
    const team = getTeam(eventId);
    const normalizedEmail = email.toLowerCase().trim();
    if(team.find(m=>((m.email||'').trim().toLowerCase()===normalizedEmail))){return 'exists';}
    team.push({userId:'', email:normalizedEmail, name:normalizedEmail.split('@')[0], role, addedAt:Date.now()});
    saveTeam(eventId, team);
    const ev = DB.events.find(e=>e.id===eventId);
    if(ev) Cloud.saveEvent(ev, team, getSession()).catch(()=>toast('⚠️ Could not sync invite'));
    renderTeamModal(eventId);
    render();
    return true;
  }

  function init() {
    const cachedSession = getSession();
    if(cachedSession){
      DB.profile.name=cachedSession.name||DB.profile.name||'';
      DB.profile.email=cachedSession.email||DB.profile.email||'';
      save();
      showAppShell();
      render();
    } else {
      showAuthScreen();
    }
    onAuthStateChanged(_fbAuth, user => {
      if(user){
        const sess = {
          id: user.uid,
          email: (user.email||'').trim().toLowerCase(),
          name: user.displayName || (user.email||'user').split('@')[0],
          provider: user.providerData?.[0]?.providerId || 'firebase',
          photoURL: user.photoURL || ''
        };
        setSession(sess);
        DB.profile.name=sess.name||DB.profile.name||'';
        DB.profile.email=sess.email||DB.profile.email||'';
        save();
        const shouldWelcome=!cachedSession || cachedSession.id!==sess.id;
        _onLogin(sess, shouldWelcome);
    } else {
      clearSession();
      DB.events=[];DB.guests=[];DB.gifts=[];DB.activeEvent=null;
      NotificationCenter.reset();
      save();
      showAuthScreen();
    }
  });
}

  function currentSession() { return getSession(); }

  return { toggleMode, emailSubmit, googleLogin, logout, currentRole, isOrganizer, isCash, isRoom, canManageGuests, addCreatorAsOrganizer, renderTeamModal, sendInvite, _changeRole, _removeMember, getTeam, currentSession, init };
})();

// Expose Auth globally for inline onclick
window.Auth = Auth;


const STORE = {
  get(k){try{return JSON.parse(localStorage.getItem('fete_'+k))||null}catch{return null}},
  set(k,v){localStorage.setItem('fete_'+k,JSON.stringify(v))},
};

function syncActiveEventData(){
  const sess = Auth.currentSession();
  if(!sess || !DB.activeEvent) return Promise.resolve();
  return Cloud.syncEventData(DB.activeEvent).catch(()=>toast('⚠️ Cloud sync failed'));
}

let DB = {
  events: STORE.get('events')||[],
  guests: STORE.get('guests')||[],
  gifts: STORE.get('gifts')||[],
  masterGuests: STORE.get('masterGuests')||[],
  activeEvent: STORE.get('activeEvent')||null,
  profile: STORE.get('profile')||{name:'',email:''},
  premium: STORE.get('premium')||false,
  settings: {...{rsvpReminders:true,tyReminders:true,exportNotes:true,removeGuestConfirmation:true,currency:'INR',appNotifications:false},...(STORE.get('settings')||{})},
};

function save(){
  STORE.set('events',DB.events);
  STORE.set('guests',DB.guests);
  STORE.set('gifts',DB.gifts);
  STORE.set('masterGuests',DB.masterGuests);
  STORE.set('activeEvent',DB.activeEvent);
  STORE.set('profile',DB.profile);
  STORE.set('premium',DB.premium);
  STORE.set('settings',DB.settings);
}

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}

const NotificationCenter = (() => {
  let _ready = false;
  let _registration = null;
  let _knownShareIds = new Set();
  let _knownEventIds = new Set();
  let _knownRoomAssignments = new Map();
  let _sharesSeeded = false;
  let _eventsSeeded = false;
  let _roomsSeeded = false;

  function supported(){
    return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
  }

  async function ensureRegistration(){
    if(!supported()) return null;
    if(_registration) return _registration;
    try{
      _registration = await navigator.serviceWorker.ready;
    }catch(e){
      _registration = null;
    }
    return _registration;
  }

  function enabled(){
    return supported() && DB.settings.appNotifications===true && Notification.permission==='granted';
  }

  async function requestPermission(){
    if(!supported()){
      toast('⚠️ Notifications are not supported on this device');
      return false;
    }
    const permission = await Notification.requestPermission();
    if(permission==='granted'){
      DB.settings.appNotifications=true;
      save();
      await ensureRegistration();
      renderSettings();
      toast('App notifications enabled');
      return true;
    }
    DB.settings.appNotifications=false;
    save();
    renderSettings();
    toast('⚠️ Notification permission not granted');
    return false;
  }

  async function show(title, body, options={}){
    if(!enabled()) return false;
    const registration = await ensureRegistration();
    if(!registration) return false;
    const payload = {
      body,
      tag: options.tag || uid(),
      renotify: false,
      badge: '/icons/icon-192.png',
      icon: '/icons/icon-192.png',
      data: options.data || {}
    };
    if(document.visibilityState === 'visible'){
      toast(`${title}: ${body}`);
      return true;
    }
    try{
      await registration.showNotification(title, payload);
      return true;
    }catch(e){
      return false;
    }
  }

  function initKnownState(){
    _knownShareIds = new Set(_incomingMasterGuestShares.filter(item=>item.status==='pending').map(item=>item.id));
    _knownEventIds = new Set(DB.events.map(item=>item.id));
    const session = Auth.currentSession();
    _knownRoomAssignments = new Map(
      DB.guests
        .filter(guest=>guestMatchesSession(guest, session))
        .map(guest=>[guest.id, formatGuestRooms(guest)])
    );
    _ready = true;
    _sharesSeeded = false;
    _eventsSeeded = false;
    _roomsSeeded = false;
  }

  function reset(){
    _ready = false;
    _knownShareIds = new Set();
    _knownEventIds = new Set();
    _knownRoomAssignments = new Map();
    _sharesSeeded = false;
    _eventsSeeded = false;
    _roomsSeeded = false;
  }

  function evaluateSharedGuestLists(items){
    const pending = (items||[]).filter(item=>item.status==='pending');
    if(!_ready || !_sharesSeeded){
      _knownShareIds = new Set(pending.map(item=>item.id));
      _sharesSeeded = true;
      return;
    }
    pending.forEach(item=>{
      if(_knownShareIds.has(item.id)) return;
      _knownShareIds.add(item.id);
      show('Shared guest list received', `${item.senderName||item.senderEmail||'Another user'} shared ${formatMasterGuestShareSummary(item)}.`, {
        tag:`share-${item.id}`,
        data:{ type:'shared-guest-list', shareId:item.id }
      });
    });
  }

  function evaluateTeamInvites(events, session){
    const email = normalizeEmailValue(session?.email);
    const currentIds = new Set((events||[]).map(item=>item.id));
    if(!_ready || !_eventsSeeded){
      _knownEventIds = currentIds;
      _eventsSeeded = true;
      return;
    }
    (events||[]).forEach(event=>{
      if(_knownEventIds.has(event.id)) return;
      const team = Cloud.hydrateTeamForSession(event.team||Auth.getTeam(event.id)||[], session);
      const mine = team.find(member=>normalizeEmailValue(member.email)===email);
      _knownEventIds.add(event.id);
      if(!mine || mine.role==='organizer') return;
      const roleLabel = mine.role==='cash' ? 'Cash Collector' : mine.role==='room' ? 'Room Coordinator' : 'Team Member';
      show('Team invite received', `You were added to ${event.name} as ${roleLabel}.`, {
        tag:`team-${event.id}`,
        data:{ type:'team-invite', eventId:event.id }
      });
    });
    _knownEventIds = currentIds;
  }

  function evaluateRoomAllocations(guests, session){
    const mine = (guests||[]).filter(guest=>guestMatchesSession(guest, session));
    if(!_ready || !_roomsSeeded){
      _knownRoomAssignments = new Map(mine.map(guest=>[guest.id, formatGuestRooms(guest)]));
      _roomsSeeded = true;
      return;
    }
    const next = new Map();
    mine.forEach(guest=>{
      const previous = _knownRoomAssignments.get(guest.id) || 'Not assigned yet';
      const current = formatGuestRooms(guest);
      next.set(guest.id, current);
      if(current !== previous && current !== 'Not assigned yet'){
        const eventName = DB.events.find(item=>item.id===guest.eventId)?.name || 'your event';
        show('Room allocated', `${eventName}: ${current}`, {
          tag:`room-${guest.id}`,
          data:{ type:'room-allocation', eventId:guest.eventId, guestId:guest.id }
        });
      }
    });
    _knownRoomAssignments = next;
  }

  return { supported, enabled, requestPermission, show, initKnownState, reset, evaluateSharedGuestLists, evaluateTeamInvites, evaluateRoomAllocations };
})();

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
const COLORS={
  rose:{accent:'#C4637A',light:'#FAF0F3',chip:'background:var(--rose-l);color:var(--rose-d)'},
  sage:{accent:'#6B9B7E',light:'#EEF5F0',chip:'background:var(--sage-l);color:var(--sage-d)'},
  gold:{accent:'#C09050',light:'#FBF6EC',chip:'background:var(--gold-l);color:var(--gold-d)'},
  slate:{accent:'#5B7FA6',light:'#EBF2F9',chip:'background:var(--slate-l);color:var(--slate-d)'},
};
const CURRENCY_META={
  INR:{code:'INR',label:'Indian Rupee',symbol:'₹',locale:'en-IN'},
  USD:{code:'USD',label:'US Dollar',symbol:'$',locale:'en-US'},
  EUR:{code:'EUR',label:'Euro',symbol:'€',locale:'de-DE'},
  GBP:{code:'GBP',label:'British Pound',symbol:'£',locale:'en-GB'},
  AED:{code:'AED',label:'UAE Dirham',symbol:'AED ',locale:'en-AE'},
};
function currentCurrencyCode(){
  const code=(DB.settings?.currency||'INR').toUpperCase();
  return CURRENCY_META[code]?code:'INR';
}
function currentCurrencyMeta(){
  return CURRENCY_META[currentCurrencyCode()];
}
function currencySymbol(){
  return currentCurrencyMeta().symbol;
}
const AV_BG=['#FFEAEE','#E8F5E9','#E3EEF9','#FFF6E1','#F4EAF5','#E1F4F0'];
const AV_C=['#8B3A52','#3D6B50','#2F5380','#8A6020','#6A2B8A','#1A6B5A'];
function uiIcon(name,size=14){
  const icons={
    event:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M5 12.5 12 5l7 7.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 11.5V19h10v-7.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 19v-4h4v4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    calendar:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8 3.5v3M16 3.5v3M4 9.5h16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
    time:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 7.5v5l3 1.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    location:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 20s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>`,
    user:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M5.5 18c1-3 3.4-4.5 6.5-4.5S17.5 15 18.5 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
    phone:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M7.8 4.8c.4-.4 1-.5 1.5-.2l2.2 1.3c.6.3.8 1 .6 1.6l-.8 2.1a1 1 0 0 0 .2 1c1 1.2 2.2 2.3 3.5 3.2a1 1 0 0 0 1 .1l2-1c.6-.3 1.3-.1 1.7.4l1.5 2.1c.4.5.3 1.1-.1 1.6l-1 1c-.9.9-2.3 1.2-3.5.8-2.5-.8-4.8-2.3-6.8-4.2-2-2-3.5-4.3-4.3-6.8-.4-1.2-.1-2.6.8-3.5l1.5-1.5Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>`,
    contact:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M7 5.5h10A1.5 1.5 0 0 1 18.5 7v10a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 17V7A1.5 1.5 0 0 1 7 5.5Z" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="10" cy="10" r="1.8" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8 15c.7-1.6 1.8-2.4 3-2.4s2.3.8 3 2.4M8 3.5h8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
    guests:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="9" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="16" cy="9" r="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4.5 18c.6-2.7 2.5-4 4.5-4s3.9 1.3 4.5 4M13.5 18c.4-2 1.8-3.1 3.5-3.1 1.4 0 2.7.8 3.4 2.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
    edit:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M3.75 17.25V20.25H6.75L17.2 9.8L14.2 6.8L3.75 17.25Z" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.9 8.1L15.9 11.1" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.55 7.45L15.2 5.8C15.6 5.4 16.25 5.4 16.65 5.8L18.2 7.35C18.6 7.75 18.6 8.4 18.2 8.8L16.55 10.45" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    save:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M5 4.5h11l3 3V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V4.5Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M8 4.5v5h7v-5M9 15.5h6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
    export:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 20V10M8.5 13.5 12 10l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 5.5h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
    share:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="18" cy="5.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="6" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="18" cy="18.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M8 11l7.7-4.2M8 13l7.7 4.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
    whatsapp:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M12 4.5a7.5 7.5 0 0 0-6.5 11.3L4.5 20l4.4-1a7.5 7.5 0 1 0 3.1-14.5Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M9.4 9.3c.2-.4.5-.4.7-.4h.5c.2 0 .4.1.5.4l.5 1.3c.1.2.1.4 0 .5l-.4.6c-.1.2-.1.4 0 .6.5.8 1.2 1.5 2 2 .2.1.4.1.6 0l.6-.4c.2-.1.4-.1.5 0l1.3.5c.3.1.4.3.4.5v.5c0 .2 0 .5-.4.7-.5.3-1 .5-1.6.4-1.1-.1-2.4-.8-3.7-2.1s-2-2.6-2.1-3.7c-.1-.6.1-1.1.4-1.6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
    gift:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M4 10h16v10H4zM12 10v10M4 14h16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 10s-3.8-1.5-3.8-3.9c0-1.3 1-2.2 2.2-2.2 1.1 0 1.9.6 2.6 2 .7-1.4 1.5-2 2.6-2 1.2 0 2.2.9 2.2 2.2C15.8 8.5 12 10 12 10Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>`,
    room:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M5 19V8.5A1.5 1.5 0 0 1 6.5 7h11A1.5 1.5 0 0 1 19 8.5V19M3 19h18M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M9 11h2v2H9zm4 0h2v2h-2z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    search:`<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M16 16l4 4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`
  };
  return icons[name]||'';
}
function daysUntil(dateStr){
  if(!dateStr)return null;
  const d=new Date(dateStr)-new Date();
  return Math.ceil(d/(1000*60*60*24));
}
function fmtDate(dateStr){
  if(!dateStr)return '';
  return new Date(dateStr+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
}
function escapeHtml(value){
  return String(value ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function todayInputDate(){
  const now=new Date();
  const localNow=new Date(now.getTime()-now.getTimezoneOffset()*60000);
  return localNow.toISOString().slice(0,10);
}
function fmtTime(timeStr){
  const raw=String(timeStr||'').trim();
  if(!raw) return '';
  const match24=raw.match(/^(\d{1,2}):(\d{2})$/);
  if(match24){
    const hours=Math.max(0,Math.min(23,parseInt(match24[1],10)));
    const minutes=Math.max(0,Math.min(59,parseInt(match24[2],10)));
    const dt=new Date();
    dt.setHours(hours,minutes,0,0);
    return dt.toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit',hour12:true});
  }
  return raw;
}
function fmtDateTime(ts){
  if(!ts) return '';
  const date=new Date(ts);
  if(Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-IN',{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
}
function formatEventLocation(location){
  const raw=String(location||'').trim();
  if(!raw) return '';
  const parts=raw
    .split(',')
    .map(part=>part.replace(/\b\d{6}\b/g,'').trim())
    .filter(Boolean)
    .filter(part=>part.toLowerCase()!=='india');
  if(parts.length>=2) return `${parts[parts.length-2]}, ${parts[parts.length-1]}`;
  return parts[0]||raw;
}
function toTimeInputValue(timeStr){
  const raw=String(timeStr||'').trim();
  if(!raw) return '';
  if(/^\d{2}:\d{2}$/.test(raw)) return raw;
  const match12=raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if(match12){
    let hours=parseInt(match12[1],10)%12;
    const minutes=match12[2];
    if(match12[3].toUpperCase()==='PM') hours+=12;
    return `${String(hours).padStart(2,'0')}:${minutes}`;
  }
  return '';
}
function fmtVal(v){
  if(v===null||v===undefined||v===''||isNaN(v))return '—';
  const amount=Number(v);
  const abs=Math.abs(amount);
  const currency=currentCurrencyMeta();
  if(currency.code==='INR' && abs>1000000000)return `${currency.symbol}100Cr+`;
  const formatCompact=(value,suffix)=>{
    const rounded=value>=100?Math.round(value):Math.round(value*10)/10;
    const text=Number.isInteger(rounded)?String(rounded):rounded.toFixed(1).replace(/\.0$/,'');
    return `${currency.symbol}${text}${suffix}`;
  };
  if(currency.code==='INR'){
    if(abs>=10000000)return formatCompact(amount/10000000,'Cr');
    if(abs>=100000)return formatCompact(amount/100000,'L');
    return currency.symbol+amount.toLocaleString(currency.locale);
  }
  if(abs>=1000000){
    return new Intl.NumberFormat(currency.locale,{style:'currency',currency:currency.code,notation:'compact',maximumFractionDigits:1}).format(amount);
  }
  return new Intl.NumberFormat(currency.locale,{style:'currency',currency:currency.code,maximumFractionDigits:0}).format(amount);
}
function initials(first,last){return((first||'')[0]||(last||'')[0]||'?').toUpperCase()+((last||'')[0]||'').toUpperCase()}
function avStyle(id){const i=Math.abs(id.charCodeAt?[...id].reduce((a,c)=>a+c.charCodeAt(0),0):0)%6;return`background:${AV_BG[i]};color:${AV_C[i]}`}
function normalizeEmailValue(email){return(email||'').trim().toLowerCase()}
function normalizePhoneValue(phone){return(phone||'').replace(/\D/g,'')}
function limitPhoneDigits(input){
  if(!input) return;
  const raw=input.value||'';
  let digits=0;
  let out='';
  for(const ch of raw){
    if(/\d/.test(ch)){
      if(digits>=15) continue;
      digits++;
      out+=ch;
      continue;
    }
    if(ch==='+' && out.length===0){
      out+=ch;
      continue;
    }
    if((ch===' ' || ch==='-' || ch==='(' || ch===')') && digits<15){
      out+=ch;
    }
  }
  input.value=out;
}
function fullGuestName(guest){return`${guest?.first||''} ${guest?.last||''}`.trim()}
function normalizeMasterGuestCandidate(candidate){
  return {
    id: candidate.id || uid(),
    first: (candidate.first||'').trim(),
    last: (candidate.last||'').trim(),
    email: normalizeEmailValue(candidate.email||''),
    contact: (candidate.contact||'').trim(),
    notes: (candidate.notes||'').trim(),
    group: (candidate.group||candidate.table||'').trim(),
    createdAt: candidate.createdAt || Date.now()
  };
}
function summarizeMasterGuest(guest){
  const parts=[fullGuestName(guest)||'Unknown guest'];
  if(guest.email) parts.push(guest.email);
  if(guest.contact) parts.push(guest.contact);
  if(guest.group) parts.push(`Group: ${guest.group}`);
  if(guest.notes) parts.push(guest.notes);
  return parts.join(' · ');
}
function findMasterGuestMatch(candidate){
  const normalized=normalizeMasterGuestCandidate(candidate);
  if(normalized.email){
    const existing=DB.masterGuests.find(item=>normalizeEmailValue(item.email)===normalized.email);
    return existing?{ type:'email', existing, candidate:normalized }:null;
  }
  const phone=normalizePhoneValue(normalized.contact);
  if(phone){
    const existing=DB.masterGuests.find(item=>normalizePhoneValue(item.contact)===phone);
    return existing?{ type:'phone', existing, candidate:normalized }:null;
  }
  const name=fullGuestName(normalized).toLowerCase();
  if(name){
    const existing=DB.masterGuests.find(item=>fullGuestName(item).toLowerCase()===name);
    return existing?{ type:'name', existing, candidate:normalized }:null;
  }
  return null;
}
function mergeMasterGuest(existing,candidate){
  existing.first=candidate.first||existing.first||'';
  existing.last=candidate.last||existing.last||'';
  existing.email=candidate.email||existing.email||'';
  existing.contact=candidate.contact||existing.contact||'';
  existing.notes=candidate.notes||existing.notes||'';
  existing.group=candidate.group||existing.group||'';
  return existing;
}
function saveMasterGuestRecord(candidate,{forceNew=false, updateId=null}={}){
  const normalized=normalizeMasterGuestCandidate(candidate);
  if(!normalized.first) return { saved:false, reason:'missing_name' };
  if(updateId){
    const existing=DB.masterGuests.find(item=>item.id===updateId);
    if(!existing) return { saved:false, reason:'missing_existing' };
    mergeMasterGuest(existing, normalized);
    DB.masterGuests.sort((a,b)=>fullGuestName(a).localeCompare(fullGuestName(b)));
    save();
    return { saved:true, mode:'updated', guest:existing };
  }
  if(forceNew){
    DB.masterGuests.push(normalized);
    DB.masterGuests.sort((a,b)=>fullGuestName(a).localeCompare(fullGuestName(b)));
    save();
    return { saved:true, mode:'created', guest:normalized };
  }
  const existing=DB.masterGuests.find(item=>isMasterGuestDuplicate(normalized,item));
  if(existing) return { saved:false, reason:'duplicate', guest:existing };
  DB.masterGuests.push(normalized);
  DB.masterGuests.sort((a,b)=>fullGuestName(a).localeCompare(fullGuestName(b)));
  save();
  return { saved:true, mode:'created', guest:normalized };
}
function openMasterGuestConflictModal({title,sub,candidate,existing,updateLabel='Update Existing',createLabel='Create New Entry'}){
  const titleEl=document.getElementById('master-resolve-title');
  const subEl=document.getElementById('master-resolve-sub');
  const existingEl=document.getElementById('master-resolve-existing');
  const incomingEl=document.getElementById('master-resolve-incoming');
  const updateBtn=document.getElementById('master-resolve-update-btn');
  const createBtn=document.getElementById('master-resolve-create-btn');
  if(titleEl) titleEl.textContent=title;
  if(subEl) subEl.textContent=sub;
  if(existingEl) existingEl.textContent=summarizeMasterGuest(existing);
  if(incomingEl) incomingEl.textContent=summarizeMasterGuest(candidate);
  if(updateBtn) updateBtn.textContent=updateLabel;
  if(createBtn) createBtn.textContent=createLabel;
  return new Promise(resolve=>{
    _masterGuestConflictResolver=resolve;
    openModal('master-guest-resolve');
  });
}
function isMasterGuestDuplicate(candidate, existing){
  const candidateEmail=normalizeEmailValue(candidate.email);
  const existingEmail=normalizeEmailValue(existing.email);
  if(candidateEmail && existingEmail) return candidateEmail===existingEmail;
  const candidateName=fullGuestName(candidate).toLowerCase();
  const existingName=fullGuestName(existing).toLowerCase();
  const candidatePhone=normalizePhoneValue(candidate.contact);
  const existingPhone=normalizePhoneValue(existing.contact);
  if(candidateName && candidateName===existingName && !candidateEmail && !existingEmail && !candidatePhone && !existingPhone){
    return true;
  }
  return false;
}
function addGuestToMasterList(candidate,{silent=false}={}){
  const normalized=normalizeMasterGuestCandidate(candidate);
  if(!normalized.first){
    if(!silent) toast('⚠️ Add at least a first name');
    return { added:false, reason:'missing_name' };
  }
  const result=saveMasterGuestRecord(normalized);
  if(!result.saved){
    if(!silent) toast(result.reason==='duplicate'?'Already in master guest list':'⚠️ Could not save guest');
    return { added:false, reason:result.reason, guest:result.guest };
  }
  if(!silent) toast('Added to master guest list');
  return { added:true, reason:'added', guest:result.guest };
}
function guestMatchesSession(guest,session){
  const email=normalizeEmailValue(session?.email);
  if(!email||!guest)return false;
  return normalizeEmailValue(guest.email)===email||normalizeEmailValue(guest.contact)===email;
}
function getCurrentGuestInvite(eventId){
  const session=Auth.currentSession();
  return DB.guests.find(g=>g.eventId===eventId&&guestMatchesSession(g,session))||null;
}
function getEventGuestsForPicker(){
  return DB.guests
    .filter(g=>g.eventId===DB.activeEvent)
    .sort((a,b)=>`${a.first||''} ${a.last||''}`.localeCompare(`${b.first||''} ${b.last||''}`));
}
function getGroupsForPicker(){
  const groups=new Set();
  DB.guests
    .filter(g=>g.eventId===DB.activeEvent && (g.table||'').trim())
    .forEach(g=>groups.add((g.table||'').trim()));
  DB.masterGuests
    .filter(g=>(g.group||'').trim())
    .forEach(g=>groups.add((g.group||'').trim()));
  return Array.from(groups).sort((a,b)=>a.localeCompare(b));
}
function getPickerElements(kind){
  if(kind==='gift') return { input:document.getElementById('gi-from'), menu:document.getElementById('guest-picker') };
  if(kind==='cash') return { input:document.getElementById('ca-from'), menu:document.getElementById('cash-guest-picker') };
  return { input:document.getElementById('moi-from'), menu:document.getElementById('moi-guest-picker') };
}
function renderGroupPicker(query=''){
  const input=document.getElementById('g-table');
  const menu=document.getElementById('group-picker');
  if(!menu) return;
  const q=(query||'').trim().toLowerCase();
  const groups=getGroupsForPicker().filter(group=>!q || group.toLowerCase().includes(q));
  if(!groups.length){
    menu.innerHTML='<div class="picker-item"><div class="picker-item-name">No matching groups</div><div class="picker-item-sub">Keep typing to create a new group.</div></div>';
    menu.style.display='block';
    return;
  }
  menu.innerHTML=groups.map(group=>{
    const memberCount=DB.guests.filter(g=>g.eventId===DB.activeEvent && (g.table||'').trim()===group).length;
    const sub=memberCount?`${memberCount} guest${memberCount!==1?'s':''} in this event`:'Saved in master guest list';
    return `<div class="picker-item" onclick="App.pickGroup('${encodeURIComponent(group)}')"><div class="picker-item-name">${group}</div><div class="picker-item-sub">${sub}</div></div>`;
  }).join('');
  menu.style.display='block';
  if(input && document.activeElement!==input) input.focus();
}
function renderGuestPicker(kind,query=''){
  const { menu }=getPickerElements(kind);
  if(!menu) return;
  const q=(query||'').trim().toLowerCase();
  const guests=getEventGuestsForPicker().filter(g=>{
    const fullName=`${g.first||''} ${g.last||''}`.trim();
    const email=(g.email||'').trim();
    const phone=(g.contact||'').trim();
    const group=(g.table||'').trim();
    return !q || fullName.toLowerCase().includes(q) || email.toLowerCase().includes(q) || phone.toLowerCase().includes(q) || group.toLowerCase().includes(q);
  });
  if(!guests.length){
    menu.innerHTML='<div class="picker-item"><div class="picker-item-name">No matching guests</div><div class="picker-item-sub">Try a different name, email, phone, or group.</div></div>';
    menu.style.display='block';
    return;
  }
  menu.innerHTML=guests.map(g=>{
    const fullName=`${g.first||''} ${g.last||''}`.trim()||'Unknown guest';
    const sub=(g.email||'').trim() || (g.contact||'').trim() || (g.table||'').trim() || 'No email, phone, or group added';
    return `<div class="picker-item" onclick="App.pickGuest('${kind}','${encodeURIComponent(fullName)}')"><div class="picker-item-name">${fullName}</div><div class="picker-item-sub">${sub}</div></div>`;
  }).join('');
  menu.style.display='block';
}
function showGuestPicker(kind){
  const { input }=getPickerElements(kind);
  renderGuestPicker(kind,input?input.value:'');
}
function filterGuestPicker(kind,query){
  renderGuestPicker(kind,query);
}
function pickGuest(kind,encodedName){
  const { input, menu }=getPickerElements(kind);
  if(input) input.value=decodeURIComponent(encodedName);
  if(menu) menu.style.display='none';
}
function showGroupPicker(){
  const input=document.getElementById('g-table');
  renderGroupPicker(input?input.value:'');
}
function filterGroupPicker(query){
  renderGroupPicker(query);
}
function pickGroup(encodedGroup){
  const input=document.getElementById('g-table');
  const menu=document.getElementById('group-picker');
  if(input) input.value=decodeURIComponent(encodedGroup);
  if(menu) menu.style.display='none';
}
function rememberLastGuestGroup(groupName){
  const group=(groupName||'').trim();
  if(!group) return;
  DB.settings.lastGuestGroup=group;
  save();
}
function hideAllGuestPickers(){
  ['guest-picker','cash-guest-picker','moi-guest-picker','group-picker'].forEach(id=>{
    const menu=document.getElementById(id);
    if(menu) menu.style.display='none';
  });
}
document.addEventListener('click',(event)=>{
  if(!event.target.closest('.g-swipe-wrap')) closeOpenGuestSwipe();
  if(!event.target.closest('.picker-wrap')) hideAllGuestPickers();
});
function roomRequestTypeLabel(type){
  return type==='needs_room'?'Room needed':type==='no_room_needed'?'No room needed':'Not submitted';
}
function roomRequestStatusLabel(status){
  return status==='fulfilled'?'Request handled':status==='pending'?'Awaiting coordinator':'No request';
}
function getGuestRoomAssignments(guest){
  if(!guest) return [];
  if(Array.isArray(guest.roomAssignments)){
    return guest.roomAssignments.filter(r=>r&&r.loc&&r.no);
  }
  return guest.roomLoc&&guest.roomNo?[{loc:guest.roomLoc,no:guest.roomNo}]:[];
}
function syncGuestPrimaryRoom(guest){
  const rooms=getGuestRoomAssignments(guest);
  if(rooms.length){
    guest.roomAssignments=rooms;
    guest.roomLoc=rooms[0].loc;
    guest.roomNo=rooms[0].no;
  } else {
    guest.roomAssignments=[];
    guest.roomLoc='';
    guest.roomNo='';
  }
  return guest;
}
function formatGuestRooms(guest){
  const rooms=getGuestRoomAssignments(guest);
  if(!rooms.length) return 'Not assigned yet';
  return rooms.map(room=>`${room.loc} · Room ${room.no}`).join(', ');
}
function myManagedEvents(){
  return DB.events.filter(ev=>!ev._isGuestOnly);
}
function renderCreateEventState(title,message){
  return `<div class="empty"><div class="empty-ico" style="color:var(--rose-d)">${uiIcon('event',42)}</div><div class="empty-t">${title}</div><div class="empty-s">${message}</div></div><div class="floating-stack"><button class="floating-bubble floating-bubble-primary" type="button" title="Add event" aria-label="Add event" onclick="App.openAddEvent()">${uiIcon('event',18)}<span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button></div>`;
}

function setEventEditorMode(isOrganizerMode){
  const organizerOnlySections=[
    'ev-name-section',
    'ev-datetime-section',
    'ev-location-section',
    'ev-color-section',
    'ev-food-section',
    'ev-room-request-section',
    'ev-feedback-section'
  ];
  organizerOnlySections.forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.style.display=isOrganizerMode?'':'none';
  });
  const roomSection=document.getElementById('ev-room-section');
  if(roomSection) roomSection.style.display='';
  const deleteBtn=document.getElementById('del-event-btn');
  if(deleteBtn && !isOrganizerMode) deleteBtn.style.display='none';
  const topSaveBtn=document.querySelector('#mo-add-event .m-top-save');
  if(topSaveBtn) topSaveBtn.textContent=isOrganizerMode?'Save':'Save Rooms';
  const bottomSaveBtn=document.getElementById('ev-bottom-save-btn');
  if(bottomSaveBtn) bottomSaveBtn.textContent=isOrganizerMode?'Save Event':'Save Rooms';
}

function addGuestRoomAssignment(guest,loc,no){
  const rooms=getGuestRoomAssignments(guest);
  if(!rooms.some(room=>room.loc===loc&&room.no===no)) rooms.push({loc,no});
  guest.roomAssignments=rooms;
  syncGuestPrimaryRoom(guest);
}
function removeGuestRoomAssignment(guest,loc,no){
  guest.roomAssignments=getGuestRoomAssignments(guest).filter(room=>!(room.loc===loc&&room.no===no));
  syncGuestPrimaryRoom(guest);
}
function recomputeGuestRoomRequestStatus(guest){
  const assigned=getGuestRoomAssignments(guest).length;
  const requested=Math.max(1,parseInt(guest.requestedRoomCount)||1);
  if(guest.roomRequestType==='needs_room'){
    guest.roomRequestStatus=assigned>=requested?'fulfilled':'pending';
  } else if(guest.roomRequestType==='no_room_needed'){
    guest.roomRequestStatus='fulfilled';
  } else {
    guest.roomRequestStatus=assigned?'fulfilled':'none';
  }
}
function ensureGuestRequestDefaults(guest){
  if(!guest)return guest;
  syncGuestPrimaryRoom(guest);
  if(!guest.roomRequestType) guest.roomRequestType='undecided';
  if(guest.requestedRoomCount==null) guest.requestedRoomCount=Math.max(getGuestRoomAssignments(guest).length,1);
  if(guest.requestedStayCount==null) guest.requestedStayCount=guest.party||1;
  if(!('roomRequestNote' in guest)) guest.roomRequestNote='';
  if(!guest.roomRequestStatus) recomputeGuestRoomRequestStatus(guest);
  return guest;
}

function isRoomRequestEnabled(ev){
  return !!ev && ev.roomRequestsEnabled!==false;
}

function isFeedbackEnabled(ev){
  return !!ev && ev.feedbackEnabled===true;
}

function normalizeEventMenus(foodMenus){
  return Array.isArray(foodMenus)
    ? foodMenus
        .map(menu=>({
          title:(menu?.title||'').trim(),
          items:(menu?.items||'').trim()
        }))
        .filter(menu=>menu.title||menu.items)
    : [];
}

function normalizeEventContacts(eventContacts){
  return Array.isArray(eventContacts)
    ? eventContacts
        .map(contact=>({
          name:(contact?.name||contact?.role||'').trim(),
          phone:String(contact?.phone||'').replace(/\D/g,'').slice(0,15),
        }))
        .filter(contact=>contact.name||contact.phone)
    : [];
}

function normalizeMenuItems(items){
  return String(items||'')
    .split(/\r?\n/)
    .map(item=>item.trim())
    .filter(Boolean);
}

function formatPhoneNumber(phone){
  const digits=String(phone||'').replace(/\D/g,'');
  if(!digits) return '';
  if(digits.length===10) return `${digits.slice(0,5)} ${digits.slice(5)}`;
  if(digits.length>10) return `+${digits.slice(0,digits.length-10)} ${digits.slice(-10,-5)} ${digits.slice(-5)}`;
  return digits;
}

function buildEventContactShareText(ev, contact){
  const lines=[
    ev?.name ? `${ev.name} - Event Contact` : 'Event Contact',
    contact.name ? `Name: ${contact.name}` : '',
    contact.phone ? `Phone: ${formatPhoneNumber(contact.phone)}` : ''
  ].filter(Boolean);
  return lines.join('\n');
}

function getEventContactForAction(eventId,index){
  if(eventId && _editingEventContactsId===eventId && _eventContactsTemp[index]) return normalizeEventContacts(_eventContactsTemp)[index];
  const ev=DB.events.find(item=>item.id===eventId);
  return normalizeEventContacts(ev?.eventContacts)[index];
}

function getFoodMenuLikeKey(menu, itemText){
  return `${(menu?.title||'menu').trim().toLowerCase()}::${String(itemText||'').trim().toLowerCase()}`;
}

function getFoodMenuSectionLikeKey(menu){
  return `${(menu?.title||'menu').trim().toLowerCase()}::section`;
}

function ensureGuestFoodLikesDefaults(guest){
  if(!guest) return guest;
  if(!Array.isArray(guest.foodMenuLikes)) guest.foodMenuLikes=[];
  return guest;
}

function getEventFoodLikeCounts(eventId){
  const counts=new Map();
  DB.guests
    .filter(guest=>guest.eventId===eventId)
    .forEach(guest=>{
      ensureGuestFoodLikesDefaults(guest);
      const uniqueLikes=new Set((guest.foodMenuLikes||[]).map(item=>String(item)));
      uniqueLikes.forEach(key=>counts.set(key,(counts.get(key)||0)+1));
    });
  return counts;
}

function ensureGuestFeedbackDefaults(guest){
  if(!guest) return guest;
  if(guest.feedbackFoodRating==null) guest.feedbackFoodRating=0;
  if(guest.feedbackEventRating==null) guest.feedbackEventRating=0;
  if(guest.feedbackRoomRating==null) guest.feedbackRoomRating=0;
  if(!('feedbackMessage' in guest)) guest.feedbackMessage='';
  return guest;
}

function renderFeedbackStars(value){
  const current=Math.max(0,Math.min(5,parseInt(value)||0));
  return `${current}/5 ${'&#9733;'.repeat(current)}${'&#9734;'.repeat(5-current)}`;
}

function renderGuestFeedbackSection(ev, guest, prefix='gf'){
  ensureGuestFeedbackDefaults(guest);
  const feedbackEnabled=isFeedbackEnabled(ev);
  const canRateRoom=getGuestRoomAssignments(guest).length>0;
  const hasFeedback=!!(guest.feedbackMessage||guest.feedbackUpdatedAt||guest.feedbackFoodRating||guest.feedbackEventRating||guest.feedbackRoomRating);
  const foodRating=Math.max(0,Math.min(5,parseInt(guest.feedbackFoodRating)||0));
  const eventRating=Math.max(0,Math.min(5,parseInt(guest.feedbackEventRating)||0));
  const roomRating=canRateRoom?Math.max(0,Math.min(5,parseInt(guest.feedbackRoomRating)||0)):0;
  const submittedAt=guest.feedbackUpdatedAt?new Date(guest.feedbackUpdatedAt).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):'';
  const starPicker=(field,label,current)=>`<div class="fg" style="margin-bottom:12px">
      <label class="fl">${label}</label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${[1,2,3,4,5].map(val=>`<button type="button" data-feedback-prefix="${prefix}" data-feedback-field="${field}" data-feedback-value="${val}" onclick="App.setGuestFeedbackRating('${field}',${val},'${prefix}')" style="min-width:38px;padding:8px 10px;border-radius:999px;border:1px solid ${current>=val?'var(--gold-d)':'var(--bord)'};background:${current>=val?'var(--gold-l)':'var(--surf)'};color:${current>=val?'var(--gold-d)':'var(--txt3)'};font-size:13px;font-weight:600;cursor:pointer">${val} &#9733;</button>`).join('')}
      </div>
      <input type="hidden" id="${prefix}-${field}" value="${current}" />
    </div>`;
  return `<div class="guest-card anim">
      <div class="guest-card-title">Event Feedback</div>
      <div style="font-size:13px;color:var(--txt2);line-height:1.6;margin-bottom:12px">${feedbackEnabled?'Share your wishes and rate your experience for the organiser.':'Feedback is currently turned off for this event.'}</div>
      ${feedbackEnabled?`${starPicker('food-rating','Food Rating',foodRating)}
      ${starPicker('event-rating','Event Rating',eventRating)}
      ${canRateRoom?starPicker('room-rating','Room Rating',roomRating):`<div class="fg" style="margin-bottom:12px"><label class="fl">Room Rating</label><div style="font-size:12px;color:var(--txt3);line-height:1.6">Room rating becomes available once a room is allocated to you.</div><input type="hidden" id="${prefix}-room-rating" value="0" /></div>`}
      <div class="fg">
        <label class="fl">Wishes and Feedback</label>
        <textarea class="fi" id="${prefix}-message" rows="4" style="resize:vertical" placeholder="Share your wishes, feedback, and suggestions...">${guest.feedbackMessage||''}</textarea>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-p" style="background:var(--sage-d);margin:0" onclick="App.submitGuestFeedback('${prefix}')">Send Feedback</button>
        ${hasFeedback?`<button class="btn-s btn-danger" style="margin:0" onclick="App.clearGuestFeedback()">Remove Feedback</button>`:''}
      </div>`
      : `${hasFeedback?`<div style="font-size:12px;color:var(--txt3);line-height:1.6">Your earlier feedback is saved${submittedAt?` from ${submittedAt}`:''}.</div>`:''}`}
    </div>`;
}

function openGuestFeedbackModal(eventId){
  const targetId=eventId||DB.activeEvent;
  const ev=DB.events.find(e=>e.id===targetId);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Guest feedback not available');return;}
  if(!isFeedbackEnabled(ev)){toast('ℹ️ Feedback is turned off for this event');return;}
  DB.activeEvent=targetId;
  save();
  const me=getCurrentGuestInvite(targetId);
  if(!me){toast('⚠️ Guest record not found');return;}
  ensureGuestFeedbackDefaults(me);
  document.getElementById('gf-title').textContent='Event Feedback';
  document.getElementById('gf-event-name').textContent=ev.name;
  document.getElementById('gf-event-meta').innerHTML=`${ev.date?`${uiIcon('calendar',12)} ${fmtDate(ev.date)}<br>`:''}${ev.time?`${uiIcon('time',12)} ${fmtTime(ev.time)}<br>`:''}${ev.location?`${uiIcon('location',12)} ${formatEventLocation(ev.location)}<br>`:''}${uiIcon('user',12)} ${me.first} ${me.last}`;
  document.getElementById('gf-content').innerHTML=renderGuestFeedbackSection(ev, me, 'gf-modal');
  openModal('guest-feedback');
}

function renderGuestFoodMenuSection(ev, guest, mode='portal'){
  const menus=normalizeEventMenus(ev?.foodMenus);
  if(!menus.length) return '';
  ensureGuestFoodLikesDefaults(guest);
  const likedKeys=new Set((guest.foodMenuLikes||[]).map(item=>String(item)));
  return `<div class="guest-card${mode==='portal'?' anim':''}">
      <div class="guest-card-title">Food Menu</div>
      <div style="font-size:12px;color:var(--txt3);line-height:1.6;margin-bottom:12px">Tap the heart for a whole menu section or for any item you love.</div>
      <div style="display:grid;gap:10px">
        ${menus.map((menu,sectionIdx)=>{
          const items=normalizeMenuItems(menu.items);
          const sectionLiked=likedKeys.has(getFoodMenuSectionLikeKey(menu));
          return `<div style="padding:12px 14px;border-radius:var(--rs);background:var(--surf2);border:1px solid var(--bord2)">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:${items.length?'8px':'0'}">
                <div style="font-size:13px;font-weight:600;color:var(--txt)">${menu.title||'Menu'}</div>
                <button type="button" onclick="App.toggleGuestFoodSectionLike(${sectionIdx},'${ev.id}')" style="flex-shrink:0;min-width:40px;height:34px;border-radius:999px;border:1px solid ${sectionLiked?'var(--rose-d)':'var(--bord)'};background:${sectionLiked?'var(--rose-l)':'var(--surf)'};color:${sectionLiked?'var(--rose-d)':'var(--txt3)'};font-size:15px;font-weight:600;cursor:pointer">${sectionLiked?'♥':'♡'}</button>
              </div>
              ${items.length
                ? `<div style="display:grid;gap:8px">
                    ${items.map((itemText,itemIdx)=>{
                      const liked=likedKeys.has(getFoodMenuLikeKey(menu,itemText));
                      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border-radius:12px;background:var(--surf);border:1px solid ${liked?'rgba(196,99,122,0.25)':'var(--bord2)'}">
                          <div style="font-size:12.5px;color:var(--txt2);line-height:1.5">${itemText}</div>
                          <button type="button" onclick="App.toggleGuestFoodLike(${sectionIdx},${itemIdx},'${ev.id}')" style="flex-shrink:0;min-width:40px;height:34px;border-radius:999px;border:1px solid ${liked?'var(--rose-d)':'var(--bord)'};background:${liked?'var(--rose-l)':'var(--surf)'};color:${liked?'var(--rose-d)':'var(--txt3)'};font-size:15px;font-weight:600;cursor:pointer">${liked?'♥':'♡'}</button>
                        </div>`;
                    }).join('')}
                  </div>`
                : `<div style="font-size:12px;color:var(--txt3);line-height:1.6">Menu details coming soon.</div>`}
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function renderGuestFoodMenuModalContent(eventId){
  const targetId=eventId||DB.activeEvent;
  const ev=DB.events.find(e=>e.id===targetId);
  const me=ensureGuestFoodLikesDefaults(getCurrentGuestInvite(targetId));
  const contentEl=document.getElementById('gm-content');
  if(!ev||!ev._isGuestOnly||!me||!contentEl) return;
  document.getElementById('gm-title').textContent='Food Menu';
  document.getElementById('gm-event-name').textContent=ev.name;
  document.getElementById('gm-event-meta').innerHTML=`${ev.date?`${uiIcon('calendar',12)} ${fmtDate(ev.date)}<br>`:''}${ev.time?`${uiIcon('time',12)} ${fmtTime(ev.time)}<br>`:''}${ev.location?`${uiIcon('location',12)} ${formatEventLocation(ev.location)}<br>`:''}${uiIcon('user',12)} ${me.first} ${me.last}`;
  contentEl.innerHTML=renderGuestFoodMenuSection(ev, me, 'modal');
}

function openGuestFoodMenuModal(eventId){
  const targetId=eventId||DB.activeEvent;
  const ev=DB.events.find(e=>e.id===targetId);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Food menu not available');return;}
  if(!normalizeEventMenus(ev.foodMenus).length){toast('ℹ️ Food menu not added yet');return;}
  DB.activeEvent=targetId;
  save();
  renderGuestFoodMenuModalContent(targetId);
  openModal('guest-menu');
}

let _toastTimer;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>el.classList.remove('show'),2600);
}

function showGuestUndoSnack(name){
  const el=document.getElementById('undo-snack');
  const text=document.getElementById('undo-text');
  if(!el||!text) return;
  text.textContent=`${name} removed`;
  el.classList.add('show');
}

function hideGuestUndoSnack(){
  const el=document.getElementById('undo-snack');
  if(el) el.classList.remove('show');
}

function scheduleGuestUndo(guest){
  if(_guestUndoTimer){
    clearTimeout(_guestUndoTimer);
    _guestUndoTimer=null;
  }
  _guestUndoState={ guest: JSON.parse(JSON.stringify(guest)), eventId: guest.eventId };
  showGuestUndoSnack(fullGuestName(guest)||guest.first||'Guest');
  _guestUndoTimer=setTimeout(()=>{
    _guestUndoState=null;
    _guestUndoTimer=null;
    hideGuestUndoSnack();
  },3000);
}

function undoGuestRemoval(){
  if(!_guestUndoState?.guest) return;
  if(_guestUndoTimer){
    clearTimeout(_guestUndoTimer);
    _guestUndoTimer=null;
  }
  const restoredGuest=_guestUndoState.guest;
  if(!DB.guests.some(item=>item.id===restoredGuest.id)) DB.guests.push(restoredGuest);
  _guestUndoState=null;
  hideGuestUndoSnack();
  save();
  syncActiveEventData();
  render();
  toast(`${restoredGuest.first||'Guest'} restored`);
}

// ═══════════════════════════════════════════════
// MODAL SYSTEM
// ═══════════════════════════════════════════════
let _editing={event:null,guest:null,gift:null};
let _editingMasterGuest=null;
let _roomLocsTemp=[];
let _roomConfigEventId='';
let _eventMenusTemp=[];
let _eventFoodMenuModalEventId='';
let _eventContactsTemp=[];
let _editingEventContactsId='';
let _eventContactsEditMode=false;
let _eventContactActionEventId='';
let _eventContactActionIndex=-1;
let _teamEventId='';
let _eventMenuEditorDisabled=false;
let _giftPhotoData=null;
let _showPastEvents=false;
let _suppressOverlayPop=false;

function getOpenModalIds(){
  return Array.from(document.querySelectorAll('.mo.open'))
    .map(el=>el.id.replace(/^mo-/,''));
}

function pushOverlayState(type,id){
  if(!window.history || !window.history.pushState) return;
  window.history.pushState({ tab:_tab, overlay:{ type, id } }, '', window.location.href);
}

function openModal(id,{fromPop=false}={}){
  document.getElementById('mo-'+id)?.classList.add('open');
  if(!fromPop) pushOverlayState('modal', id);
}

function closeModal(id,{fromPop=false}={}){
  document.getElementById('mo-'+id)?.classList.remove('open');
  if(id==='event-contacts'){
    _editingEventContactsId='';
    _eventContactsEditMode=false;
  }
  if(id==='room-config'){
    _roomConfigEventId='';
  }
  if(id==='event-food-menu'){
    _eventFoodMenuModalEventId='';
  }
  if(id==='event-contact-actions'){
    _eventContactActionEventId='';
    _eventContactActionIndex=-1;
  }
  if(id==='master-guest-resolve' && _masterGuestConflictResolver){
    const resolver=_masterGuestConflictResolver;
    _masterGuestConflictResolver=null;
    resolver('cancel');
  }
  if(!fromPop && window.history && window.history.state?.overlay?.type==='modal' && window.history.state.overlay.id===id){
    _suppressOverlayPop=true;
    window.history.back();
  }
}

document.querySelectorAll('.mo').forEach(el=>{
  el.addEventListener('click',e=>{
    if(e.target===el) closeModal(el.id.replace(/^mo-/,''));
  });
});

// ═══════════════════════════════════════════════
// CONFIRM SYSTEM
// ═══════════════════════════════════════════════
let _confirmCb=null;
function openConfirm(title,sub,cb){
  document.getElementById('confirm-t').textContent=title;
  document.getElementById('confirm-s').textContent=sub;
  const confirmOk=document.getElementById('confirm-ok');
  if(confirmOk){
    confirmOk.textContent='Delete';
    confirmOk.style.background='var(--rose-d)';
    confirmOk.style.color='white';
    confirmOk.style.borderColor='var(--rose-d)';
  }
  _confirmCb=cb;
  document.getElementById('confirm-ok').onclick=()=>{
    const confirmCb=_confirmCb;
    closeConfirm();
    confirmCb&&confirmCb();
  };
  document.getElementById('confirm-overlay').classList.add('open');
  pushOverlayState('confirm','confirm');
}
function closeConfirm({fromPop=false}={}){
  document.getElementById('confirm-overlay').classList.remove('open');
  const confirmOk=document.getElementById('confirm-ok');
  if(confirmOk){
    confirmOk.textContent='Delete';
    confirmOk.style.background='var(--rose-d)';
    confirmOk.style.color='white';
    confirmOk.style.borderColor='var(--rose-d)';
  }
  if(!fromPop && window.history && window.history.state?.overlay?.type==='confirm'){
    _suppressOverlayPop=true;
    window.history.back();
  }
}
document.getElementById('confirm-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('confirm-overlay'))closeConfirm()});

// ═══════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════
let _tab='events';
let _guestFilter='all';
let _guestSearch='';
let _exportEventId=null;
let _showPastPickerEvents=false;
let _masterGuestMode='manage';
let _masterGuestSearch='';
let _groupInviteSearch='';
let _masterGuestConflictResolver=null;
let _masterGuestSelectedIds=new Set();
let _incomingMasterGuestShares=[];
let _sentMasterGuestShares=[];
let _guestSwipeTapBlockUntil=0;
let _guestSwipeOpenId=null;
let _guestSwipeActionGuestId=null;
let _directRoomAssignGuestId='';
let _guestListEditMode=false;
let _guestUndoState=null;
let _guestUndoTimer=null;
let _preserveGuestSearchFocus=false;
let _showScrollTop=false;

function setMasterGuestShareState(incoming, sent){
  if(Array.isArray(incoming)) _incomingMasterGuestShares=incoming;
  if(Array.isArray(sent)) _sentMasterGuestShares=sent;
  if(Array.isArray(incoming)) NotificationCenter.evaluateSharedGuestLists(_incomingMasterGuestShares);
  if(_tab==='settings') renderSettings();
  if(document.getElementById('mo-master-guests')?.classList.contains('open')) renderMasterGuestList();
  if(document.getElementById('mo-master-guest-shares')?.classList.contains('open')) renderMasterGuestShares();
}

const GUEST_SWIPE_RIGHT_ACTION=88;
const GUEST_SWIPE_LEFT_REVEAL=196;

function syncTabHistory(tab,{fromPop=false}={}) {
  if (fromPop || !window.history || !window.history.replaceState) return;
  const currentStateTab = window.history.state && window.history.state.tab;
  if (tab === 'events') {
    window.history.replaceState({ tab: 'events' }, '', window.location.href);
    return;
  }
  if (_tab === 'events' || !currentStateTab || currentStateTab === 'events') {
    window.history.pushState({ tab }, '', window.location.href);
  } else {
    window.history.replaceState({ tab }, '', window.location.href);
  }
}

function switchTab(tab, options={}) {
  const ev = DB.events.find(e => e.id === DB.activeEvent);
  const isGuestOnly = ev && ev._isGuestOnly;

  if (isGuestOnly && tab !== 'events' && tab !== 'rooms' && tab !== 'settings') {
    tab = 'events';
  }

  syncTabHistory(tab, options);
  _tab = tab;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  
  const scr = document.getElementById('scr-' + tab);
  if (scr) scr.classList.add('active');
  const tabEl = document.getElementById('tab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  
  const mainScroll = document.getElementById('main-scroll');
  if (mainScroll) mainScroll.scrollTop = 0;
  _showScrollTop=false;
  
  const navTabs = document.querySelector('.tabs');
  if (navTabs) navTabs.style.display = 'flex';
  const teamBtn = document.getElementById('hdr-team-btn');
  if (teamBtn) teamBtn.style.display = isGuestOnly ? 'none' : 'block';
  
  render();
}

function resetGuestSwipeRow(wrap,{immediate=false}={}){
  if(!wrap) return;
  const card=wrap.querySelector('.g-swipe-card');
  if(!card) return;
  if(immediate) card.style.transition='none';
  card.style.transform='translateX(0px)';
  wrap.dataset.swipeOpen='false';
  if(_guestSwipeOpenId===wrap.dataset.guestId) _guestSwipeOpenId=null;
  if(immediate){
    requestAnimationFrame(()=>{ card.style.transition=''; });
  }
}

function closeOpenGuestSwipe(exceptId=''){
  document.querySelectorAll('.g-swipe-wrap[data-swipe-open="true"]').forEach(wrap=>{
    if(exceptId && wrap.dataset.guestId===exceptId) return;
    resetGuestSwipeRow(wrap);
  });
}

function handleGuestRowTap(event,id){
  if(Date.now()<_guestSwipeTapBlockUntil){
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  openGuestDetail(id);
}

function applyLastGuestGroup(guestId){
  const guest=DB.guests.find(item=>item.id===guestId);
  const group=(DB.settings.lastGuestGroup||'').trim();
  if(!guest){toast('⚠️ Guest not found');return;}
  if(!group){toast('⚠️ No recently used group found');return;}
  if((guest.table||'').trim()===group){toast(`${guest.first} is already in ${group}`);return;}
  guest.table=group;
  rememberLastGuestGroup(group);
  save();syncActiveEventData();renderGuests();
  toast(`${guest.first} added to ${group}`);
}

function swipeAllocateRoom(guestId){
  const targetId=guestId||_guestSwipeActionGuestId;
  closeOpenGuestSwipe();
  closeModal('guest-swipe-actions');
  prepareGuestRoomAssignment(targetId,{silent:true,directAssign:true});
}

function openAddGiftForGuest(guestId){
  if(!Auth.isOrganizer(DB.activeEvent)){toast('⚠️ Only Organisers can add gifts');return;}
  const guest=DB.guests.find(item=>item.id===guestId);
  if(!guest){toast('⚠️ Guest not found');return;}
  closeOpenGuestSwipe();
  openAddGift();
  document.getElementById('gi-from').value=fullGuestName(guest)||guest.first||'';
}

function swipeAddGift(guestId){
  const targetId=guestId||_guestSwipeActionGuestId;
  closeModal('guest-swipe-actions');
  openAddGiftForGuest(targetId);
}

function openAddCashGiftForGuest(guestId){
  if(!Auth.isCash(DB.activeEvent)){toast('⚠️ Only Organisers or Cash Collectors can add cash gifts');return;}
  const guest=DB.guests.find(item=>item.id===guestId);
  if(!guest){toast('⚠️ Guest not found');return;}
  closeOpenGuestSwipe();
  openAddMoi();
  document.getElementById('moi-from').value=fullGuestName(guest)||guest.first||'';
}

function swipeAddCashGift(guestId){
  const targetId=guestId||_guestSwipeActionGuestId;
  closeModal('guest-swipe-actions');
  openAddCashGiftForGuest(targetId);
}

function openGuestSwipeActions(guestId){
  const guest=DB.guests.find(item=>item.id===guestId);
  if(!guest){toast('⚠️ Guest not found');return;}
  _guestSwipeActionGuestId=guestId;
  const sub=document.getElementById('guest-swipe-sub');
  if(sub) sub.textContent=`Choose what you want to do for ${fullGuestName(guest)||guest.first||'this guest'}.`;
  const role=Auth.currentRole(DB.activeEvent);
  const allocateBtn=document.getElementById('guest-swipe-allocate-btn');
  const giftBtn=document.getElementById('guest-swipe-gift-btn');
  const cashBtn=document.getElementById('guest-swipe-cash-btn');
  const giftRow=document.getElementById('guest-swipe-gift-row');
  const canAllocate=role==='organizer'||role==='room';
  const canAddGift=role==='organizer';
  const canAddCashGift=role==='organizer'||role==='cash';
  if(allocateBtn) allocateBtn.style.display=canAllocate?'block':'none';
  if(giftBtn) giftBtn.style.display=canAddGift?'block':'none';
  if(cashBtn) cashBtn.style.display=canAddCashGift?'block':'none';
  if(giftRow) giftRow.style.display=(canAddGift||canAddCashGift)?'flex':'none';
  if(!canAllocate && !canAddGift && !canAddCashGift){
    toast('⚠️ No guest actions available for your role');
    return;
  }
  openModal('guest-swipe-actions');
}

function initGuestSwipeRows(){
  const wraps=document.querySelectorAll('.g-swipe-wrap[data-guest-id]');
  wraps.forEach(wrap=>{
    if(wrap.dataset.swipeBound==='true') return;
    wrap.dataset.swipeBound='true';
    const card=wrap.querySelector('.g-swipe-card');
    if(!card) return;
    let startX=0;
    let startY=0;
    let deltaX=0;
    let tracking=false;
    let horizontal=false;
    let activePointerId=null;

    const beginSwipe=(clientX,clientY)=>{
      closeOpenGuestSwipe(wrap.dataset.guestId);
      startX=clientX;
      startY=clientY;
      deltaX=0;
      tracking=true;
      horizontal=false;
      card.style.transition='none';
    };

    const moveSwipe=(clientX,clientY,event)=>{
      if(!tracking) return;
      const dx=clientX-startX;
      const dy=clientY-startY;
      if(!horizontal){
        if(Math.abs(dx)<8) return;
        if(Math.abs(dx)<=Math.abs(dy)) { tracking=false; card.style.transition=''; return; }
        horizontal=true;
      }
      if(event?.cancelable) event.preventDefault();
      deltaX=Math.max(-GUEST_SWIPE_LEFT_REVEAL, Math.min(GUEST_SWIPE_RIGHT_ACTION, dx));
      card.style.transform=`translateX(${deltaX}px)`;
    };

    const finishSwipe=()=>{
      if(!tracking && !horizontal){ card.style.transition=''; return; }
      tracking=false;
      horizontal=false;
      activePointerId=null;
      card.style.transition='';
      if(deltaX>=64){
        _guestSwipeTapBlockUntil=Date.now()+250;
        resetGuestSwipeRow(wrap);
        applyLastGuestGroup(wrap.dataset.guestId);
        return;
      }
      if(deltaX<=-72){
        _guestSwipeTapBlockUntil=Date.now()+250;
        resetGuestSwipeRow(wrap);
        openGuestSwipeActions(wrap.dataset.guestId);
        return;
      }
      resetGuestSwipeRow(wrap);
    };

    wrap.addEventListener('touchstart',event=>{
      if(event.touches.length!==1) return;
      const touch=event.touches[0];
      beginSwipe(touch.clientX,touch.clientY);
    },{passive:true});
    wrap.addEventListener('touchmove',event=>{
      if(event.touches.length!==1) return;
      const touch=event.touches[0];
      moveSwipe(touch.clientX,touch.clientY,event);
    },{passive:false});
    wrap.addEventListener('touchend',finishSwipe,{passive:true});
    wrap.addEventListener('touchcancel',finishSwipe,{passive:true});

    wrap.addEventListener('pointerdown',event=>{
      if(event.pointerType==='mouse') return;
      activePointerId=event.pointerId;
      beginSwipe(event.clientX,event.clientY);
    });
    wrap.addEventListener('pointermove',event=>{
      if(event.pointerType==='mouse') return;
      if(activePointerId!==event.pointerId) return;
      moveSwipe(event.clientX,event.clientY,event);
    });
    wrap.addEventListener('pointerup',event=>{
      if(event.pointerType==='mouse') return;
      if(activePointerId!==event.pointerId) return;
      finishSwipe();
    });
    wrap.addEventListener('pointercancel',event=>{
      if(event.pointerType==='mouse') return;
      if(activePointerId!==event.pointerId) return;
      finishSwipe();
    });
  });
}

window.addEventListener('popstate', (event) => {
  if(_suppressOverlayPop){
    _suppressOverlayPop=false;
    return;
  }
  const openModals=getOpenModalIds();
  if(document.getElementById('confirm-overlay')?.classList.contains('open')){
    closeConfirm({fromPop:true});
    return;
  }
  if(openModals.length){
    closeModal(openModals[openModals.length-1], {fromPop:true});
    return;
  }
  const nextTab = event.state && event.state.tab ? event.state.tab : 'events';
  switchTab(nextTab, { fromPop: true });
});

// ═══════════════════════════════════════════════
// EVENTS SCREEN
// ═══════════════════════════════════════════════
function renderEvents(){
  const el=document.getElementById('scr-events');
  const sess=Auth.currentSession();
  const getRoomStats=eventId=>{
    const eventGuests=DB.guests.filter(g=>g.eventId===eventId);
    const bookedRooms=eventGuests.reduce((count,guest)=>count+getGuestRoomAssignments(guest).length,0);
    const occupiedRooms=new Set(eventGuests.flatMap(guest=>getGuestRoomAssignments(guest).map(room=>`${room.loc}||${room.no}`))).size;
    return { bookedRooms, occupiedRooms };
  };
  // Only show events where the current user is a team member
  const accessibleEvents=DB.events.filter(ev=>{
    if (ev._isGuestOnly) return true;
    const team=Cloud.hydrateTeamForSession(Auth.getTeam(ev.id), sess);
    return team.some(m=>m.userId===sess?.id || ((m.email||'').trim().toLowerCase()===(sess?.email||'').trim().toLowerCase()));
  });
  const upcomingEvents=accessibleEvents.filter(ev=>{
    const days=daysUntil(ev.date);
    return days===null || days>=0;
  });
  const pastEvents=accessibleEvents.filter(ev=>{
    const days=daysUntil(ev.date);
    return days!==null && days<0;
  });
  const myEvents=_showPastEvents ? [...upcomingEvents, ...pastEvents] : upcomingEvents;
  if(accessibleEvents.length===0){
    el.innerHTML=`<div class="no-events">
      <div class="no-events-ico" style="color:var(--rose-d)">${uiIcon('event',44)}</div>
      <div class="no-events-t">Welcome to eventise!</div>
      <p class="no-events-s">Manage guest lists and track gifts for all your special events in one beautiful place.</p>
    </div><div class="floating-stack"><button class="floating-bubble floating-bubble-primary" type="button" title="Add event" aria-label="Add event" onclick="App.openAddEvent()">${uiIcon('event',18)}<span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button></div>`;
    return;
  }
  if(myEvents.length===0&&pastEvents.length){
    el.innerHTML=`<div class="no-events">
      <div class="no-events-ico" style="color:var(--txt3)">${uiIcon('calendar',44)}</div>
      <div class="no-events-t">No upcoming events</div>
      <p class="no-events-s">Your past events are still available whenever you need to look back at them.</p>
      <div style="display:flex;justify-content:center;margin-top:10px">
        <button class="fchip" style="padding:8px 16px;font-size:12.5px" onclick="App.togglePastEvents(true)">View Past Events</button>
      </div>
    </div>`;
    return;
  }
  // Ensure activeEvent is one the user can see; if not, reset it
  if(DB.activeEvent&&!myEvents.find(e=>e.id===DB.activeEvent)){
    DB.activeEvent=myEvents[0]?.id||null;
    save();
  }
  // Dashboard hero for active event
  const ae=myEvents.find(e=>e.id===DB.activeEvent)||myEvents[0];
  let heroHtml='';
  if(ae){
    const gc=DB.guests.filter(g=>g.eventId===ae.id);
    const {bookedRooms,occupiedRooms}=getRoomStats(ae.id);
    const days=daysUntil(ae.date);
    heroHtml=`<div class="dash-hero anim" onclick="${ae._isGuestOnly?(isRoomRequestEnabled(ae)?`App.setActive('${ae.id}');App.openGuestRequestModal('${ae.id}')`:`App.setActive('${ae.id}');App.switchTab('rooms')`):`App.setActive('${ae.id}');App.switchTab('guests')`}">
      <div class="dash-hero-title" style="display:flex;align-items:center;justify-content:space-between;gap:10px">${ae.name}${Auth.isOrganizer(ae.id)?`<button class="g-edit" type="button" style="flex-shrink:0;background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.22);color:#fff" onclick="event.stopPropagation();App.openEditEvent('${ae.id}')">${uiIcon('edit',14)}</button>`:''}</div>
      <div class="dash-hero-stats">
        ${ae._isGuestOnly ? `<div class="dash-stat"><span class="dash-stat-l">Invitation Access</span></div>` : 
        `<div class="dash-stat"><span class="dash-stat-n">${gc.length}</span><span class="dash-stat-l">Guests</span></div>
        <div class="dash-stat"><span class="dash-stat-n">${bookedRooms}/${occupiedRooms}</span><span class="dash-stat-l">Rooms Booked / Occupied</span></div>`}
      </div>
      ${days!==null?`<div class="dash-cd">${days>0?days+' days away':days===0?'Today':'Past event'}</div>`:''}
      ${ae._isGuestOnly?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px" onclick="event.stopPropagation()">
        ${normalizeEventMenus(ae.foodMenus).length?`<button class="ev-btn" onclick="App.setActive('${ae.id}');App.openGuestFoodMenuModal('${ae.id}')">Food Menu</button>`:''}
        <button class="ev-btn" onclick="App.setActive('${ae.id}');${isRoomRequestEnabled(ae)?`App.openGuestRequestModal('${ae.id}')`:`App.switchTab('rooms')`}">${isRoomRequestEnabled(ae)?'Request Room':'View Rooms'}</button>
        ${isFeedbackEnabled(ae)?`<button class="ev-btn" onclick="App.setActive('${ae.id}');App.openGuestFeedbackModal('${ae.id}')">Feedback</button>`:''}
      </div>`:''}
    </div>`;
  }
  const cards=myEvents.map(ev=>{
    const gc=DB.guests.filter(g=>g.eventId===ev.id);
    const {bookedRooms,occupiedRooms}=getRoomStats(ev.id);
    const days=daysUntil(ev.date);
    const isAct=ev.id===DB.activeEvent;
    const col=COLORS[ev.color]||COLORS.rose;
    return`<div class="ev-card anim ${isAct?'':''}">
      <div class="ev-accent" style="background:${col.accent}"></div>
      <div class="ev-body">
        <div class="ev-top">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
            <div class="ev-name" style="margin:0;flex:1;min-width:0">${ev.name}</div>
            ${Auth.isOrganizer(ev.id)?`<button class="g-edit" type="button" title="Edit event" aria-label="Edit event" onclick="event.stopPropagation();App.openEditEvent('${ev.id}')">${uiIcon('edit',14)}</button>`:''}
          </div>
        </div>
        <div class="ev-meta">
          ${ev.date?`<span class="ev-meta-item">${uiIcon('calendar',12)} ${fmtDate(ev.date)}</span>`:''}
          ${ev.time?`<span class="ev-meta-item">${uiIcon('time',12)} ${fmtTime(ev.time)}</span>`:''}
          ${ev.location?`<span class="ev-meta-item"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" style="color:inherit;text-decoration:none;display:flex;align-items:center;gap:4px" onclick="event.stopPropagation()">${uiIcon('location',12)} ${formatEventLocation(ev.location)}</a></span>`:''}
        </div>
        <div class="ev-stats">
          ${ev._isGuestOnly ? `<div class="ev-stat"><span class="ev-stat-l">My Invitation Access</span></div>` : 
          `<div class="ev-stat"><span class="ev-stat-n">${gc.length}</span><span class="ev-stat-l">Guests</span></div>
          <div class="ev-stat"><span class="ev-stat-n">${bookedRooms}</span><span class="ev-stat-l">Rooms Booked</span></div>
          <div class="ev-stat"><span class="ev-stat-n">${occupiedRooms}</span><span class="ev-stat-l">Rooms Occupied</span></div>`}
        </div>
        <div class="ev-footer">
          ${days!==null?`<span class="countdown" style="background:${col.accent}">${days>0?days+' days':days===0?'Today':'Past'}</span>`:'<span></span>'}
          <div class="ev-actions">
            ${ev._isGuestOnly
              ?`${normalizeEventMenus(ev.foodMenus).length?`<button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.openGuestFoodMenuModal('${ev.id}')">Food Menu</button>`:''}
            ${isFeedbackEnabled(ev)?`<button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.openGuestFeedbackModal('${ev.id}')">Feedback</button>`:''}
            <button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');${isRoomRequestEnabled(ev)?`App.openGuestRequestModal('${ev.id}')`:`App.switchTab('rooms')`}">${isRoomRequestEnabled(ev)?'Request Room':'View Rooms'}</button>`
              :`<button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.switchTab('guests')">Guests</button>
            <button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.switchTab('gifts')">Gifts</button>`}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
  const pastToggle=pastEvents.length
    ? `<button class="fchip ${_showPastEvents?'on':''}" style="padding:8px 14px;font-size:12px;margin:6px 0 14px" onclick="App.togglePastEvents(${_showPastEvents?'false':'true'})">${_showPastEvents?'Hide Past Events':'View Past Events'} (${pastEvents.length})</button>`
    : '';
  el.innerHTML=heroHtml+
    `<div class="ph"><div class="ph-title">My Events</div><div class="ph-sub">${myEvents.length} event${myEvents.length!==1?'s':''}</div></div>`+
    pastToggle+
    cards+
    `<div class="floating-stack"><button class="floating-bubble floating-bubble-primary" type="button" title="Add event" aria-label="Add event" onclick="App.openAddEvent()">${uiIcon('event',18)}<span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button></div>`;
}

function renderEventContactsEditor(){
  const container=document.getElementById('event-contacts-list');
  if(!container) return;
  const isOrganizer=!!_editingEventContactsId && Auth.isOrganizer(_editingEventContactsId);
  const canEdit=isOrganizer && _eventContactsEditMode;
  const headerBtn=document.getElementById('event-contact-mode-btn');
  if(headerBtn){
    headerBtn.style.display=isOrganizer?'inline-flex':'none';
    headerBtn.classList.toggle('g-edit-save', canEdit);
    headerBtn.title=canEdit?'Save contacts':'Edit contacts';
    headerBtn.setAttribute('aria-label', canEdit?'Save contacts':'Edit contacts');
    headerBtn.innerHTML=uiIcon(canEdit?'save':'edit',14);
  }
  if(_eventContactsTemp.length===0){
    if(canEdit){
      container.innerHTML=`<div class="event-contact-view">
        <div class="event-contact-view-top">
          <div style="flex:1;min-width:0">
            <div class="event-contact-grid">
              <div class="fg" style="margin-bottom:0">
                <label class="fl">Name</label>
                <input class="fi" data-contact-name-index="0" type="text" placeholder="Makeup / Security / Cook / Driver" oninput="App._updateEventContact(0,'name',this.value)" />
              </div>
              <div class="fg" style="margin-bottom:0">
                <label class="fl">Phone Number</label>
                <input class="fi event-contact-phone-input" data-contact-index="0" type="text" inputmode="tel" maxlength="15" placeholder="Phone number" oninput="this.value=this.value.replace(/\\D/g,'').slice(0,15);App._updateEventContact(0,'phone',this.value)" onkeydown="App.handleEventContactPhoneKey(event,0)" />
              </div>
            </div>
          </div>
          <button class="event-contact-icon-btn" type="button" title="Remove contact" aria-label="Remove contact" onclick="App._removeEventContact(0)">✕</button>
        </div>
      </div>`;
      focusPendingEventContactRow();
      return;
    }
    container.innerHTML='<div class="event-contact-empty">No event contacts saved yet. Add key numbers here and use call, WhatsApp, or share whenever needed.</div>';
    return;
  }
  container.innerHTML=_eventContactsTemp.map((contact,idx)=>{
    if(canEdit){
      return `
        <div class="event-contact-view">
          <div class="event-contact-view-top">
            <div style="flex:1;min-width:0">
              <div class="event-contact-grid">
                <div class="fg" style="margin-bottom:0">
                  <label class="fl">Name</label>
                  <input class="fi" data-contact-name-index="${idx}" type="text" placeholder="Camera Man / Security / Cook" value="${escapeHtml(contact.name||'')}" oninput="App._updateEventContact(${idx},'name',this.value)" />
                </div>
                <div class="fg" style="margin-bottom:0">
                  <label class="fl">Phone Number</label>
                  <input class="fi event-contact-phone-input" data-contact-index="${idx}" type="text" inputmode="tel" maxlength="15" placeholder="Phone number" value="${escapeHtml(contact.phone||'')}" oninput="this.value=this.value.replace(/\\D/g,'').slice(0,15);App._updateEventContact(${idx},'phone',this.value)" onkeydown="App.handleEventContactPhoneKey(event,${idx})" />
                </div>
              </div>
            </div>
            <button class="event-contact-icon-btn" type="button" title="Remove contact" aria-label="Remove contact" onclick="App._removeEventContact(${idx})">✕</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="event-contact-swipe-wrap" data-event-contact-index="${idx}">
        <div class="event-contact-swipe-under-left">${uiIcon('phone',14)} Call</div>
        <div class="event-contact-swipe-under-right">${uiIcon('whatsapp',14)} WhatsApp</div>
        <div class="event-contact-card event-contact-view" role="button" tabindex="0" onclick="App.openEventContactActions('${_editingEventContactsId}',${idx})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();App.openEventContactActions('${_editingEventContactsId}',${idx});}">
          <div class="event-contact-view-top">
            <div style="flex:1;min-width:0">
              <div class="event-contact-view-role">${uiIcon('contact',14)} ${escapeHtml(contact.name||'Contact')}</div>
              <div class="event-contact-view-meta" style="margin-top:6px">${contact.phone?`${escapeHtml(formatPhoneNumber(contact.phone))}`:'Phone not added yet.'}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
  if(canEdit) focusPendingEventContactRow();
  else initEventContactSwipeRows();
}

function addEventContact(){
  if(!_editingEventContactsId || !Auth.isOrganizer(_editingEventContactsId)) return;
  _eventContactsTemp.push({name:'',phone:''});
  renderEventContactsEditor();
}

function ensureTrailingEventContactRow(){
  if(!_editingEventContactsId || !Auth.isOrganizer(_editingEventContactsId) || !_eventContactsEditMode) return false;
  const last=_eventContactsTemp[_eventContactsTemp.length-1];
  if(last && !last.name && !last.phone) return false;
  _eventContactsTemp.push({name:'',phone:''});
  return true;
}

function focusPendingEventContactRow(){
  if(!_eventContactsEditMode) return;
  window.requestAnimationFrame(()=>{
    const input=document.querySelector('#event-contacts-list .event-contact-view:last-child input[data-contact-name-index]');
    input?.focus();
  });
}

function _updateEventContact(idx,key,val){
  if(!_editingEventContactsId || !Auth.isOrganizer(_editingEventContactsId) || !_eventContactsTemp[idx]) return;
  if(key==='phone') _eventContactsTemp[idx][key]=String(val||'').replace(/\D/g,'').slice(0,15);
  else _eventContactsTemp[idx][key]=String(val||'');
}

function _removeEventContact(idx){
  if(!_editingEventContactsId || !Auth.isOrganizer(_editingEventContactsId)) return;
  _eventContactsTemp.splice(idx,1);
  if(_eventContactsEditMode && _eventContactsTemp.length===0){
    _eventContactsTemp=[{name:'',phone:''}];
  }
  renderEventContactsEditor();
}

function openEventContacts(eventId){
  const ev=DB.events.find(item=>item.id===eventId);
  if(!ev){toast('⚠️ Event not found');return;}
  _editingEventContactsId=eventId;
  _eventContactsEditMode=false;
  _eventContactActionEventId='';
  _eventContactActionIndex=-1;
  _eventContactsTemp=JSON.parse(JSON.stringify(normalizeEventContacts(ev.eventContacts)));
  document.getElementById('mo-event-contacts-title').textContent=`${ev.name} Contacts`;
  document.getElementById('event-contacts-sub').textContent=Auth.isOrganizer(eventId)
    ? 'Manage event contact names and phone numbers here.'
    : 'View and use saved event contacts here.';
  renderEventContactsEditor();
  openModal('event-contacts');
}

async function saveEventContacts(){
  const ev=DB.events.find(item=>item.id===_editingEventContactsId);
  if(!ev){toast('⚠️ Event not found');return;}
  if(!Auth.isOrganizer(ev.id)){toast('⚠️ Only Organisers can update event contacts');return;}
  const normalized=normalizeEventContacts(_eventContactsTemp);
  if(normalized.length===0){
    toast('⚠️ Add at least one event contact');
    return;
  }
  if(normalized.some(contact=>!contact.name || !contact.phone)){
    toast('⚠️ Each contact needs a name and phone number');
    return;
  }
  ev.eventContacts=JSON.parse(JSON.stringify(normalized));
  save();
  try{
    await Cloud.saveEvent(ev, Auth.getTeam(ev.id), Auth.currentSession());
    await Cloud.loadEventsForSession(Auth.currentSession());
  }catch(e){
    toast('⚠️ Contacts saved locally, but cloud sync failed');
    render();
    return;
  }
  _eventContactsEditMode=false;
  render();
  renderEventContactsEditor();
  toast('Event contacts updated');
}

function toggleEventContactsEditMode(){
  if(!_editingEventContactsId || !Auth.isOrganizer(_editingEventContactsId)) return;
  _eventContactsEditMode=true;
  if(_eventContactsTemp.length===0) _eventContactsTemp=[{name:'',phone:''}];
  else ensureTrailingEventContactRow();
  renderEventContactsEditor();
}

function handleEventContactsHeaderAction(){
  if(!_editingEventContactsId || !Auth.isOrganizer(_editingEventContactsId)) return;
  if(_eventContactsEditMode){
    saveEventContacts();
    return;
  }
  toggleEventContactsEditMode();
}

function handleEventContactPhoneKey(event,idx){
  if(!_eventContactsEditMode) return;
  if(event.key!=='Enter' && event.key!=='Tab') return;
  const row=_eventContactsTemp[idx];
  if(!row || !row.phone.trim()) return;
  event.preventDefault();
  const added=idx===_eventContactsTemp.length-1 ? ensureTrailingEventContactRow() : false;
  renderEventContactsEditor();
  window.requestAnimationFrame(()=>{
    const nextIdx=added ? _eventContactsTemp.length-1 : Math.min(idx+1,_eventContactsTemp.length-1);
    const nextName=document.querySelector(`#event-contacts-list input[data-contact-name-index="${nextIdx}"]`);
    nextName?.focus();
  });
}

function callEventContact(eventId,index){
  const contact=getEventContactForAction(eventId,index);
  if(!contact?.phone){toast('⚠️ Phone number not found');return;}
  window.location.href=`tel:${contact.phone}`;
}

function whatsAppEventContact(eventId,index){
  const ev=DB.events.find(item=>item.id===eventId);
  const contact=getEventContactForAction(eventId,index);
  if(!contact?.phone){toast('⚠️ Phone number not found');return;}
  const digits=String(contact.phone||'').replace(/\D/g,'');
  const message=encodeURIComponent(ev?.name?`${ev.name} contact`:'Event contact');
  window.open(`https://wa.me/${digits}?text=${message}`,'_blank');
}

async function shareEventContact(eventId, index){
  const ev=DB.events.find(item=>item.id===eventId);
  const contact=getEventContactForAction(eventId,index);
  if(!ev || !contact){toast('⚠️ Contact not found');return;}
  const text=buildEventContactShareText(ev, contact);
  try{
    if(navigator.share){
      await navigator.share({ title:`${ev.name} contact`, text });
    }else if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(text);
      toast('Contact copied');
      return;
    }else{
      const temp=document.createElement('textarea');
      temp.value=text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      temp.remove();
      toast('Contact copied');
      return;
    }
    toast('Contact shared');
  }catch(e){
    if(String(e?.name||'')!=='AbortError') toast('⚠️ Could not share contact');
  }
}

function openEventContactActions(eventId,index){
  const contact=getEventContactForAction(eventId,index);
  if(!contact){toast('⚠️ Contact not found');return;}
  _eventContactActionEventId=eventId;
  _eventContactActionIndex=index;
  const sub=document.getElementById('event-contact-actions-sub');
  if(sub){
    sub.textContent=contact.phone
      ? `${contact.name||'Contact'} • ${formatPhoneNumber(contact.phone)}`
      : `${contact.name||'Contact'} • Phone not added yet`;
  }
  const callBtn=document.getElementById('event-contact-call-btn');
  const waBtn=document.getElementById('event-contact-wa-btn');
  if(callBtn) callBtn.style.display=contact.phone?'block':'none';
  if(waBtn) waBtn.style.display=contact.phone?'block':'none';
  openModal('event-contact-actions');
}

function callActiveEventContact(){
  if(!_eventContactActionEventId || _eventContactActionIndex<0) return;
  closeModal('event-contact-actions');
  callEventContact(_eventContactActionEventId,_eventContactActionIndex);
}

function whatsAppActiveEventContact(){
  if(!_eventContactActionEventId || _eventContactActionIndex<0) return;
  closeModal('event-contact-actions');
  whatsAppEventContact(_eventContactActionEventId,_eventContactActionIndex);
}

function shareActiveEventContact(){
  if(!_eventContactActionEventId || _eventContactActionIndex<0) return;
  closeModal('event-contact-actions');
  shareEventContact(_eventContactActionEventId,_eventContactActionIndex);
}

function initEventContactSwipeRows(){
  document.querySelectorAll('.event-contact-swipe-wrap').forEach(wrap=>{
    const card=wrap.querySelector('.event-contact-card');
    if(!card || wrap.dataset.swipeBound==='1') return;
    wrap.dataset.swipeBound='1';
    let startX=0;
    let startY=0;
    let deltaX=0;
    let tracking=false;
    let horizontal=false;
    let activePointerId=null;

    const resetSwipe=()=>{
      deltaX=0;
      card.style.transition='transform .18s ease';
      card.style.transform='translateX(0)';
      window.setTimeout(()=>{ card.style.transition=''; },180);
    };

    const finishActionSwipe=(offset,cb)=>{
      card.style.transition='transform .18s ease';
      card.style.transform=`translateX(${offset}px)`;
      window.setTimeout(()=>{
        card.style.transform='translateX(0)';
        window.setTimeout(()=>{ card.style.transition=''; },180);
      },140);
      cb();
    };

    const beginSwipe=(clientX,clientY)=>{
      startX=clientX;
      startY=clientY;
      deltaX=0;
      tracking=true;
      horizontal=false;
      card.style.transition='';
    };

    const moveSwipe=(clientX,clientY,event)=>{
      if(!tracking) return;
      const dx=clientX-startX;
      const dy=clientY-startY;
      if(!horizontal){
        if(Math.abs(dx)<8 && Math.abs(dy)<8) return;
        if(Math.abs(dx)<=Math.abs(dy)){
          tracking=false;
          return;
        }
        horizontal=true;
      }
      if(event?.cancelable) event.preventDefault();
      deltaX=Math.max(-82,Math.min(82,dx));
      card.style.transform=`translateX(${deltaX}px)`;
    };

    const finishSwipe=()=>{
      if(!tracking && !horizontal){
        card.style.transition='';
        return;
      }
      tracking=false;
      horizontal=false;
      activePointerId=null;
      if(deltaX>=58){
        const idx=parseInt(wrap.dataset.eventContactIndex,10);
        finishActionSwipe(18,()=>callEventContact(_editingEventContactsId,idx));
        return;
      }
      if(deltaX<=-58){
        const idx=parseInt(wrap.dataset.eventContactIndex,10);
        finishActionSwipe(-18,()=>whatsAppEventContact(_editingEventContactsId,idx));
        return;
      }
      resetSwipe();
    };

    wrap.addEventListener('touchstart',event=>{
      if(event.touches.length!==1) return;
      const touch=event.touches[0];
      beginSwipe(touch.clientX,touch.clientY);
    },{passive:true});
    wrap.addEventListener('touchmove',event=>{
      if(event.touches.length!==1) return;
      const touch=event.touches[0];
      moveSwipe(touch.clientX,touch.clientY,event);
    },{passive:false});
    wrap.addEventListener('touchend',finishSwipe,{passive:true});
    wrap.addEventListener('touchcancel',finishSwipe,{passive:true});

    wrap.addEventListener('pointerdown',event=>{
      if(event.pointerType==='mouse') return;
      activePointerId=event.pointerId;
      beginSwipe(event.clientX,event.clientY);
    });
    wrap.addEventListener('pointermove',event=>{
      if(event.pointerType==='mouse') return;
      if(activePointerId!==event.pointerId) return;
      moveSwipe(event.clientX,event.clientY,event);
    });
    wrap.addEventListener('pointerup',event=>{
      if(event.pointerType==='mouse') return;
      if(activePointerId!==event.pointerId) return;
      finishSwipe();
    });
    wrap.addEventListener('pointercancel',event=>{
      if(event.pointerType==='mouse') return;
      if(activePointerId!==event.pointerId) return;
      finishSwipe();
    });
  });
}

// ═══════════════════════════════════════════════
// GUESTS SCREEN
// ═══════════════════════════════════════════════
function renderGuests(){
  const el=document.getElementById('scr-guests');
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!myManagedEvents().length){
    el.innerHTML=renderCreateEventState('Create an event!','Create your first event to start building a guest list.');
    return;
  }
  const col=ev?(COLORS[ev.color]||COLORS.rose):COLORS.rose;
  let guests=DB.guests.filter(g=>g.eventId===DB.activeEvent);
  const total=guests.length;
  const att=guests.filter(g=>g.rsvp==='attending').length;
  const dec=guests.filter(g=>g.rsvp==='declined').length;
  const pen=guests.filter(g=>g.rsvp==='pending').length;
  const feedbackGuests=DB.guests
    .filter(g=>g.eventId===DB.activeEvent)
    .map(g=>ensureGuestFeedbackDefaults(g))
    .filter(g=>g.feedbackMessage||g.feedbackUpdatedAt||g.feedbackFoodRating||g.feedbackEventRating||g.feedbackRoomRating);
  // filter
  if(_guestFilter!=='all') guests=guests.filter(g=>g.rsvp===_guestFilter);
  if(_guestSearch) guests=guests.filter(g=>(g.first+' '+g.last+' '+(g.contact||'')+' '+(g.email||'')+' '+(g.table||'')).toLowerCase().includes(_guestSearch.toLowerCase()));
  const evSelHtml=`<div class="ev-sel" onclick="App.openModal('event-pick')">
    <div><div class="ev-sel-lbl">Current Event</div><div class="ev-sel-val">${ev?ev.name:'Select an event'}</div></div>
    <span class="chev">▼</span>
  </div>`;
  const statsHtml=`<div class="stats-row">
    <div class="s-card"><span class="s-n">${total}</span><span class="s-l">Total</span></div>
    <div class="s-card"><span class="s-n" style="color:var(--sage-d)">${att}</span><span class="s-l">Attending</span></div>
    <div class="s-card"><span class="s-n" style="color:#932B2B">${dec}</span><span class="s-l">Declined</span></div>
  </div>`;
  const filtersHtml=`<div class="filters">
    <span class="fchip ${_guestFilter==='all'?'on':''}" onclick="App.setGFilter('all')">All (${total})</span>
    <span class="fchip ${_guestFilter==='attending'?'on':''}" onclick="App.setGFilter('attending')">Attending</span>
    <span class="fchip ${_guestFilter==='pending'?'on':''}" onclick="App.setGFilter('pending')">Pending</span>
    <span class="fchip ${_guestFilter==='declined'?'on':''}" onclick="App.setGFilter('declined')">Declined</span>
    <span class="fchip ${_guestFilter==='invited'?'on':''}" onclick="App.setGFilter('invited')">Invited</span>
  </div>`;
  const isOrg=Auth.isOrganizer(DB.activeEvent);
  const organizerActions=isOrg?`<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      ${feedbackGuests.length?`<button class="fchip" style="padding:8px 14px;font-size:12px" onclick="App.scrollGuestsToFeedback()">Jump to Feedback</button>`:''}
    </div>`:'';
  let listHtml='';
  if(!DB.activeEvent){
    listHtml=`<div class="empty"><div class="empty-ico" style="color:var(--txt3)">${uiIcon('event',42)}</div><div class="empty-t">No event selected</div><div class="empty-s">Select one of your events to manage guests</div></div>`;
  } else if(guests.length===0){
    listHtml=`<div class="empty"><div class="empty-ico" style="color:var(--rose-d)">${uiIcon('guests',42)}</div><div class="empty-t">No guests yet</div><div class="empty-s">${_guestSearch||_guestFilter!=='all'?'Try clearing filters':'Add your first guest to get started'}</div></div>`;
  } else {
    guests.forEach((g,i)=>{
      if(i>0&&i%15===0&&!DB.premium){
        listHtml+=`<div class="ad-inline"><span>Order a custom cake at <strong>FNP</strong> with free delivery</span><span class="adlbl" style="font-size:9px">AD</span></div>`;
      }
      const first=g.first||'Guest';
      const last=g.last||'';
      const party=g.party||1;
      const contact=g.contact||'';
      const email=g.email||'';
      const table=g.table||'';
      const notes=g.notes||'';
      const rsvp=(g.rsvp||'invited').toLowerCase();
      const rsvpLabel=rsvp.charAt(0).toUpperCase()+rsvp.slice(1);
      const ini=initials(first,last);
      listHtml+=`<div class="g-swipe-wrap" data-guest-id="${g.id}">
        <div class="g-row g-swipe-card anim" onclick="App.handleGuestRowTap(event,'${g.id}')">
          <div class="g-av" style="${avStyle(g.id)}">${ini}</div>
          <div class="g-info">
            <div class="g-name">${first} ${last}</div>
            <div class="g-detail">Peoples: ${party}${contact?' · '+contact:''}${email?' · '+email:''}${table?' · '+table:''}${getGuestRoomAssignments(g).length?` · Rooms: ${formatGuestRooms(g)}`:''}${notes?' · '+notes:''}</div>
          </div>
          <div class="g-actions">
            <button class="rsvp-btn r-${rsvp}" onclick="event.stopPropagation();App.cycleRsvp('${g.id}')">${rsvpLabel}</button>
            ${isOrg&&_guestListEditMode?`<button class="g-del" onclick="event.stopPropagation();App.confirmDeleteGuest('${g.id}')">X</button>`:''}
          </div>
        </div>
      </div>`;
    });
  }
  const feedbackHtml=isOrg&&DB.activeEvent
    ? `<div class="guest-card" id="guest-feedback-section" style="margin-top:16px">
        <div class="guest-card-title">Guest Feedback${feedbackGuests.length?` (${feedbackGuests.length})`:''}</div>
        ${feedbackGuests.length
          ? feedbackGuests.map(g=>`<div class="request-row" onclick="App.openGuestDetail('${g.id}')" style="cursor:pointer">
              <div>
                <div style="font-size:14px;font-weight:600;color:var(--txt)">${g.first} ${g.last}</div>
                <div style="font-size:12px;color:var(--txt3);margin-top:4px">Food ${renderFeedbackStars(g.feedbackFoodRating)} · Event ${renderFeedbackStars(g.feedbackEventRating)} · Rooms ${renderFeedbackStars(g.feedbackRoomRating)}</div>
                ${g.feedbackMessage?`<div style="font-size:12px;color:var(--txt2);margin-top:6px;line-height:1.5">${g.feedbackMessage}</div>`:''}
              </div>
              <button class="request-btn secondary" onclick="event.stopPropagation();App.openGuestDetail('${g.id}')">View Guest</button>
            </div>`).join('')
          : `<div style="font-size:12px;color:var(--txt3);line-height:1.6">No guest feedback submitted yet.</div>`}
      </div>`
    : '';
  el.innerHTML=evSelHtml+
    `<div class="ph" style="display:flex;align-items:center;justify-content:space-between;gap:10px"><div class="ph-title" style="margin-bottom:0">Guest List</div>${isOrg?`<div style="display:flex;align-items:center;gap:8px"><button class="ev-btn" title="Export guests to master guest list" aria-label="Export guests to master guest list" style="display:inline-flex;align-items:center;justify-content:center;padding:8px;margin:0;flex:0 0 auto;width:36px;height:36px" onclick="App.exportCurrentEventToMaster()">${uiIcon('export',15)}</button><button class="g-edit ${_guestListEditMode?'g-edit-save':''}" title="${_guestListEditMode?'Save guest actions':'Edit guest actions'}" aria-label="${_guestListEditMode?'Save guest actions':'Edit guest actions'}" onclick="App.${_guestListEditMode?'saveGuestRowEdit':'toggleGuestRowEdit'}()">${uiIcon(_guestListEditMode?'save':'edit',14)}</button></div>`:''}</div>`+
    statsHtml+
    organizerActions+
    `<div class="search-wrap"><span class="search-ico">${uiIcon('search',14)}</span><input class="search-inp" id="guest-search-input" type="text" placeholder="Search guests…" value="${_guestSearch}" oninput="App.setGSearch(this.value)" /></div>`+
    filtersHtml+listHtml+feedbackHtml+
    `<div class="floating-stack">
      ${isOrg?`<button class="floating-bubble floating-bubble-primary" type="button" title="Add guest" aria-label="Add guest" onclick="App.openAddGuest()">${uiIcon('guests',18)}<span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button>`:''}
    </div>`;
  if(_preserveGuestSearchFocus){
    window.requestAnimationFrame(()=>{
      const searchInput=document.getElementById('guest-search-input');
      if(searchInput){
        const len=searchInput.value.length;
        searchInput.focus({preventScroll:true});
        try{ searchInput.setSelectionRange(len,len); }catch(e){}
      }
      _preserveGuestSearchFocus=false;
    });
  }
  initGuestSwipeRows();
}

// ═══════════════════════════════════════════════
// GIFTS SCREEN  (Gifts tab | Cash Gift tab)
// ═══════════════════════════════════════════════
function renderGuestPortal(){
  const el=document.getElementById('scr-guest-portal');
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!ev){
    el.innerHTML=`<div class="empty"><div class="empty-ico" style="color:var(--txt3)">${uiIcon('room',42)}</div><div class="empty-t">No invitation selected</div><div class="empty-s">Choose an event to view your stay details.</div></div>`;
    return;
  }
  const me=ensureGuestRequestDefaults(getCurrentGuestInvite(ev.id));
  if(!me){
    el.innerHTML=`<div class="empty"><div class="empty-ico" style="color:var(--txt3)">${uiIcon('guests',42)}</div><div class="empty-t">Invitation not found</div><div class="empty-s">We couldn't find your guest record for this event yet.</div></div>`;
    return;
  }
  ensureGuestFeedbackDefaults(me);
  ensureGuestFoodLikesDefaults(me);
  const statusClass=me.roomRequestStatus==='fulfilled'?'fulfilled':me.roomRequestStatus==='pending'?'pending':'none';
  const assignedRoom=formatGuestRooms(me);
  const requestType=me.roomRequestType||'undecided';
  const requestsEnabled=isRoomRequestEnabled(ev);
  const requestHelp=!requestsEnabled
    ?'The organiser has turned off guest room requests for this event.'
    :requestType==='needs_room'
    ?'Your request is visible to the organiser and room coordinator.'
    :requestType==='no_room_needed'
      ?'We will keep your stay marked as not required unless you update it.'
      :'Submit your stay requirement so the room team can plan ahead.';
  el.innerHTML=
    `<div class="guest-hero anim">
      <div class="guest-kicker">Guest Portal</div>
      <div class="guest-title">${ev.name}</div>
      <div class="guest-sub">
        ${ev.date?`${uiIcon('calendar',12)} ${fmtDate(ev.date)}<br>`:''}
        ${ev.time?`${uiIcon('time',12)} ${fmtTime(ev.time)}<br>`:''}
        ${ev.location?`${uiIcon('location',12)} ${formatEventLocation(ev.location)}<br>`:''}
        ${uiIcon('user',12)} ${me.first} ${me.last}
      </div>
    </div>`+
    `<div class="guest-card anim">
      <div class="guest-card-title">Event Schedule</div>
      <div style="font-size:13px;color:var(--txt2);line-height:1.7">
        ${ev.date?`Date: ${fmtDate(ev.date)}<br>`:''}
        ${ev.time?`Time: ${fmtTime(ev.time)}<br>`:''}
        ${ev.location?`Location: ${formatEventLocation(ev.location)}`:'Location will be shared by the organiser.'}
      </div>
    </div>`+
    `<div class="guest-card anim">
      <div class="guest-card-title">Room Allocation</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div>
          <div style="font-size:18px;font-weight:600;color:var(--txt);line-height:1.2">${assignedRoom}</div>
          <div style="font-size:12px;color:var(--txt3);margin-top:5px">Only your own room allocation is shown here.</div>
        </div>
        <span class="guest-room-status ${statusClass}">${roomRequestStatusLabel(me.roomRequestStatus)}</span>
      </div>
    </div>`+
    `<div class="guest-card anim">
      <div class="guest-card-title">Stay Request</div>
      <div style="font-size:13px;color:var(--txt2);line-height:1.6;margin-bottom:12px">${requestHelp}</div>
      <div class="request-chip-row">
        <span class="request-chip">${roomRequestTypeLabel(requestType)}</span>
        <span class="request-chip">${Math.max(1,parseInt(me.requestedRoomCount)||1)} room(s) requested</span>
        <span class="request-chip">${Math.max(1,parseInt(me.requestedStayCount)||me.party||1)} guest(s) staying</span>
      </div>
      ${requestsEnabled?`<div class="fg" style="margin-top:14px">
        <label class="fl">Stay Requirement</label>
        <select class="fi" id="gp-room-request-type">
          <option value="needs_room" ${requestType==='needs_room'?'selected':''}>Room required</option>
          <option value="no_room_needed" ${requestType==='no_room_needed'?'selected':''}>Room not required</option>
          <option value="undecided" ${requestType==='undecided'?'selected':''}>Not decided yet</option>
        </select>
      </div>
      <div class="request-grid">
        <div class="fg">
          <label class="fl">Rooms Needed</label>
          <input class="fi" type="number" id="gp-requested-rooms" min="1" max="20" value="${Math.max(1,parseInt(me.requestedRoomCount)||1)}" />
        </div>
        <div class="fg">
          <label class="fl">People Staying</label>
          <input class="fi" type="number" id="gp-requested-stay-count" min="1" max="50" value="${Math.max(1,parseInt(me.requestedStayCount)||me.party||1)}" />
        </div>
      </div>
      <div class="fg">
        <label class="fl">Note for Room Team</label>
        <textarea class="fi" id="gp-room-request-note" rows="3" style="resize:vertical">${me.roomRequestNote||''}</textarea>
      </div>
      <button class="btn-p" style="background:var(--slate-d)" onclick="App.submitGuestRoomRequest()">Send Room Request</button>`
      : `<div style="font-size:12px;color:var(--txt3);line-height:1.6;margin-top:12px">Room requests are currently closed. Any room assignment made by the organiser or room coordinator will still appear above.</div>`}
    </div>`+
    renderGuestFoodMenuSection(ev, me, 'portal');
}

function openGuestRequestModal(eventId){
  const targetId=eventId||DB.activeEvent;
  const ev=DB.events.find(e=>e.id===targetId);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Guest request not available');return;}
  if(!isRoomRequestEnabled(ev)){
    DB.activeEvent=targetId;
    save();
    toast('ℹ️ Room requests are turned off for this event');
    switchTab('rooms');
    return;
  }
  DB.activeEvent=targetId;
  save();
  const me=ensureGuestRequestDefaults(getCurrentGuestInvite(targetId));
  if(!me){toast('⚠️ Guest record not found');return;}
  document.getElementById('gr-title').textContent='Request Room';
  document.getElementById('gr-event-name').textContent=ev.name;
  document.getElementById('gr-event-meta').innerHTML=`${ev.date?`${uiIcon('calendar',12)} ${fmtDate(ev.date)}<br>`:''}${ev.time?`${uiIcon('time',12)} ${fmtTime(ev.time)}<br>`:''}${ev.location?`${uiIcon('location',12)} ${formatEventLocation(ev.location)}<br>`:''}${uiIcon('user',12)} ${me.first} ${me.last}`;
  document.getElementById('gr-room-status').textContent=formatGuestRooms(me);
  document.getElementById('gr-room-request-type').value=me.roomRequestType||'undecided';
  document.getElementById('gr-requested-rooms').value=Math.max(1,parseInt(me.requestedRoomCount)||1);
  document.getElementById('gr-requested-stay-count').value=Math.max(1,parseInt(me.requestedStayCount)||me.party||1);
  document.getElementById('gr-room-request-note').value=me.roomRequestNote||'';
  openModal('guest-request');
}

let _giftTab='moi';
let _giftCatFilter='all';

const CAT_META={
  personal:{label:'Personal',  stripe:'#C4637A',bg:'#FAF0F3',chip:'background:#FAF0F3;color:#8B3A52'},
  home:{label:'Home',      stripe:'#5B7FA6',bg:'#EBF2F9',chip:'background:#EBF2F9;color:#2F5380'},
  gold_silver:{label:'Gold/Silver', stripe:'#C09050',bg:'#FBF6EC',chip:'background:#FBF6EC;color:#8A6020'},
  clothing:{label:'Clothing',  stripe:'#9B6BC4',bg:'#F5EEFA',chip:'background:#F5EEFA;color:#6A2B9A'},
  kitchen:{label:'Kitchen',  stripe:'#6B9B7E',bg:'#EEF5F0',chip:'background:#EEF5F0;color:#3D6B50'},
  other:{label:'Other',     stripe:'#888780',bg:'#F5F0E8',chip:'background:#F5F0E8;color:#5F5E5A'},
  cash_gift:{label:'Cash Gift',stripe:'#C09050',bg:'#FBF6EC',chip:'background:#FBF6EC;color:#8A6020'},
};

const LEGACY_GIFT_CATEGORY_MAP={
  '\u{1F49D}':'personal',
  '\u{1F3E0}':'home',
  '\u{1F4B3}':'gold_silver',
  cash_card:'gold_silver',
  '\u{1F457}':'clothing',
  '\u{1F37D}\uFE0F':'kitchen',
  '\u{1F4E6}':'other',
  '\u{1F4B5}':'cash_gift',
};

function normalizeGiftCategory(cat){
  return LEGACY_GIFT_CATEGORY_MAP[cat] || cat || 'other';
}

DB.gifts=DB.gifts.map(g=>({ ...g, cat: normalizeGiftCategory(g.cat) }));

function renderGifts(){
  const el=document.getElementById('scr-gifts');
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!myManagedEvents().length){
    el.innerHTML=renderCreateEventState('Create an event!','Create your first event to start tracking gifts.');
    return;
  }
  const allGifts=DB.gifts.filter(g=>g.eventId===DB.activeEvent);
  const moiGifts=allGifts.filter(g=>g.isMoi);
  let physGifts=allGifts.filter(g=>!g.isMoi);
  const moiTotal=moiGifts.reduce((a,g)=>a+(parseFloat(g.value)||0),0);
  const physVal=physGifts.reduce((a,g)=>a+(parseFloat(g.value)||0),0);
  const tySent=physGifts.filter(g=>g.ty==='sent').length;
  const tyPct=physGifts.length?Math.round(tySent/physGifts.length*100):0;

  const evSelHtml=`<div class="ev-sel" onclick="App.openModal('event-pick')">
    <div><div class="ev-sel-lbl">Current Event</div><div class="ev-sel-val">${ev?ev.name:'Select an event'}</div></div>
    <span class="chev">▼</span>
  </div>`;

  const tabBar=`<div style="display:flex;background:var(--surf2);border-radius:var(--rs);padding:3px;margin-bottom:14px;gap:3px">
    <button onclick="App.setGiftTab('gifts')" style="flex:1;padding:9px 6px;border:none;border-radius:6px;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;font-weight:500;cursor:pointer;transition:all .2s;background:${_giftTab==='gifts'?'var(--surf)':'transparent'};color:${_giftTab==='gifts'?'var(--rose-d)':'var(--txt3)'};box-shadow:${_giftTab==='gifts'?'var(--sh1)':'none'}">
      Gifts${physGifts.length?` <span style="background:${_giftTab==='gifts'?'var(--rose-l)':'rgba(0,0,0,.06)'};color:${_giftTab==='gifts'?'var(--rose-d)':'var(--txt3)'};border-radius:10px;padding:1px 6px;font-size:10px">${allGifts.filter(g=>!g.isMoi).length}</span>`:''}
    </button>
    <button onclick="App.setGiftTab('moi')" style="flex:1;padding:9px 6px;border:none;border-radius:6px;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;font-weight:500;cursor:pointer;transition:all .2s;background:${_giftTab==='moi'?'var(--surf)':'transparent'};color:${_giftTab==='moi'?'var(--gold-d)':'var(--txt3)'};box-shadow:${_giftTab==='moi'?'var(--sh1)':'none'}">
      Cash Gift${moiGifts.length?` <span style="background:${_giftTab==='moi'?'var(--gold-l)':'rgba(0,0,0,.06)'};color:${_giftTab==='moi'?'var(--gold-d)':'var(--txt3)'};border-radius:10px;padding:1px 6px;font-size:10px">${moiGifts.length}</span>`:''}
    </button>
  </div>`;

  const WA_SVG=`<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>`;

  function waBtn(g,compact=false){
    const gm=DB.guests.find(gu=>gu.eventId===DB.activeEvent&&(gu.first+' '+gu.last).toLowerCase().trim()===(g.from||'').toLowerCase().trim());
    const ok=gm&&gm.contact&&gm.contact.replace(/\D/g,'').length>=10;
    const sz=compact?'26px':'30px';
    return`<button style="width:${sz};height:${sz};border-radius:50%;border:none;background:${ok?'#25D366':'var(--surf2)'};color:${ok?'white':'var(--txt4)'};cursor:${ok?'pointer':'default'};display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;opacity:${ok?'1':'.5'}" ${ok?`onclick="event.stopPropagation();App.openWhatsApp('${g.id}')" title="Send WhatsApp thank you"`:'title="Add phone number to guest first"'}>${WA_SVG}</button>`;
  }

  function giftCard(g){
    const meta=CAT_META[normalizeGiftCategory(g.cat)]||CAT_META.other;
    const gm=DB.guests.find(gu=>gu.eventId===DB.activeEvent&&(gu.first+' '+gu.last).toLowerCase().trim()===(g.from||'').toLowerCase().trim());
    const avS=gm?avStyle(gm.id):'background:var(--surf3);color:var(--txt3)';
    const ini=gm?initials(gm.first,gm.last):(g.from||'?').charAt(0).toUpperCase();
    const tyLabel=g.ty==='sent'?'TY Sent':g.ty==='drafted'?'Drafted':'Pending';
    const tyDot=g.ty==='sent'?'var(--sage-d)':g.ty==='drafted'?'var(--slate-d)':'var(--gold-d)';
    return`<div class="gift-card anim" onclick="App.openEditGift('${g.id}')">
      <div class="gift-stripe" style="background:${meta.stripe}"></div>
      <div class="gift-inner">
        <div class="gift-top">
          <div class="gift-ico" style="background:${meta.bg}">${(meta.label||'Other').charAt(0)}</div>
          <div class="gift-body">
            <div class="gift-title">${g.desc}</div>
            <div class="gift-from-row">
              <div class="gift-from-av" style="${avS}">${ini}</div>
              <span class="gift-from-name">${g.from||'Unknown'}</span>
              <span class="gift-cat-chip" style="${meta.chip}">${meta.label}</span>
            </div>
            ${g.notes?`<div style="font-size:11px;color:var(--txt4);margin-top:4px;font-style:italic;line-height:1.4">${g.notes}</div>`:''}
          </div>
        </div>
        <div style="height:1px;background:var(--bord2);margin-bottom:10px"></div>
        <div class="gift-bot">
          <div class="gift-actions">
            <button class="ty-btn ty-${g.ty}" onclick="event.stopPropagation();App.cycleTy('${g.id}')" style="display:flex;align-items:center;gap:4px">
              <span style="width:6px;height:6px;border-radius:50%;background:${tyDot};flex-shrink:0;display:inline-block"></span>${tyLabel}
            </button>
            ${waBtn(g)}
          </div>
        </div>
        ${g.photo?`<img class="gift-photo-thumb" src="${g.photo}" alt="Gift" />`:''}
      </div>
      <button class="gift-del" onclick="event.stopPropagation();App.confirmDeleteGift('${g.id}')">X</button>
    </div>`;
  }

  function moiRow(g,rank){
    const gm=DB.guests.find(gu=>gu.eventId===DB.activeEvent&&(gu.first+' '+gu.last).toLowerCase().trim()===(g.from||'').toLowerCase().trim());
    const avS=gm?avStyle(gm.id):`background:${rank===1?'#F0DEB8':rank===2?'#E0E0E0':rank===3?'#EBCFB0':'var(--surf2)'};color:${rank<=3?'var(--txt2)':'var(--txt3)'}`;
    const ini=gm?initials(gm.first,gm.last):(g.from||'?').charAt(0).toUpperCase();
    const medalColor=rank===1?'#C09050':rank===2?'#9E9E9E':rank===3?'#9C6B3A':null;
    const tyBg=g.ty==='sent'?'var(--sage-l)':g.ty==='drafted'?'var(--slate-l)':'var(--gold-l)';
    const tyColor=g.ty==='sent'?'var(--sage-d)':g.ty==='drafted'?'var(--slate-d)':'var(--gold-d)';
    const tyLabel=g.ty==='sent'?'TY Sent':g.ty==='drafted'?'Draft':'Pending';
    const modeIcon='';
    const modeLabel=g.notes||'Cash';
    return`<div class="moi-row anim" data-moi="1" data-name="${(g.from||'').replace(/"/g,'')}" data-ty="${g.ty||'pending'}" onclick="App.openEditMoi('${g.id}')">
      <div style="position:relative;flex-shrink:0">
        <div class="moi-av" style="${avS}">${ini}</div>
        ${medalColor?`<div style="position:absolute;bottom:-2px;right:-2px;width:16px;height:16px;border-radius:50%;background:${medalColor};border:2px solid var(--surf);display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:800;color:white">${rank}</div>`:''}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.5px;font-weight:500;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px">${g.from||'Unknown'}</div>
        <div style="font-size:11px;color:var(--txt4);display:flex;align-items:center;gap:4px"><span>${modeLabel}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:7px;flex-shrink:0">
        <div style="text-align:right">
          <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:600;color:var(--gold-d);line-height:1">${fmtVal(g.value)}</div>
          <button class="moi-ty-badge" style="background:${tyBg};color:${tyColor};margin-top:3px" onclick="event.stopPropagation();App.cycleTy('${g.id}')" title="Tap to cycle status">${tyLabel}</button>
        </div>
        ${waBtn(g,true)}
      </div>
    </div>`;
  }

  let body='';
  if(!DB.activeEvent){
    body=`<div class="empty"><div class="empty-ico" style="color:var(--rose-d)">${uiIcon('gift',42)}</div><div class="empty-t">No event selected</div><div class="empty-s">Select one of your events to track gifts</div></div>`;
    el.innerHTML=evSelHtml+body; return;
  }

  if(_giftTab==='gifts'){
    // Summary strip
    body+=`<div class="gift-strip">
      <div class="gift-strip-cell">
        <span class="gsn">${physGifts.length}</span>
        <span class="gsl">Gifts</span>
      </div>
      <div class="gift-strip-cell">
        <span class="gsn" style="color:${tyPct===100?'var(--sage-d)':'var(--txt)'}">${tySent}<span style="font-size:12px;color:var(--txt3);font-weight:400">/${physGifts.length}</span></span>
        <span class="gsl">TY Sent</span>
      </div>
    </div>`;
    // TY progress card
    if(physGifts.length>0){
      const fillColor=tyPct===100?'#3D6B50':tyPct>50?'#6B9B7E':'#C09050';
      body+=`<div class="ty-bar-wrap">
        <div class="ty-bar-top">
          <span class="ty-bar-label">Thank-you notes</span>
          <span class="ty-bar-pct" style="color:${fillColor}">${tyPct===100?'All done':tyPct+'% done'}</span>
        </div>
        <div class="ty-track"><div class="ty-fill" style="width:${tyPct}%;background:${fillColor}"></div></div>
      </div>`;
    }
    // Category filters
    const cats=[...new Set(physGifts.map(g=>g.cat))];
    if(cats.length>1){
      body+=`<div class="cat-filters">
        <span class="cat-chip ${_giftCatFilter==='all'?'on':''}" style="${_giftCatFilter==='all'?'background:var(--txt);color:white;border-color:var(--txt)':''}" onclick="App.setGiftCatFilter('all')">All</span>
        ${cats.map(c=>{const m=CAT_META[c]||CAT_META.other;return`<span class="cat-chip ${_giftCatFilter===c?'on':''}" style="${_giftCatFilter===c?m.chip+';border-color:transparent':''}" onclick="App.setGiftCatFilter('${c}')">${m.label}</span>`;}).join('')}
      </div>`;
    }
    const filtered=_giftCatFilter==='all'?physGifts:physGifts.filter(g=>g.cat===_giftCatFilter);
    if(physGifts.length===0){
      body+=`<div class="empty"><div class="empty-ico" style="color:var(--rose-d)">${uiIcon('gift',42)}</div><div class="empty-t">No gifts yet</div><div class="empty-s">Tap above to log your first gift</div></div>`;
    } else if(filtered.length===0){
      body+=`<div class="empty"><div class="empty-ico" style="color:var(--txt3)">${uiIcon('search',42)}</div><div class="empty-t">None in this category</div></div>`;
    } else {
      filtered.forEach((g,i)=>{
        if(i>0&&i%8===0&&!DB.premium) body+=`<div class="ad-inline"><span>Send cards at <strong>Hallmark</strong></span><span class="adlbl" style="font-size:9px">AD</span></div>`;
        body+=giftCard(g);
      });
    }
  } else {
    // ── MOI TAB ──
    const moiPend=moiGifts.filter(g=>g.ty==='pending').length;
    const moiSent=moiGifts.filter(g=>g.ty==='sent').length;
    const moiDrafted=moiGifts.filter(g=>g.ty==='drafted').length;
    const moiPct=moiGifts.length?Math.round(moiSent/moiGifts.length*100):0;
    const moiAvg=moiGifts.length?Math.round(moiTotal/moiGifts.length):0;
    const moiMax=moiGifts.length?Math.max(...moiGifts.map(g=>parseFloat(g.value)||0)):0;

    body+=`<div class="moi-hero">
      <div class="moi-hero-orb" style="width:120px;height:120px;right:-30px;top:-30px"></div>
      <div class="moi-hero-orb" style="width:70px;height:70px;left:35%;bottom:-25px"></div>
      <div class="moi-hero-orb" style="width:40px;height:40px;left:10%;top:20px"></div>
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px">
        <div>
          <div style="font-size:9.5px;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:1.4px;margin-bottom:5px">மொய் · Total Collected</div>
          <div style="font-family:'Cormorant Garamond',serif;font-size:40px;font-weight:600;color:white;line-height:1">${moiTotal>0?fmtVal(moiTotal):`${currencySymbol()}0`}</div>
        </div>
        <div style="background:rgba(255,255,255,.12);border-radius:var(--rs);padding:6px 10px;text-align:center">
          <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:white;line-height:1">${moiGifts.length}</div>
          <div style="font-size:9px;color:rgba(255,255,255,.55);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Entries</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:${moiGifts.length>0?'14':'0'}px">
        <div style="background:rgba(0,0,0,.18);border-radius:var(--rxs);padding:8px 6px;text-align:center">
          <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:#A5E5B8">${moiSent}</div>
          <div style="font-size:9px;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">TY Sent</div>
        </div>
        <div style="background:rgba(0,0,0,.18);border-radius:var(--rxs);padding:8px 6px;text-align:center">
          <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:#C8D8FF">${moiDrafted}</div>
          <div style="font-size:9px;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Drafted</div>
        </div>
        <div style="background:rgba(0,0,0,.18);border-radius:var(--rxs);padding:8px 6px;text-align:center">
          <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:#FFD07A">${moiPend}</div>
          <div style="font-size:9px;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:.5px;margin-top:2px">Pending</div>
        </div>
      </div>
      ${moiGifts.length>0?`<div><div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:rgba(255,255,255,.5);margin-bottom:5px"><span>Thank-you progress</span><span style="font-weight:600;color:${moiPct===100?'#A5E5B8':'rgba(255,255,255,.7)'}">${moiPct===100?'All done':moiPct+'%'}</span></div><div style="height:6px;background:rgba(255,255,255,.12);border-radius:3px;overflow:hidden"><div style="height:100%;width:${moiPct}%;background:linear-gradient(90deg,#FFD07A,#A5E5B8);border-radius:3px;transition:width .6s ease"></div></div></div>`:''}
    </div>`;

    if(moiGifts.length>0){
      body+=`<div class="moi-avg-strip">
        <div class="moi-avg-cell">
          <span class="moi-avg-n">${moiAvg>0?fmtVal(moiAvg):'—'}</span>
          <span class="moi-avg-l">Avg Gift</span>
        </div>
        <div class="moi-avg-cell">
          <span class="moi-avg-n">${moiMax>0?fmtVal(moiMax):'—'}</span>
          <span class="moi-avg-l">Highest</span>
        </div>
        <div class="moi-avg-cell">
          <span class="moi-avg-n" style="color:var(--rose-d)">${moiPend}</span>
          <span class="moi-avg-l">TY Pending</span>
        </div>
      </div>`;
    }

    if(moiGifts.length===0){
      body+=`<div class="empty"><div class="empty-ico" style="color:var(--gold-d)">${escapeHtml(currencySymbol().trim()||'¤')}</div><div class="empty-t">No entries yet</div><div class="empty-s">Record cash received from guests - tap above to start</div></div>`;
    } else {
      body+=`<div class="search-wrap" style="margin-bottom:10px"><span class="search-ico">${uiIcon('search',14)}</span><input class="search-inp" type="text" placeholder="Search by name…" oninput="App.filterMoi(this.value)" id="moi-search-inp" /></div>`;
      body+=`<div class="moi-filter-row" id="moi-ty-filter">
        <span class="moi-fchip on" onclick="App.setMoiFilter('all',this)">All (${moiGifts.length})</span>
        <span class="moi-fchip" onclick="App.setMoiFilter('pending',this)">Pending (${moiPend})</span>
        <span class="moi-fchip" onclick="App.setMoiFilter('drafted',this)">Drafted (${moiDrafted})</span>
        <span class="moi-fchip" onclick="App.setMoiFilter('sent',this)">Sent (${moiSent})</span>
      </div>`;
      const sorted=[...moiGifts].sort((a,b)=>(parseFloat(b.value)||0)-(parseFloat(a.value)||0));
      body+=`<div id="moi-list">${sorted.map((g,i)=>moiRow(g,i+1)).join('')}</div>`;
    }
  }

  const floatingGiftAction=_giftTab==='gifts'
    ? `<div class="floating-stack"><button class="floating-bubble floating-bubble-primary" type="button" title="Add gift" aria-label="Add gift" onclick="App.openAddGift()">${uiIcon('gift',18)}<span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button></div>`
    : `<div class="floating-stack"><button class="floating-bubble floating-bubble-primary" type="button" title="Add cash gift" aria-label="Add cash gift" onclick="App.openAddMoi()" style="background:var(--gold-d);border-color:var(--gold-d)"><span style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;line-height:1">${escapeHtml(currencySymbol().trim()||'¤')}</span><span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button></div>`;
  el.innerHTML=evSelHtml+`<div class="ph" style="margin-bottom:12px"><div class="ph-title">Gift Tracker</div></div>`+tabBar+body+floatingGiftAction;
}

// ═══════════════════════════════════════════════
// SETTINGS SCREEN
// ═══════════════════════════════════════════════
function renderSettings(){
  const el=document.getElementById('scr-settings');
  const canManageGuestDelete=Auth.isOrganizer(DB.activeEvent);
  const currency=currentCurrencyCode();
  el.innerHTML=`
  <div class="ph"><div class="ph-title">Settings</div></div>
  <div class="set-sec">
    <div class="set-sec-t">Preferences</div>
    <div class="set-item" style="align-items:flex-start">
      <div class="set-left">
        <div class="set-ico" style="background:var(--sage-l)">${currencySymbol().trim()||'¤'}</div>
        <div><div class="set-lbl">Currency</div><div class="set-sub">Used in gifts and cash gift amounts</div></div>
      </div>
      <select class="fi" style="width:148px;min-width:148px;padding:10px 12px" onchange="App.setCurrency(this.value)">
        ${Object.values(CURRENCY_META).map(item=>`<option value="${item.code}" ${currency===item.code?'selected':''}>${item.code}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="set-sec">
    <div class="set-sec-t">Notifications</div>
    <div class="set-item" onclick="App.enableAppNotifications()">
      <div class="set-left">
        <div class="set-ico" style="background:var(--slate-l)">AP</div>
        <div><div class="set-lbl">App Notifications</div><div class="set-sub">${NotificationCenter.supported()?(DB.settings.appNotifications&&typeof Notification!=='undefined'&&Notification.permission==='granted'?'Enabled for shared lists, team invites, and room allocation':'Tap to enable browser/app notifications'):'Not supported on this device'}</div></div>
      </div>
      <span class="chev">${NotificationCenter.supported()&&DB.settings.appNotifications&&typeof Notification!=='undefined'&&Notification.permission==='granted'?'On':'>'}</span>
    </div>
    <div class="set-item">
      <div class="set-left">
        <div class="set-ico" style="background:var(--gold-l)">RS</div>
        <div><div class="set-lbl">RSVP Reminders</div><div class="set-sub">7 days before event</div></div>
      </div>
      <button class="tog ${DB.settings.rsvpReminders?'on':''}" onclick="App.toggleSetting('rsvpReminders',this)"></button>
    </div>
    <div class="set-item">
      <div class="set-left">
        <div class="set-ico" style="background:var(--rose-l)">TY</div>
        <div><div class="set-lbl">Thank-You Reminders</div><div class="set-sub">After each gift is logged</div></div>
      </div>
      <button class="tog ${DB.settings.tyReminders?'on':''}" onclick="App.toggleSetting('tyReminders',this)"></button>
    </div>
  </div>
  ${canManageGuestDelete?`<div class="set-sec">
    <div class="set-sec-t">Guest Management</div>
    <div class="set-item">
      <div class="set-left">
        <div class="set-ico" style="background:var(--rose-l)">DG</div>
        <div><div class="set-lbl">Remove Confirmation</div><div class="set-sub">Ask before deleting a guest</div></div>
      </div>
      <button class="tog ${DB.settings.removeGuestConfirmation!==false?'on':''}" onclick="App.toggleSetting('removeGuestConfirmation',this)"></button>
    </div>
  </div>`:''}
  <div class="set-sec">
    <div class="set-sec-t">Data & Export</div>
    <div class="set-item" onclick="App.openMasterGuestModal('manage')">
      <div class="set-left">
        <div class="set-ico" style="background:var(--slate-l)">MG</div>
        <div><div class="set-lbl">Master Guest List</div><div class="set-sub">${DB.masterGuests.length} saved guest${DB.masterGuests.length!==1?'s':''}${getPendingMasterGuestShareCount()?` · ${getPendingMasterGuestShareCount()} incoming share${getPendingMasterGuestShareCount()!==1?'s':''}`:''}</div></div>
      </div>
      <span class="chev">></span>
    </div>
    <div class="set-item" onclick="App.openModal('export')">
      <div class="set-left">
        <div class="set-ico" style="background:var(--sage-l)">EX</div>
        <div><div class="set-lbl">Export Data</div><div class="set-sub">Guest list & gift tracker as CSV</div></div>
      </div>
      <span class="chev">></span>
    </div>
    <div class="set-item" onclick="App.clearAllData()">
      <div class="set-left">
        <div class="set-ico" style="background:#FEE8E8">DL</div>
        <div><div class="set-lbl">Clear All Data</div><div class="set-sub">Remove all events and data</div></div>
      </div>
      <span class="chev" style="color:#932B2B">></span>
    </div>
  </div>
  <div class="set-sec">
    <div class="set-sec-t">Coming Soon</div>
    <div class="set-item" style="cursor:default;opacity:.7">
      <div class="set-left">
        <div class="set-ico" style="background:var(--slate-l)">RS</div>
        <div><div class="set-lbl">Digital RSVP Links</div><div class="set-sub">Let guests RSVP via a unique link</div></div>
      </div>
      <span class="soon-badge">v2.0</span>
    </div>
    <div class="set-item" style="cursor:default;opacity:.7">
      <div class="set-left">
        <div class="set-ico" style="background:var(--sage-l)">CO</div>
        <div><div class="set-lbl">Collaborator Mode</div><div class="set-sub">Co-host can edit simultaneously</div></div>
      </div>
      <span class="soon-badge">v2.0</span>
    </div>
    <div class="set-item" style="cursor:default;opacity:.7">
      <div class="set-left">
        <div class="set-ico" style="background:var(--gold-l)">CT</div>
        <div><div class="set-lbl">Import from Contacts</div><div class="set-sub">Bulk add guests from phone</div></div>
      </div>
      <span class="soon-badge">v1.5</span>
    </div>
  </div>
  <div style="text-align:center;padding:10px 0 20px;font-size:11.5px;color:var(--txt4)">eventise v1.0</div>`;
}

// ═══════════════════════════════════════════════
// MAIN RENDER
// ═══════════════════════════════════════════════
function render(){
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  const teamBtn=document.getElementById('hdr-team-btn');
  if(teamBtn) teamBtn.style.display=ev&&ev._isGuestOnly?'none':'block';
  if(_tab==='events') renderEvents();
  else if(_tab==='guests') renderGuests();
  else if(_tab==='gifts') renderGifts();
  else if(_tab==='settings') renderSettings();
  else if(_tab==='rooms') renderRooms();
  else if(_tab==='guest-portal') renderGuestPortal();
  applyCurrencyUI();
  updateBadges();
  updateScrollTopVisibility();
}

function updateBadges(){
  // pending TY badge on gifts tab
  const tyPend=DB.gifts.filter(g=>g.eventId===DB.activeEvent&&g.ty==='pending').length;
  const giftTab=document.getElementById('tab-gifts');
  const existing=giftTab?.querySelector('.tab-badge');
  if(existing)existing.remove();
  if(giftTab&&tyPend>0){
    const b=document.createElement('span');
    b.className='tab-badge';
    b.textContent=tyPend;
    giftTab.appendChild(b);
  }
  const roomsTab=document.getElementById('tab-rooms');
  const roomBadge=roomsTab?.querySelector('.tab-badge');
  if(roomBadge)roomBadge.remove();
  if(roomsTab&&Auth.isOrganizer(DB.activeEvent)){
    const roomPend=DB.guests.filter(g=>g.eventId===DB.activeEvent&&ensureGuestRequestDefaults(g).roomRequestStatus==='pending'&&g.roomRequestType!=='undecided').length;
    if(roomPend>0){
      const b=document.createElement('span');
      b.className='tab-badge';
      b.textContent=roomPend;
      roomsTab.appendChild(b);
    }
  }
}

// ═══════════════════════════════════════════════
// EVENT CRUD
// ═══════════════════════════════════════════════
function openAddEvent(){
  _editing.event=null;
  _eventMenuEditorDisabled=false;
  setEventEditorMode(true);
  document.getElementById('mo-event-title').textContent='New Event';
  document.getElementById('ev-name').value='';
  const dateInput=document.getElementById('ev-date');
  if(dateInput){
    dateInput.min=todayInputDate();
    dateInput.value='';
  }
  const timeEl=document.getElementById('ev-time');
  if(timeEl){
    timeEl.value='';
    timeEl.disabled=false;
    timeEl.style.opacity='1';
  }
  const locInp=document.getElementById('ev-loc');
  if(locInp){locInp.value='';locInp.dataset.lat='';locInp.dataset.lon='';}
  const sug=document.getElementById('loc-suggestions');
  if(sug)sug.style.display='none';
  const preview=document.getElementById('loc-map-preview');
  if(preview)preview.style.display='none';
  document.getElementById('ev-color').value='rose';
  document.getElementById('ev-room-requests-enabled').checked=true;
  document.getElementById('ev-room-requests-enabled').disabled=false;
  document.getElementById('ev-room-requests-enabled').closest('label').style.opacity='1';
  document.getElementById('ev-feedback-enabled').checked=false;
  document.getElementById('ev-feedback-enabled').disabled=false;
  document.getElementById('ev-feedback-enabled').closest('label').style.opacity='1';
  const legacyEventContactsButton=document.getElementById('ev-contact-add-btn');
  if(legacyEventContactsButton){
    legacyEventContactsButton.style.display='none';
    legacyEventContactsButton.closest('.fg')?.style.setProperty('display','none');
  }
  const roomSection=document.getElementById('ev-room-section');
  if(roomSection) roomSection.style.display='none';
  const foodSection=document.getElementById('ev-food-section');
  if(foodSection) foodSection.style.display='none';
  document.getElementById('del-event-btn').style.display='none';
  _roomLocsTemp=[];
  _eventMenusTemp=[];
  openModal('add-event');
}

function openEditEvent(id){
  const ev=DB.events.find(e=>e.id===id);
  if(!ev)return;
  _editing.event=id;
  const isOrg = Auth.isOrganizer(id);
  setEventEditorMode(isOrg);
  document.getElementById('mo-event-title').textContent=isOrg?'Edit Event':'Configure Rooms';
  document.getElementById('ev-name').value=ev.name||'';
  const dateInput=document.getElementById('ev-date');
  if(dateInput){
    dateInput.min=todayInputDate();
    dateInput.value=ev.date||'';
  }
  const timeEl=document.getElementById('ev-time');
  if(timeEl){
    timeEl.value=toTimeInputValue(ev.time);
    timeEl.disabled=!isOrg;
    timeEl.style.opacity=isOrg?'1':'0.6';
  }
  const locInp=document.getElementById('ev-loc');
  if(locInp){locInp.value=ev.location||'';}
  document.getElementById('ev-color').value=ev.color||'rose';
  const reqToggle=document.getElementById('ev-room-requests-enabled');
  if(reqToggle){
    reqToggle.checked=isRoomRequestEnabled(ev);
    reqToggle.disabled=!isOrg;
    reqToggle.closest('label').style.opacity=isOrg?'1':'0.6';
  }
  const feedbackToggle=document.getElementById('ev-feedback-enabled');
  if(feedbackToggle){
    feedbackToggle.checked=isFeedbackEnabled(ev);
    feedbackToggle.disabled=!isOrg;
    feedbackToggle.closest('label').style.opacity=isOrg?'1':'0.6';
  }
  const legacyEventContactsButton=document.getElementById('ev-contact-add-btn');
  if(legacyEventContactsButton){
    legacyEventContactsButton.style.display='none';
    legacyEventContactsButton.closest('.fg')?.style.setProperty('display','none');
  }
  const roomSection=document.getElementById('ev-room-section');
  if(roomSection) roomSection.style.display='none';
  const foodSection=document.getElementById('ev-food-section');
  if(foodSection) foodSection.style.display=isOrg?'':'none';
  // Disable core fields for non-organizers
  ['ev-name', 'ev-date', 'ev-loc', 'ev-color'].forEach(fid => {
    const fel = document.getElementById(fid);
    if(fel) {
      fel.disabled = !isOrg;
      fel.style.opacity = isOrg ? '1' : '0.6';
    }
  });
  
  document.getElementById('del-event-btn').style.display=isOrg?'block':'none';
  // load room locations
  _roomLocsTemp=JSON.parse(JSON.stringify(ev.roomLocs||[]));
  _eventMenuEditorDisabled=!isOrg;
  _eventMenusTemp=JSON.parse(JSON.stringify(normalizeEventMenus(ev.foodMenus)));
  // restore map preview if coords saved
  if(ev.locLat&&ev.locLon){
    const frame=document.getElementById('loc-map-frame');
    const preview=document.getElementById('loc-map-preview');
    const mapLink=document.getElementById('loc-map-link');
    if(frame)frame.src=`https://maps.google.com/maps?q=${ev.locLat},${ev.locLon}&z=15&output=embed`;
    if(preview)preview.style.display='block';
    if(mapLink)mapLink.href=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location||'')}`;
    const locInp=document.getElementById('ev-loc');
    if(locInp){locInp.dataset.lat=ev.locLat;locInp.dataset.lon=ev.locLon;}
  } else {
    const preview=document.getElementById('loc-map-preview');
    if(preview)preview.style.display='none';
  }
  openModal('add-event');
}

function openEventFoodMenuEditor(){
  const eventId=_editing.event;
  const ev=DB.events.find(e=>e.id===eventId);
  if(!ev){toast('⚠️ Save the event first before editing food menu');return;}
  if(!Auth.isOrganizer(ev.id)){toast('⚠️ Only Organisers can update food menu');return;}
  _eventFoodMenuModalEventId=ev.id;
  _eventMenusTemp=JSON.parse(JSON.stringify(normalizeEventMenus(ev.foodMenus)));
  document.getElementById('event-food-menu-title').textContent=`${ev.name} Food Menu`;
  renderEventMenusEditor();
  openModal('event-food-menu');
}

function openRoomConfig(id){
  const ev=DB.events.find(e=>e.id===id);
  if(!ev){toast('⚠️ Event not found');return;}
  if(!Auth.isRoom(id)){toast('⚠️ Only organisers or room coordinators can do this');return;}
  _roomConfigEventId=id;
  _roomLocsTemp=JSON.parse(JSON.stringify(ev.roomLocs||[]));
  document.getElementById('mo-room-config-title').textContent=`${ev.name} Rooms`;
  renderRoomLocsEditor();
  openModal('room-config');
}

async function saveEvent(){
  const name=document.getElementById('ev-name').value.trim();
  if(!name){toast('⚠️ Please enter an event name');return;}
  const dateInput=document.getElementById('ev-date');
  const selectedDate=dateInput?dateInput.value:'';
  const minDate=todayInputDate();
  if(!selectedDate){toast('⚠️ Please select an event date');return;}
  const locInp=document.getElementById('ev-loc');
  const locVal=locInp?locInp.value.trim():'';
  const locLat=locInp?parseFloat(locInp.dataset.lat)||null:null;
  const locLon=locInp?parseFloat(locInp.dataset.lon)||null:null;
  const eventTime=document.getElementById('ev-time').value.trim();
  const roomRequestsEnabledEl=document.getElementById('ev-room-requests-enabled');
  const feedbackEnabledEl=document.getElementById('ev-feedback-enabled');
  let savedEvent=null;
  if(_editing.event){
    const ev=DB.events.find(e=>e.id===_editing.event);
    if(ev){
      const isOrg=Auth.isOrganizer(ev.id);
      if(isOrg && selectedDate<minDate && selectedDate!==String(ev.date||'')){
        toast('⚠️ Event date cannot be in the past');
        return;
      }
      ev.roomLocs=JSON.parse(JSON.stringify(_roomLocsTemp));
      if(isOrg){
        ev.name=name;
        ev.date=selectedDate;
        ev.time=eventTime;
        ev.location=locVal;
        ev.locLat=locLat;
        ev.locLon=locLon;
        ev.color=document.getElementById('ev-color').value;
        ev.foodMenus=JSON.parse(JSON.stringify(normalizeEventMenus(_eventMenusTemp)));
        if(roomRequestsEnabledEl) ev.roomRequestsEnabled=roomRequestsEnabledEl.checked;
        if(feedbackEnabledEl) ev.feedbackEnabled=feedbackEnabledEl.checked;
      }
      savedEvent=ev;
    }
    toast('Event updated');
  } else {
    if(selectedDate<minDate){
      toast('⚠️ Event date cannot be in the past');
      return;
    }
    const ev={
      id:uid(),name,
      date:selectedDate,
      time:eventTime,
      location:locVal,
      locLat,locLon,
      color:document.getElementById('ev-color').value,
      roomLocs:JSON.parse(JSON.stringify(_roomLocsTemp)),
      foodMenus:JSON.parse(JSON.stringify(normalizeEventMenus(_eventMenusTemp))),
      eventContacts:[],
      roomRequestsEnabled:roomRequestsEnabledEl?roomRequestsEnabledEl.checked:true,
      feedbackEnabled:feedbackEnabledEl?feedbackEnabledEl.checked:false,
      createdAt:Date.now()
    };
    DB.events.push(ev);
    if(!DB.activeEvent)DB.activeEvent=ev.id;
    Auth.addCreatorAsOrganizer(ev.id);
    savedEvent=ev;
    toast('Event created');
  }
  save();
  if(savedEvent){
    try{
      await Cloud.saveEvent(savedEvent, Auth.getTeam(savedEvent.id), Auth.currentSession());
      await Cloud.loadEventsForSession(Auth.currentSession());
    }catch(e){
      toast('⚠️ Event saved locally, but cloud sync failed');
    }
  }
  closeModal('add-event');render();
}

async function saveRoomConfig(){
  const ev=DB.events.find(e=>e.id===_roomConfigEventId);
  if(!ev){toast('⚠️ Event not found');return;}
  if(!Auth.isRoom(ev.id)){toast('⚠️ Only organisers or room coordinators can do this');return;}
  ev.roomLocs=JSON.parse(JSON.stringify(_roomLocsTemp));
  save();
  try{
    await Cloud.saveEvent(ev, Auth.getTeam(ev.id), Auth.currentSession());
    await Cloud.loadEventsForSession(Auth.currentSession());
  }catch(e){
    toast('⚠️ Rooms saved locally, but cloud sync failed');
    render();
    return;
  }
  closeModal('room-config');
  render();
  toast('Room configuration updated');
}

async function saveEventFoodMenus(){
  const ev=DB.events.find(e=>e.id===_eventFoodMenuModalEventId);
  if(!ev){toast('⚠️ Event not found');return;}
  if(!Auth.isOrganizer(ev.id)){toast('⚠️ Only Organisers can update food menu');return;}
  ev.foodMenus=JSON.parse(JSON.stringify(normalizeEventMenus(_eventMenusTemp)));
  save();
  try{
    await Cloud.saveEvent(ev, Auth.getTeam(ev.id), Auth.currentSession());
    await Cloud.loadEventsForSession(Auth.currentSession());
  }catch(e){
    toast('⚠️ Food menu saved locally, but cloud sync failed');
    render();
    return;
  }
  closeModal('event-food-menu');
  render();
  toast('Food menu updated');
}

function confirmDeleteEvent(){
  const ev=DB.events.find(e=>e.id===_editing.event);
  if(!ev)return;
  openConfirm(`Delete "${ev.name}"?`,`This will also delete all ${DB.guests.filter(g=>g.eventId===ev.id).length} guests and ${DB.gifts.filter(g=>g.eventId===ev.id).length} gifts.`,()=>{
    DB.events=DB.events.filter(e=>e.id!==ev.id);
    DB.guests=DB.guests.filter(g=>g.eventId!==ev.id);
    DB.gifts=DB.gifts.filter(g=>g.eventId!==ev.id);
    if(DB.activeEvent===ev.id)DB.activeEvent=DB.events[0]?.id||null;
    save();
    Cloud.deleteEvent(ev.id).catch(()=>toast('⚠️ Could not delete cloud event'));
    closeModal('add-event');render();toast('Event deleted');
  });
}

function setActive(id){
  DB.activeEvent=id;save();
}

// ═══════════════════════════════════════════════
// GUEST CRUD
// ═══════════════════════════════════════════════
function openAddGuest(){
  if(!DB.activeEvent){toast('⚠️ Please select an event first');return;}
  _editing.guest=null;
  const titleEl=document.getElementById('mo-guest-title');
  if(titleEl) titleEl.textContent='Add Guest';
  ['g-first','g-last','g-contact','g-email','g-notes','g-table'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.value='';
  });
  const partyEl=document.getElementById('g-party');
  if(partyEl) partyEl.value='1';
  const rsvpEl=document.getElementById('g-rsvp');
  if(rsvpEl) rsvpEl.value='pending';
  const deleteBtn=document.getElementById('del-guest-btn');
  if(deleteBtn) deleteBtn.style.display='none';
  const inviteBtn=document.getElementById('send-invite-btn');
  if(inviteBtn) inviteBtn.style.display='none';
  const masterPickBtn=document.getElementById('guest-master-pick-btn');
  if(masterPickBtn) masterPickBtn.style.display='block';
  const masterUpdateBtn=document.getElementById('guest-master-update-btn');
  if(masterUpdateBtn) masterUpdateBtn.style.display='none';
  populateRoomSelects();
  const roomLocEl=document.getElementById('g-room-loc');
  const roomNoEl=document.getElementById('g-room-no');
  if(roomLocEl) roomLocEl.value='';
  if(roomNoEl) roomNoEl.value='';
  const conflictEl=document.getElementById('room-conflict-indicator');
  if(conflictEl) conflictEl.style.display='none';
  openModal('add-guest');
  document.getElementById('g-first')?.focus();
}

function openEditGuest(id){
  const g=DB.guests.find(x=>x.id===id);
  if(!g)return;
  _editing.guest=id;
  const titleEl=document.getElementById('mo-guest-title');
  if(titleEl) titleEl.textContent='Edit Guest';
  const firstEl=document.getElementById('g-first');
  const lastEl=document.getElementById('g-last');
  const contactEl=document.getElementById('g-contact');
  const emailEl=document.getElementById('g-email');
  const partyEl=document.getElementById('g-party');
  const rsvpEl=document.getElementById('g-rsvp');
  const notesEl=document.getElementById('g-notes');
  const groupEl=document.getElementById('g-table');
  if(firstEl) firstEl.value=g.first||'';
  if(lastEl) lastEl.value=g.last||'';
  if(contactEl) contactEl.value=g.contact||'';
  if(emailEl) emailEl.value=g.email||'';
  if(partyEl) partyEl.value=g.party||1;
  if(rsvpEl) rsvpEl.value=(g.rsvp==='invited'?'invited':'pending');
  if(notesEl) notesEl.value=g.notes||'';
  if(groupEl) groupEl.value=g.table||'';
  const deleteBtn=document.getElementById('del-guest-btn');
  if(deleteBtn) deleteBtn.style.display='block';
  const masterPickBtn=document.getElementById('guest-master-pick-btn');
  if(masterPickBtn) masterPickBtn.style.display='none';
  const masterUpdateBtn=document.getElementById('guest-master-update-btn');
  if(masterUpdateBtn) masterUpdateBtn.style.display='block';
  const hasPhone=g.contact&&g.contact.replace(/\D/g,'').length>=10;
  const inviteBtn=document.getElementById('send-invite-btn');
  if(inviteBtn) inviteBtn.style.display=hasPhone?'block':'none';
  const primaryRoom=getGuestRoomAssignments(g)[0]||{loc:g.roomLoc||'',no:g.roomNo||''};
  populateRoomSelects(primaryRoom.loc,primaryRoom.no);
  openModal('add-guest');
  document.getElementById('g-first')?.focus();
}

function saveGuest(){
  const first=document.getElementById('g-first').value.trim();
  if(!first){toast('⚠️ Please enter a first name');return;}
  const last=document.getElementById('g-last').value.trim();
  const gContact=document.getElementById('g-contact').value.trim();
  if(normalizePhoneValue(gContact).length>15){toast('⚠️ Mobile number cannot be more than 15 digits');return;}
  const gEmail=document.getElementById('g-email').value.trim().toLowerCase();
  const roomLoc=document.getElementById('g-room-loc').value;
  const roomNo=document.getElementById('g-room-no').value;
  if(_editing.guest){
    const g=DB.guests.find(x=>x.id===_editing.guest);
    if(g){
      ensureGuestRequestDefaults(g);
      g.first=first;g.last=last;
      g.contact=gContact;
      g.email=gEmail;
      g.party=parseInt(document.getElementById('g-party').value)||1;
      g.rsvp=document.getElementById('g-rsvp').value;
      g.notes=document.getElementById('g-notes').value.trim();
      g.table=document.getElementById('g-table').value.trim();
      if(roomLoc&&roomNo){
        const rooms=getGuestRoomAssignments(g);
        if(rooms.length){
          rooms[0]={loc:roomLoc,no:roomNo};
          g.roomAssignments=rooms;
        } else {
          g.roomAssignments=[{loc:roomLoc,no:roomNo}];
        }
      } else if(getGuestRoomAssignments(g).length<=1){
        g.roomAssignments=[];
      }
      syncGuestPrimaryRoom(g);
      recomputeGuestRoomRequestStatus(g);
      rememberLastGuestGroup(g.table);
    }
    toast('Guest updated');
  } else {
    DB.guests.push({
      id:uid(),eventId:DB.activeEvent,
      first,last,
      contact:gContact,
      email:gEmail,
      party:parseInt(document.getElementById('g-party').value)||1,
      rsvp:document.getElementById('g-rsvp').value,
      notes:document.getElementById('g-notes').value.trim(),
      table:document.getElementById('g-table').value.trim(),
      roomLoc,roomNo,
      roomAssignments:roomLoc&&roomNo?[{loc:roomLoc,no:roomNo}]:[],
      roomRequestType:'undecided',
      requestedRoomCount:1,
      requestedStayCount:parseInt(document.getElementById('g-party').value)||1,
      roomRequestNote:'',
      roomRequestStatus:roomLoc&&roomNo?'fulfilled':'none',
      feedbackFoodRating:0,
      feedbackEventRating:0,
      feedbackRoomRating:0,
      feedbackMessage:'',
      foodMenuLikes:[],
      createdAt:Date.now()
    });
    rememberLastGuestGroup(document.getElementById('g-table').value.trim());
    toast(`${first} added`);
  }
  save();syncActiveEventData();closeModal('add-guest');closeModal('guest-detail');render();
}

function getGuestFormCandidate(){
  return {
    first: document.getElementById('g-first')?.value.trim()||'',
    last: document.getElementById('g-last')?.value.trim()||'',
    contact: document.getElementById('g-contact')?.value.trim()||'',
    email: document.getElementById('g-email')?.value.trim().toLowerCase()||'',
    notes: document.getElementById('g-notes')?.value.trim()||'',
    group: document.getElementById('g-table')?.value.trim()||''
  };
}

function addCurrentGuestToMaster(){
  const candidate=getGuestFormCandidate();
  const result=addGuestToMasterList(candidate);
  if(result.added && document.getElementById('mo-master-guests')?.classList.contains('open')){
    renderMasterGuestList();
  }
}

async function exportCurrentEventToMaster(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  const eventGuests=DB.guests.filter(g=>g.eventId===DB.activeEvent);
  if(!eventGuests.length){toast('⚠️ No guests in this event');return;}
  let added=0;
  let updated=0;
  let skipped=0;
  for(const guest of eventGuests){
    const candidate=normalizeMasterGuestCandidate(guest);
    const match=findMasterGuestMatch(candidate);
    if(!match){
      const result=saveMasterGuestRecord(candidate);
      if(result.saved) added++;
      else skipped++;
      continue;
    }
    const candidateHasEmail=!!normalizeEmailValue(candidate.email);
    const candidateHasPhone=!!normalizePhoneValue(candidate.contact);
    const existingHasEmail=!!normalizeEmailValue(match.existing.email);
    const existingHasPhone=!!normalizePhoneValue(match.existing.contact);
    if(match.type==='email' || match.type==='phone'){
      const result=saveMasterGuestRecord(candidate,{updateId:match.existing.id});
      if(result.saved) updated++;
      else skipped++;
      continue;
    }
    if(match.type==='name' && !candidateHasEmail && !candidateHasPhone && !existingHasEmail && !existingHasPhone){
      skipped++;
      continue;
    }
    const choice=await openMasterGuestConflictModal({
      title:'Matching Saved Guest Found',
      sub:'A duplicate guest was found in the master guest list. Do you want to update the existing saved guest or create a new entry?',
      candidate,
      existing:match.existing,
      updateLabel:'Update Existing',
      createLabel:'Create New Entry'
    });
    if(choice==='update'){
      const result=saveMasterGuestRecord(candidate,{updateId:match.existing.id});
      if(result.saved) updated++;
      else skipped++;
    } else if(choice==='create'){
      const result=saveMasterGuestRecord(candidate,{forceNew:true});
      if(result.saved) added++;
      else skipped++;
    } else {
      skipped++;
    }
  }
  renderMasterGuestList();
  toast(`${added} added · ${updated} updated${skipped?` · ${skipped} skipped`:''}`);
}

function getPendingMasterGuestShareCount(){
  return _incomingMasterGuestShares.filter(item=>item.status==='pending').length;
}

function getFilteredMasterGuests(){
  const q=_masterGuestSearch.trim().toLowerCase();
  const normalizedQueryPhone=normalizePhoneValue(q);
  return DB.masterGuests.filter(guest=>{
    const name=fullGuestName(guest).toLowerCase();
    const email=normalizeEmailValue(guest.email);
    const phone=normalizePhoneValue(guest.contact);
    const group=(guest.group||'').trim().toLowerCase();
    const notes=(guest.notes||'').trim().toLowerCase();
    return !q || name.includes(q) || email.includes(q) || group.includes(q) || notes.includes(q) || (normalizedQueryPhone && phone.includes(normalizedQueryPhone));
  });
}

function getMasterGuestSections(items){
  const grouped=new Map();
  const ungrouped=[];
  items.forEach(guest=>{
    const group=(guest.group||'').trim();
    if(group){
      if(!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(guest);
    } else {
      ungrouped.push(guest);
    }
  });
  const sections=Array.from(grouped.entries())
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([name, guests])=>({ key:`group:${name}`, label:name, guests:guests.sort((a,b)=>fullGuestName(a).localeCompare(fullGuestName(b))) }));
  if(ungrouped.length){
    sections.push({ key:'group:', label:'Ungrouped', guests:ungrouped.sort((a,b)=>fullGuestName(a).localeCompare(fullGuestName(b))) });
  }
  return sections;
}

function getSelectedMasterGuests(){
  return DB.masterGuests.filter(guest=>_masterGuestSelectedIds.has(guest.id));
}

function updateMasterGuestShareButtonState(){
  const shareBtn=document.getElementById('master-guest-share-btn');
  if(!shareBtn) return;
  const count=_masterGuestSelectedIds.size;
  shareBtn.disabled=count===0;
  shareBtn.style.opacity=count===0?'.55':'1';
  shareBtn.textContent=count?`Share Selected (${count})`:'Share Selected';
}

function toggleMasterGuestSelection(id){
  if(!_masterGuestSelectedIds.has(id)) _masterGuestSelectedIds.add(id);
  else _masterGuestSelectedIds.delete(id);
  renderMasterGuestList();
}

function toggleMasterGuestGroupSelection(encodedGroup){
  const name=decodeURIComponent(encodedGroup||'');
  const guests=DB.masterGuests.filter(item=>(item.group||'').trim()===name);
  if(!guests.length) return;
  const allSelected=guests.every(item=>_masterGuestSelectedIds.has(item.id));
  guests.forEach(item=>{
    if(allSelected) _masterGuestSelectedIds.delete(item.id);
    else _masterGuestSelectedIds.add(item.id);
  });
  renderMasterGuestList();
}

function clearMasterGuestSelection(){
  _masterGuestSelectedIds.clear();
  updateMasterGuestShareButtonState();
}

function formatMasterGuestShareSummary(share){
  const guestCount=Array.isArray(share?.guests)?share.guests.length:0;
  const groupCount=Array.isArray(share?.groupNames)?share.groupNames.length:0;
  if(groupCount && guestCount){
    return `${guestCount} guest${guestCount!==1?'s':''} from ${groupCount} group${groupCount!==1?'s':''}`;
  }
  if(groupCount){
    return `${groupCount} group${groupCount!==1?'s':''} shared`;
  }
  return `${guestCount} guest${guestCount!==1?'s':''} shared`;
}

function renderMasterGuestShares(){
  const container=document.getElementById('master-guest-shares-list');
  if(!container) return;
  const incoming=_incomingMasterGuestShares;
  const sent=_sentMasterGuestShares;
  if(!incoming.length && !sent.length){
    container.innerHTML='<div class="empty" style="padding:24px 16px"><div class="empty-t" style="font-size:18px">No shared lists yet</div><div class="empty-s">Shared guest lists you send or receive will show up here.</div></div>';
    return;
  }
  const renderCard=(share,type)=>{
    const peer=type==='incoming'?(share.senderName||share.senderEmail):(share.recipientEmail||'');
    const status=(share.status||'pending').replace(/^\w/,m=>m.toUpperCase());
    const action=type==='incoming' && share.status==='pending'
      ? `<button class="ev-btn" style="padding:6px 10px" onclick="App.acceptMasterGuestShare('${share.id}')">Accept</button>`
      : `<span class="chip" style="white-space:nowrap">${status}</span>`;
    const groups=(share.groupNames||[]).length?`Groups: ${(share.groupNames||[]).join(', ')}`:'';
    return `<div class="g-row" style="align-items:flex-start">
      <div class="g-av" style="${avStyle(share.id)}">${type==='incoming'?'IN':'OU'}</div>
      <div class="g-info">
        <div class="g-name">${type==='incoming'?'From':'To'} ${peer}</div>
        <div class="g-detail">${formatMasterGuestShareSummary(share)} · ${fmtDateTime(share.createdAt||Date.now())}${groups?` · ${groups}`:''}</div>
      </div>
      <div class="g-actions">${action}</div>
    </div>`;
  };
  container.innerHTML=
    (incoming.length?`<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--txt3);margin:4px 0 10px">Incoming</div>${incoming.map(item=>renderCard(item,'incoming')).join('')}`:'')+
    (sent.length?`<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--txt3);margin:${incoming.length?'18px':'4px'} 0 10px">Sent</div>${sent.map(item=>renderCard(item,'sent')).join('')}`:'');
}

function openMasterGuestShares(){
  renderMasterGuestShares();
  openModal('master-guest-shares');
}

function openMasterGuestShareComposer(){
  const selectedGuests=getSelectedMasterGuests();
  if(!selectedGuests.length){
    toast('⚠️ Select at least one guest or group');
    return;
  }
  const groups=[...new Set(selectedGuests.map(item=>(item.group||'').trim()).filter(Boolean))];
  const preview=document.getElementById('master-guest-share-preview');
  const emailInput=document.getElementById('master-guest-share-email');
  if(preview) preview.textContent=`${selectedGuests.length} guest${selectedGuests.length!==1?'s':''}${groups.length?` · Groups: ${groups.join(', ')}`:''}`;
  if(emailInput) emailInput.value='';
  openModal('master-guest-share');
  setTimeout(()=>emailInput?.focus(),20);
}

async function sendMasterGuestShare(){
  const session=Auth.currentSession();
  if(!session){toast('⚠️ Sign in first');return;}
  const emailInput=document.getElementById('master-guest-share-email');
  const recipientEmail=normalizeEmailValue(emailInput?.value||'');
  if(!recipientEmail || !/\S+@\S+\.\S+/.test(recipientEmail)){
    toast('⚠️ Enter a valid Eventise user email');
    return;
  }
  if(recipientEmail===normalizeEmailValue(session.email)){
    toast('⚠️ Choose another Eventise user');
    return;
  }
  const selectedGuests=getSelectedMasterGuests().map(guest=>normalizeMasterGuestCandidate(guest));
  if(!selectedGuests.length){
    toast('⚠️ Select at least one guest or group');
    return;
  }
  const share={
    id: uid(),
    senderEmail: normalizeEmailValue(session.email),
    senderName: session.name||session.email,
    recipientEmail,
    status:'pending',
    createdAt:Date.now(),
    updatedAt:Date.now(),
    guests:selectedGuests,
    guestIds:selectedGuests.map(item=>item.id),
    groupNames:[...new Set(selectedGuests.map(item=>item.group).filter(Boolean))]
  };
  try{
    await Cloud.createMasterGuestShare(share);
    closeModal('master-guest-share');
    clearMasterGuestSelection();
    renderMasterGuestList();
    toast(`Shared ${selectedGuests.length} guest${selectedGuests.length!==1?'s':''}`);
  }catch(e){
    toast('⚠️ Could not share guest list');
  }
}

function importSharedMasterGuests(guests){
  let added=0;
  let updated=0;
  let skipped=0;
  (guests||[]).forEach(guest=>{
    const candidate=normalizeMasterGuestCandidate(guest);
    if(!candidate.first){
      skipped++;
      return;
    }
    const match=findMasterGuestMatch(candidate);
    if(match?.type==='email'){
      const result=saveMasterGuestRecord(candidate,{updateId:match.existing.id});
      result.saved?updated++:skipped++;
      return;
    }
    if(match?.type==='phone' && !normalizeEmailValue(candidate.email)){
      const result=saveMasterGuestRecord(candidate,{updateId:match.existing.id});
      result.saved?updated++:skipped++;
      return;
    }
    if(match?.type==='name' && !normalizeEmailValue(candidate.email) && !normalizePhoneValue(candidate.contact)){
      skipped++;
      return;
    }
    const result=saveMasterGuestRecord(candidate,{forceNew:true});
    result.saved?added++:skipped++;
  });
  return {added,updated,skipped};
}

async function acceptMasterGuestShare(id){
  const share=_incomingMasterGuestShares.find(item=>item.id===id);
  if(!share){toast('⚠️ Shared list not found');return;}
  if(share.status!=='pending'){
    toast('This shared list was already processed');
    return;
  }
  const result=importSharedMasterGuests(share.guests||[]);
  renderMasterGuestList();
  try{
    await Cloud.updateMasterGuestShare(id,{status:'accepted',acceptedAt:Date.now()});
  }catch(e){}
  toast(`${result.added} added · ${result.updated} updated${result.skipped?` · ${result.skipped} skipped`:''}`);
}

function renderMasterGuestList(){
  const container=document.getElementById('master-guest-list');
  if(!container) return;
  const items=getFilteredMasterGuests();
  updateMasterGuestShareButtonState();
  if(!items.length){
    container.innerHTML=`<div class="empty" style="padding:24px 16px"><div class="empty-t" style="font-size:18px">No saved guests</div><div class="empty-s">${_masterGuestSearch?'Try a different search term.':'Save guests here to reuse them in future events.'}</div></div>`;
    return;
  }
  const sections=getMasterGuestSections(items);
  container.innerHTML=sections.map(section=>{
    const groupGuests=section.guests;
    const isNamedGroup=section.label!=='Ungrouped';
    const groupSelected=isNamedGroup && groupGuests.every(item=>_masterGuestSelectedIds.has(item.id));
    const header=isNamedGroup || groupGuests.length!==items.length
      ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:${section===sections[0]?'4px':'18px'} 0 10px">
          <div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--txt3)">${section.label}</div>
          ${_masterGuestMode==='manage'&&isNamedGroup?`<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--txt3);cursor:pointer"><input type="checkbox" ${groupSelected?'checked':''} onchange="App.toggleMasterGuestGroupSelection('${encodeURIComponent(section.label)}')" /> Select group</label>`:''}
        </div>`
      : '';
    const rows=groupGuests.map(guest=>{
    const name=fullGuestName(guest)||'Unknown guest';
    const subParts=[guest.email||guest.contact||'No email or phone saved'];
    if(guest.group) subParts.push(`Group: ${guest.group}`);
    if(guest.notes) subParts.push(guest.notes);
    const sub=subParts.join(' · ');
    const selected=_masterGuestSelectedIds.has(guest.id);
    const selector=_masterGuestMode==='manage'
      ? `<label style="display:flex;align-items:center;padding-right:8px;cursor:pointer" onclick="event.stopPropagation()"><input type="checkbox" ${selected?'checked':''} onchange="App.toggleMasterGuestSelection('${guest.id}')" /></label>`
      : '';
    const action=_masterGuestMode==='pick'
      ? `<button class="ev-btn" style="padding:6px 10px" onclick="event.stopPropagation();App.pickMasterGuest('${guest.id}')">Use</button>`
      : `<button class="ev-btn" style="padding:6px 9px" onclick="event.stopPropagation();App.openMasterGuestEditor('${guest.id}')" title="Edit saved guest" aria-label="Edit saved guest">${uiIcon('edit',14)}</button>
         <button class="ev-btn" style="padding:6px 9px;color:#932B2B" onclick="event.stopPropagation();App.confirmDeleteMasterGuest('${guest.id}')" title="Delete saved guest" aria-label="Delete saved guest">X</button>`;
    return `<div class="g-row" ${_masterGuestMode==='pick'?`onclick="App.pickMasterGuest('${guest.id}')"`:''}>
      ${selector}
      <div class="g-av" style="${avStyle(guest.id)}">${initials(guest.first,guest.last)}</div>
      <div class="g-info">
        <div class="g-name">${name}</div>
        <div class="g-detail">${sub}</div>
      </div>
      ${action?`<div class="g-actions">${action}</div>`:''}
    </div>`;
    }).join('');
    return header+rows;
  }).join('');
}

function openMasterGuestModal(mode='manage'){
  if(mode==='manage' && DB.activeEvent && !Auth.isOrganizer(DB.activeEvent)){
    toast('⚠️ Only Organisers can manage the master guest list');
    return;
  }
  _masterGuestMode=mode;
  _masterGuestSearch='';
  clearMasterGuestSelection();
  const title=document.getElementById('master-guest-title');
  const sub=document.getElementById('master-guest-sub');
  const search=document.getElementById('master-guest-search');
  const addBtn=document.getElementById('master-guest-add-btn-replacement')||document.getElementById('master-guest-add-btn');
  const originalAddBtn=document.getElementById('master-guest-add-btn');
  const shareBtn=document.getElementById('master-guest-share-btn');
  const inboxBtn=document.getElementById('master-guest-inbox-btn');
  const pendingCount=document.getElementById('master-guest-inbox-count');
  const pendingTotal=getPendingMasterGuestShareCount();
  if(title) title.textContent=mode==='pick'?'Pick from Master Guest List':'Master Guest List';
  if(sub) sub.textContent=mode==='pick'?'Choose a saved guest to fill this event guest form quickly.':'Save guests once and reuse them in future events.';
  if(search) search.value='';
  if(addBtn) addBtn.style.display=mode==='manage'?'block':'none';
  if(originalAddBtn && originalAddBtn!==addBtn) originalAddBtn.style.display='none';
  if(shareBtn) shareBtn.style.display=mode==='manage'?'block':'none';
  if(inboxBtn) inboxBtn.style.display=mode==='manage'?'inline-flex':'none';
  if(pendingCount){
    pendingCount.textContent=pendingTotal?String(pendingTotal):'';
    pendingCount.style.display=pendingTotal?'inline-flex':'none';
  }
  renderMasterGuestList();
  openModal('master-guests');
}

function filterMasterGuests(query){
  _masterGuestSearch=query||'';
  renderMasterGuestList();
}

function pickMasterGuest(id){
  const guest=DB.masterGuests.find(item=>item.id===id);
  if(!guest) return;
  document.getElementById('g-first').value=guest.first||'';
  document.getElementById('g-last').value=guest.last||'';
  document.getElementById('g-contact').value=guest.contact||'';
  document.getElementById('g-email').value=guest.email||'';
  document.getElementById('g-notes').value=guest.notes||'';
  document.getElementById('g-table').value=guest.group||'';
  closeModal('master-guests');
  toast('Guest details filled from master list');
}

function resolveMasterGuestConflict(choice){
  const resolver=_masterGuestConflictResolver;
  _masterGuestConflictResolver=null;
  closeModal('master-guest-resolve');
  if(resolver) resolver(choice);
}

async function updateEventGuestToMaster(){
  const candidate=getGuestFormCandidate();
  if(!candidate.first){toast('⚠️ Add at least a first name');return;}
  const match=findMasterGuestMatch(candidate);
  if(match?.type==='email'){
    const result=saveMasterGuestRecord(candidate,{updateId:match.existing.id});
    if(result.saved){ renderMasterGuestList(); toast('Master inventory updated using email match'); }
    return;
  }
  if(match?.type==='phone' && !normalizeEmailValue(candidate.email)){
    const result=saveMasterGuestRecord(candidate,{updateId:match.existing.id});
    if(result.saved){ renderMasterGuestList(); toast('Master inventory updated using phone match'); }
    return;
  }
  if(match?.type==='name' && !normalizeEmailValue(candidate.email) && !normalizePhoneValue(candidate.contact)){
    const choice=await openMasterGuestConflictModal({
      title:'Name Match Found',
      sub:'A saved guest with the same name already exists. Do you want to update that saved guest or create a new entry?',
      candidate,
      existing:match.existing,
      updateLabel:'Update Existing',
      createLabel:'Create New Entry'
    });
    if(choice==='update'){
      const result=saveMasterGuestRecord(candidate,{updateId:match.existing.id});
      if(result.saved){ renderMasterGuestList(); toast('Master inventory updated'); }
    } else if(choice==='create'){
      const result=saveMasterGuestRecord(candidate,{forceNew:true});
      if(result.saved){ renderMasterGuestList(); toast('New master inventory entry created'); }
    }
    return;
  }
  const result=saveMasterGuestRecord(candidate,{forceNew:true});
  if(result.saved){ renderMasterGuestList(); toast('Guest added to master inventory'); }
}

function openMasterGuestEditor(id=null){
  _editingMasterGuest=id;
  const guest=id?DB.masterGuests.find(item=>item.id===id):null;
  document.getElementById('master-guest-editor-title').textContent=guest?'Edit Saved Guest':'Add Saved Guest';
  document.getElementById('mg-first').value=guest?.first||'';
  document.getElementById('mg-last').value=guest?.last||'';
  document.getElementById('mg-contact').value=guest?.contact||'';
  document.getElementById('mg-email').value=guest?.email||'';
  document.getElementById('mg-notes').value=guest?.notes||'';
  document.getElementById('mg-group').value=guest?.group||'';
  document.getElementById('master-guest-delete-btn').style.display=guest?'block':'none';
  openModal('master-guest-editor');
}

function saveMasterGuest(){
  const candidate=normalizeMasterGuestCandidate({
    id:_editingMasterGuest||uid(),
    first:document.getElementById('mg-first').value.trim(),
    last:document.getElementById('mg-last').value.trim(),
    contact:document.getElementById('mg-contact').value.trim(),
    email:document.getElementById('mg-email').value.trim(),
    notes:document.getElementById('mg-notes').value.trim(),
    group:document.getElementById('mg-group').value.trim(),
    createdAt:_editingMasterGuest?(DB.masterGuests.find(item=>item.id===_editingMasterGuest)?.createdAt||Date.now()):Date.now()
  });
  if(!candidate.first){toast('⚠️ Add at least a first name');return;}
  if(normalizePhoneValue(candidate.contact).length>15){toast('⚠️ Mobile number cannot be more than 15 digits');return;}
  const duplicate=DB.masterGuests.find(item=>item.id!==candidate.id&&isMasterGuestDuplicate(candidate,item));
  if(duplicate){toast('⚠️ A matching saved guest already exists');return;}
  const idx=DB.masterGuests.findIndex(item=>item.id===candidate.id);
  if(idx>=0) DB.masterGuests[idx]=candidate;
  else DB.masterGuests.push(candidate);
  DB.masterGuests.sort((a,b)=>fullGuestName(a).localeCompare(fullGuestName(b)));
  save();
  renderMasterGuestList();
  closeModal('master-guest-editor');
  toast(idx>=0?'Saved guest updated':'Saved guest added');
}

function confirmDeleteMasterGuest(id){
  const gid=id||_editingMasterGuest;
  const guest=DB.masterGuests.find(item=>item.id===gid);
  if(!guest) return;
  openConfirm(`Delete ${fullGuestName(guest)||'saved guest'}?`,'This guest will be removed from the master guest list.',()=>{
    DB.masterGuests=DB.masterGuests.filter(item=>item.id!==gid);
    save();
    renderMasterGuestList();
    closeModal('master-guest-editor');
    toast('Saved guest removed');
  });
}

function deleteGuestById(gid){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g) return;
  scheduleGuestUndo(g);
  DB.guests=DB.guests.filter(x=>x.id!==gid);
  save();syncActiveEventData();closeModal('add-guest');closeModal('guest-detail');render();toast('Guest removed');
}

function isEventGuestDuplicate(candidate){
  if(!DB.activeEvent) return false;
  const candidateEmail=normalizeEmailValue(candidate.email);
  const candidatePhone=normalizePhoneValue(candidate.contact);
  const candidateName=fullGuestName(candidate).toLowerCase();
  return DB.guests.some(guest=>{
    if(guest.eventId!==DB.activeEvent) return false;
    const guestEmail=normalizeEmailValue(guest.email);
    const guestPhone=normalizePhoneValue(guest.contact);
    const guestName=fullGuestName(guest).toLowerCase();
    if(candidateEmail && guestEmail && candidateEmail===guestEmail) return true;
    if(candidatePhone && guestPhone && candidatePhone===guestPhone) return true;
    if(candidateName && guestName===candidateName && !candidateEmail && !guestEmail && !candidatePhone && !guestPhone) return true;
    return false;
  });
}

function createEventGuestFromMaster(masterGuest){
  return {
    id: uid(),
    eventId: DB.activeEvent,
    first: (masterGuest.first||'').trim(),
    last: (masterGuest.last||'').trim(),
    contact: (masterGuest.contact||'').trim(),
    email: normalizeEmailValue(masterGuest.email||''),
    party: 1,
    rsvp: 'pending',
    notes: (masterGuest.notes||'').trim(),
    table: (masterGuest.group||masterGuest.table||'').trim(),
    roomLoc: '',
    roomNo: '',
    roomAssignments: [],
    roomRequestType: 'undecided',
    requestedRoomCount: 1,
    requestedStayCount: 1,
    roomRequestNote: '',
    roomRequestStatus: 'none',
    feedbackFoodRating: 0,
    feedbackEventRating: 0,
    feedbackRoomRating: 0,
    feedbackMessage: '',
    foodMenuLikes: [],
    createdAt: Date.now()
  };
}

function addMasterGuestsToActiveEvent(masterGuests){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return {added:0, skipped:0};}
  let added=0;
  let skipped=0;
  masterGuests.forEach(masterGuest=>{
    const normalized=normalizeMasterGuestCandidate(masterGuest);
    if(!normalized.first){ skipped++; return; }
    if(isEventGuestDuplicate(normalized)){ skipped++; return; }
    DB.guests.push(createEventGuestFromMaster(normalized));
    added++;
  });
  if(added){
    save();
    syncActiveEventData();
    render();
  }
  return {added, skipped};
}

function getMasterGuestGroups(){
  const groups=new Map();
  DB.masterGuests
    .filter(guest=>(guest.group||'').trim())
    .forEach(guest=>{
      const name=(guest.group||'').trim();
      if(!groups.has(name)) groups.set(name, []);
      groups.get(name).push(guest);
    });
  return Array.from(groups.entries())
    .map(([name, guests])=>({ name, guests }))
    .sort((a,b)=>a.name.localeCompare(b.name));
}

function renderGroupInviteModal(){
  const container=document.getElementById('group-invite-list');
  if(!container) return;
  const q=_groupInviteSearch.trim().toLowerCase();
  const normalizedQueryPhone=normalizePhoneValue(q);
  const groups=getMasterGuestGroups().filter(group=>{
    if(!q) return true;
    return group.name.toLowerCase().includes(q) || group.guests.some(guest=>{
      const name=fullGuestName(guest).toLowerCase();
      const email=normalizeEmailValue(guest.email);
      const phone=normalizePhoneValue(guest.contact);
      return name.includes(q) || email.includes(q) || (normalizedQueryPhone && phone.includes(normalizedQueryPhone));
    });
  });
  const guests=DB.masterGuests.filter(guest=>{
    if(!q) return true;
    const name=fullGuestName(guest).toLowerCase();
    const email=normalizeEmailValue(guest.email);
    const phone=normalizePhoneValue(guest.contact);
    const group=(guest.group||'').toLowerCase();
    return name.includes(q) || email.includes(q) || group.includes(q) || (normalizedQueryPhone && phone.includes(normalizedQueryPhone));
  });
  if(!groups.length && !guests.length){
    container.innerHTML=`<div class="empty" style="padding:24px 16px"><div class="empty-t" style="font-size:18px">No saved guests found</div><div class="empty-s">${_groupInviteSearch?'Try a different search term.':'Save guests in the master guest list first, then add them here.'}</div></div>`;
    return;
  }
  const groupSection=groups.length?`
    <div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--txt3);margin:4px 0 10px">Groups</div>
    ${groups.map(group=>{
      const total=group.guests.length;
      const existing=group.guests.filter(isEventGuestDuplicate).length;
      const ready=Math.max(0,total-existing);
      return `<div class="g-row" style="align-items:flex-start">
        <div class="g-av" style="${avStyle(group.name)}">${initials(group.name)}</div>
        <div class="g-info">
          <div class="g-name">${group.name}</div>
          <div class="g-detail">${total} saved guest${total!==1?'s':''}${existing?` · ${existing} already in event`:''}</div>
        </div>
        <div class="g-actions">
          <button class="ev-btn" style="padding:6px 10px;${ready===0?'opacity:.5;cursor:not-allowed;':''}" onclick="event.stopPropagation();App.importMasterGroup('${encodeURIComponent(group.name)}')" ${ready===0?'disabled':''}>Add Group</button>
        </div>
      </div>`;
    }).join('')}
  `:'';
  const guestSection=guests.length?`
    <div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--txt3);margin:${groups.length?'16px':'4px'} 0 10px">Individual Guests</div>
    ${guests.map(guest=>{
      const name=fullGuestName(guest)||'Unknown guest';
      const subParts=[guest.email||guest.contact||'No email or phone saved'];
      if(guest.group) subParts.push(`Group: ${guest.group}`);
      if(guest.notes) subParts.push(guest.notes);
      const exists=isEventGuestDuplicate(guest);
      return `<div class="g-row" style="align-items:flex-start">
        <div class="g-av" style="${avStyle(guest.id)}">${initials(guest.first,guest.last)}</div>
        <div class="g-info">
          <div class="g-name">${name}</div>
          <div class="g-detail">${subParts.join(' · ')}${exists?' · Already in event':''}</div>
        </div>
        <div class="g-actions">
          <button class="ev-btn" style="padding:6px 10px;${exists?'opacity:.5;cursor:not-allowed;':''}" onclick="event.stopPropagation();App.importMasterGuest('${guest.id}')" ${exists?'disabled':''}>Add</button>
        </div>
      </div>`;
    }).join('')}
  `:'';
  container.innerHTML=groupSection+guestSection;
}

function filterGroupInvite(query){
  _groupInviteSearch=query||'';
  renderGroupInviteModal();
}

function importMasterGroup(groupName){
  const decodedName=decodeURIComponent(groupName||'').trim();
  const guests=DB.masterGuests.filter(guest=>(guest.group||'').trim()===decodedName);
  if(!guests.length){toast('⚠️ No saved guests found in this group');return;}
  const result=addMasterGuestsToActiveEvent(guests);
  renderGroupInviteModal();
  if(result.added){
    toast(`Added ${result.added} guest${result.added!==1?'s':''} from ${decodedName}${result.skipped?` · ${result.skipped} skipped`:''}`);
  } else {
    toast(`No new guests added from ${decodedName}${result.skipped?` · ${result.skipped} already in event`:''}`);
  }
}

function importMasterGuest(id){
  const guest=DB.masterGuests.find(item=>item.id===id);
  if(!guest){toast('⚠️ Saved guest not found');return;}
  const result=addMasterGuestsToActiveEvent([guest]);
  renderGroupInviteModal();
  if(result.added) toast(`${fullGuestName(guest)||'Guest'} added to this event`);
  else toast(`${fullGuestName(guest)||'Guest'} is already in this event`);
}

function openGroupInviteModal(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  if(!Auth.isOrganizer(DB.activeEvent)){toast('⚠️ Only Organisers can add guests from the master list');return;}
  _groupInviteSearch='';
  const search=document.getElementById('group-invite-search');
  if(search) search.value='';
  renderGroupInviteModal();
  openModal('group-invite');
}

function cycleRsvp(id){
  const g=DB.guests.find(x=>x.id===id);
  if(!g)return;
  const s=['pending','invited'];
  g.rsvp=s[(s.indexOf(g.rsvp)+1)%s.length];
  save();syncActiveEventData();render();toast(`${g.first}: ${g.rsvp}`);
}

function confirmDeleteGuest(id){
  const gid=id||_editing.guest;
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  if(DB.settings.removeGuestConfirmation===false){
    deleteGuestById(gid);
    return;
  }
  openConfirm(`Remove ${g.first} ${g.last}?`,'This guest will be removed from the list.',()=>{
    deleteGuestById(gid);
  });
}

function toggleGuestRowEdit(){
  _guestListEditMode=!_guestListEditMode;
  renderGuests();
}

function saveGuestRowEdit(){
  _guestListEditMode=false;
  renderGuests();
}

function openGuestDetail(id){
  const g=DB.guests.find(x=>x.id===id);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  ensureGuestFeedbackDefaults(g);
  const hasGuestFeedback=!!(g.feedbackMessage||g.feedbackUpdatedAt||g.feedbackFoodRating||g.feedbackEventRating||g.feedbackRoomRating);
  const linkedGifts=DB.gifts.filter(gi=>gi.eventId===DB.activeEvent&&gi.from&&gi.from.toLowerCase().includes((g.first+' '+g.last).toLowerCase().trim()));
  const rsvpOpts=['pending','invited'];
  const el=document.getElementById('guest-detail-content');
  const hasPhone=g.contact&&g.contact.replace(/\D/g,'').length>=10;
  const canViewRoomRequest=Auth.isOrganizer(DB.activeEvent);
  const canViewGuestFeedback=Auth.isOrganizer(DB.activeEvent);
  el.innerHTML=`
    <div class="detail-header">
      <div class="g-av" style="${avStyle(g.id)};width:44px;height:44px;font-size:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">${initials(g.first,g.last)}</div>
      <div class="detail-title">${g.first} ${g.last}</div>
      <button class="ib" onclick="App.openEditGuest('${g.id}');App.closeModal('guest-detail')" title="Edit guest" aria-label="Edit guest">${uiIcon('edit',16)}</button>
    </div>
    <div class="info-grid">
      ${g.contact?`<div class="info-cell"><div class="info-lbl">Phone</div><div class="info-val">${g.contact}</div></div>`:''}
      ${g.email?`<div class="info-cell"><div class="info-lbl">Email</div><div class="info-val">${g.email}</div></div>`:''}
      <div class="info-cell"><div class="info-lbl">Peoples</div><div class="info-val">${g.party||1}</div></div>
      ${g.table?`<div class="info-cell"><div class="info-lbl">Group</div><div class="info-val">${g.table}</div></div>`:''}
      ${getGuestRoomAssignments(g).length?`<div class="info-cell" style="grid-column:span 2"><div class="info-lbl">Assigned Rooms</div><div class="info-val">${formatGuestRooms(g)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Stay Request</div><div class="info-val">${roomRequestTypeLabel(g.roomRequestType)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Request Status</div><div class="info-val">${roomRequestStatusLabel(g.roomRequestStatus)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Rooms Requested</div><div class="info-val">${Math.max(1,parseInt(g.requestedRoomCount)||1)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Guests Staying</div><div class="info-val">${Math.max(1,parseInt(g.requestedStayCount)||g.party||1)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestNote?`<div class="info-cell" style="grid-column:span 2"><div class="info-lbl">Room Request Note</div><div class="info-val">${g.roomRequestNote}</div></div>`:''}
      ${canViewGuestFeedback&&hasGuestFeedback?`<div class="info-cell"><div class="info-lbl">Food Rating</div><div class="info-val">${renderFeedbackStars(g.feedbackFoodRating)}</div></div>`:''}
      ${canViewGuestFeedback&&hasGuestFeedback?`<div class="info-cell"><div class="info-lbl">Event Rating</div><div class="info-val">${renderFeedbackStars(g.feedbackEventRating)}</div></div>`:''}
      ${canViewGuestFeedback&&hasGuestFeedback?`<div class="info-cell"><div class="info-lbl">Room Rating</div><div class="info-val">${renderFeedbackStars(g.feedbackRoomRating)}</div></div>`:''}
      ${canViewGuestFeedback&&g.feedbackMessage?`<div class="info-cell" style="grid-column:span 2"><div class="info-lbl">Wishes and Feedback</div><div class="info-val">${g.feedbackMessage}</div></div>`:''}
      ${g.notes?`<div class="info-cell" style="grid-column:span 2"><div class="info-lbl">Notes</div><div class="info-val">${g.notes}</div></div>`:''}
    </div>
    ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div style="font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Room Request Actions</div>
    <div class="request-actions" style="margin:0 0 16px">
      ${g.roomRequestStatus==='pending'&&g.roomRequestType==='needs_room'
        ?`<button class="request-btn primary" onclick="App.prepareGuestRoomAssignment('${g.id}');App.closeModal('guest-detail')">Assign in Room Map</button>`
        :g.roomRequestStatus==='pending'
          ?`<button class="request-btn primary" onclick="App.resolveGuestRoomRequest('${g.id}','no_room_needed');App.openGuestDetail('${g.id}')">Mark Complete</button>`
          :''}
      ${getGuestRoomAssignments(g).length?`<button class="request-btn secondary" onclick="App.clearGuestRooms('${g.id}');App.closeModal('guest-detail')">Remove Rooms</button>`:''}
    </div>`:''}
    <div style="font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Invite Status</div>
    <div class="rsvp-big">
      ${rsvpOpts.map(s=>`<button class="rsvp-opt ${g.rsvp===s?'sel-'+s:''}" onclick="App.setRsvpDirect('${g.id}','${s}')">${s.charAt(0).toUpperCase()+s.slice(1)}</button>`).join('')}
    </div>
    ${hasPhone?`<button onclick="App.sendGuestInvite('${g.id}')" style="width:100%;padding:11px;background:#25D366;color:white;border:none;border-radius:var(--rs);font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px;transition:opacity .15s" onmouseover="this.style.opacity='.9'" onmouseout="this.style.opacity='1'"><svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg> Send WhatsApp Invite</button>`:''}
    ${linkedGifts.length>0?`<div class="linked-gifts">
      <div class="lg-title">Linked Gifts (${linkedGifts.length})</div>
      ${linkedGifts.map(gi=>{const meta=CAT_META[gi.cat]||CAT_META.other;return`<div class="lg-item"><span>${meta.label} · ${gi.desc}</span><span style="color:var(--sage-d);font-weight:500">${gi.value?fmtVal(gi.value):''}</span></div>`;}).join('')}
    </div>`:''}
    <button class="btn-s btn-danger" style="margin-top:16px" onclick="App.confirmDeleteGuest('${g.id}')">Remove Guest</button>
  `;
  openModal('guest-detail');
}

// ═══════════════════════════════════════════════
// ROOM LOCATION MANAGEMENT
// ═══════════════════════════════════════════════

function renderEventMenusEditor(){
  const container=document.getElementById('ev-food-menus');
  const addBtn=document.getElementById('ev-food-menu-add-btn');
  if(addBtn){
    addBtn.style.display=_eventMenuEditorDisabled?'none':'block';
    addBtn.textContent='+ Add Menu Section';
  }
  if(!container) return;
  const targetEventId=_eventFoodMenuModalEventId||_editing.event;
  const canViewLikes=!!targetEventId&&Auth.isOrganizer(targetEventId);
  const likeCounts=canViewLikes?getEventFoodLikeCounts(targetEventId):new Map();
  if(_eventMenusTemp.length===0){
    container.innerHTML=`<div style="font-size:12px;color:var(--txt3);line-height:1.6">Add one or more menu sections like Breakfast, Lunch, or Evening Snacks.</div>`;
    return;
  }
  container.innerHTML=_eventMenusTemp.map((menu,idx)=>`
    <div class="room-loc-block">
      <div class="room-loc-name" style="margin-bottom:10px">
        <input style="flex:1;background:transparent;border:none;outline:none;font-size:12.5px;font-weight:600;color:var(--txt2);font-family:'Plus Jakarta Sans',sans-serif" value="${menu.title||''}" placeholder="Section title (e.g. Breakfast)" oninput="App._updateEventMenuTitle(${idx},this.value)" ${_eventMenuEditorDisabled?'disabled':''} />
        ${_eventMenuEditorDisabled?'':`<button style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--txt4);padding:0 0 0 6px;font-weight:700" onclick="App._removeEventMenu(${idx})" title="Remove menu section">X</button>`}
      </div>
      <textarea class="fi" rows="4" style="resize:vertical" placeholder="Enter each menu item on a new line" oninput="App._updateEventMenuItems(${idx},this.value)" ${_eventMenuEditorDisabled?'disabled':''}>${menu.items||''}</textarea>
      ${canViewLikes?`<div style="margin-top:10px;padding:10px 12px;border-radius:12px;background:var(--surf);border:1px solid var(--bord2)">
        <div style="font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Guest Hearts</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--txt2);margin-bottom:${normalizeMenuItems(menu.items).length?'8px':'0'}${normalizeMenuItems(menu.items).length?';padding-bottom:8px;border-bottom:1px solid var(--bord2)':''}">
          <span style="line-height:1.5">${menu.title||'Menu'} section</span>
          <span style="flex-shrink:0;padding:3px 9px;border-radius:999px;background:${(likeCounts.get(getFoodMenuSectionLikeKey(menu))||0)?'var(--rose-l)':'var(--surf2)'};color:${(likeCounts.get(getFoodMenuSectionLikeKey(menu))||0)?'var(--rose-d)':'var(--txt3)'};font-weight:600">${likeCounts.get(getFoodMenuSectionLikeKey(menu))||0} heart${(likeCounts.get(getFoodMenuSectionLikeKey(menu))||0)===1?'':'s'}</span>
        </div>
        ${normalizeMenuItems(menu.items).length?`<div style="display:grid;gap:6px">
          ${normalizeMenuItems(menu.items).map(itemText=>{
            const count=likeCounts.get(getFoodMenuLikeKey(menu,itemText))||0;
            return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--txt2)">
                <span style="line-height:1.5">${itemText}</span>
                <span style="flex-shrink:0;padding:3px 9px;border-radius:999px;background:${count?'var(--rose-l)':'var(--surf2)'};color:${count?'var(--rose-d)':'var(--txt3)'};font-weight:600">${count} heart${count===1?'':'s'}</span>
              </div>`;
          }).join('')}
        </div>`:''}
      </div>`:''}
    </div>`).join('');
}

function addEventMenu(){
  _eventMenusTemp.push({title:'',items:''});
  renderEventMenusEditor();
}
function _updateEventMenuTitle(idx,val){ if(_eventMenusTemp[idx]) _eventMenusTemp[idx].title=val; }
function _updateEventMenuItems(idx,val){ if(_eventMenusTemp[idx]) _eventMenusTemp[idx].items=val; }
function _removeEventMenu(idx){
  _eventMenusTemp.splice(idx,1);
  renderEventMenusEditor();
}

function renderEventMenusDisplay(ev){
  const menus=normalizeEventMenus(ev?.foodMenus);
  if(!menus.length) return '';
  return `<div class="guest-card">
      <div class="guest-card-title">Food Menu</div>
      <div style="display:grid;gap:10px">
        ${menus.map(menu=>`<div style="padding:12px 14px;border-radius:var(--rs);background:var(--surf2);border:1px solid var(--bord2)">
            <div style="font-size:13px;font-weight:600;color:var(--txt);margin-bottom:6px">${menu.title||'Menu'}</div>
            <div style="font-size:12px;color:var(--txt2);line-height:1.7;white-space:pre-line">${menu.items||'Menu details coming soon.'}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderRoomLocsEditor(){
  const container=document.getElementById(_roomConfigEventId?'room-config-locs':'ev-room-locs');
  if(!container)return;
  if(_roomLocsTemp.length===0){container.innerHTML='';return;}
  container.innerHTML=_roomLocsTemp.map((loc,li)=>`
    <div class="room-loc-block">
      <div class="room-loc-name">
        <input style="flex:1;background:transparent;border:none;outline:none;font-size:12.5px;font-weight:600;color:var(--txt2);font-family:'Plus Jakarta Sans',sans-serif" value="${loc.name}" placeholder="Location name (e.g. Block A, Hall 1)" oninput="App._updateLocName(${li},this.value)" />
        <button style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--txt4);padding:0 0 0 6px;font-weight:700" onclick="App._removeLocation(${li})" title="Remove location">X</button>
      </div>
      <div class="room-list" id="room-list-${li}">
        ${loc.rooms.map((r,ri)=>`<span class="room-tag">${r}<button class="room-tag-del" onclick="App._removeRoom(${li},${ri})">X</button></span>`).join('')}
      </div>
      <div class="room-add-row">
        <input class="room-add-inp" id="room-inp-${li}" type="text" placeholder="e.g. 101 or 101,102 or 101-110" onkeydown="if(event.key==='Enter'){event.preventDefault();App._addRoom(${li})}" />
        <button class="room-add-btn" onclick="App._addRoom(${li})">＋ Add</button>
      </div>
    </div>`).join('');
}

function addRoomLocation(){
  _roomLocsTemp.push({name:'',rooms:[]});
  renderRoomLocsEditor();
  // focus the new name input
  const targetSelector=_roomConfigEventId?'#room-config-locs .room-loc-name input':'#ev-room-locs .room-loc-name input';
  const inputs=document.querySelectorAll(targetSelector);
  if(inputs.length)inputs[inputs.length-1].focus();
}

function _updateLocName(li,val){_roomLocsTemp[li].name=val;}

function _removeLocation(li){
  _roomLocsTemp.splice(li,1);
  renderRoomLocsEditor();
}

function _addRoom(li){
  const inp=document.getElementById(`room-inp-${li}`);
  if(!inp)return;
  const raw=inp.value.trim();
  if(!raw){toast('⚠️ Enter a room number or range');return;}
  // parse: "101,102,105" or "506-515" or "101, 102-105, 110"
  const parts=raw.split(',').map(s=>s.trim()).filter(Boolean);
  const toAdd=[];
  for(const part of parts){
    if(part.includes('-')){
      const [a,b]=part.split('-').map(s=>s.trim());
      const na=parseInt(a),nb=parseInt(b);
      if(!isNaN(na)&&!isNaN(nb)&&nb>=na){
        if(nb-na>200){toast('⚠️ Range too large (max 200)');return;}
        for(let i=na;i<=nb;i++)toAdd.push(String(i));
      } else {
        toAdd.push(part);
      }
    } else {
      toAdd.push(part);
    }
  }
  let added=0,skipped=0;
  for(const r of toAdd){
    if(_roomLocsTemp[li].rooms.includes(r)){skipped++;continue;}
    _roomLocsTemp[li].rooms.push(r);added++;
  }
  inp.value='';
  renderRoomLocsEditor();
  if(added>0&&skipped>0) toast(`Added ${added} rooms · ${skipped} already existed`);
  else if(added>0) toast(`${added} room${added>1?'s':''} added`);
  else toast('⚠️ All rooms already added');
  // re-focus the input for this block
  const newInp=document.getElementById(`room-inp-${li}`);
  if(newInp)newInp.focus();
}

function _removeRoom(li,ri){
  _roomLocsTemp[li].rooms.splice(ri,1);
  renderRoomLocsEditor();
}

function populateRoomSelects(selLoc='',selRoom=''){
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  const locs=(ev&&ev.roomLocs)||[];
  const locSel=document.getElementById('g-room-loc');
  const roomSel=document.getElementById('g-room-no');
  if(!locSel||!roomSel)return;
  locSel.innerHTML='<option value="">— None —</option>'+locs.map(l=>`<option value="${l.name}" ${l.name===selLoc?'selected':''}>${l.name}</option>`).join('');
  // populate rooms for selected loc
  const matchLoc=locs.find(l=>l.name===selLoc);
  roomSel.innerHTML='<option value="">— None —</option>'+(matchLoc?matchLoc.rooms.map(r=>`<option value="${r}" ${r===selRoom?'selected':''}>${r}</option>`).join(''):'');
}

function refreshRoomNumbers(){
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  const locs=(ev&&ev.roomLocs)||[];
  const locVal=document.getElementById('g-room-loc').value;
  const roomSel=document.getElementById('g-room-no');
  const matchLoc=locs.find(l=>l.name===locVal);
  roomSel.innerHTML='<option value="">— None —</option>'+(matchLoc?matchLoc.rooms.map(r=>`<option value="${r}">${r}</option>`).join(''):'');
  checkRoomConflict();
}

function checkRoomConflict(){
  const ind=document.getElementById('room-conflict-indicator');
  if(!ind)return;
  const locVal=document.getElementById('g-room-loc').value;
  const roomVal=document.getElementById('g-room-no').value;
  if(!locVal||!roomVal){ind.style.display='none';return;}
  const currentGuestId=_editing.guest;
  const occupied=DB.guests.filter(g=>
    g.eventId===DB.activeEvent&&
    getGuestRoomAssignments(g).some(room=>room.loc===locVal&&room.no===roomVal)&&
    g.id!==currentGuestId
  );
  if(occupied.length===0){ind.style.display='none';return;}
  const names=occupied.map(g=>`${g.first} ${g.last}`).join(', ');
  ind.style.display='block';
  ind.innerHTML=`<div class="room-conflict">Already allocated to: <span class="room-conflict-name">${names}</span></div>`;
}

// ═══════════════════════════════════════════════
// ROOMS SCREEN
// ═══════════════════════════════════════════════
function renderRooms(){
  const el=document.getElementById('scr-rooms');
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  const evSelHtml=`<div class="ev-sel" onclick="App.openModal('event-pick')">
    <div><div class="ev-sel-lbl">Current Event</div><div class="ev-sel-val">${ev?ev.name:'Select an event'}</div></div>
    <span class="chev">▼</span>
  </div>`;
  if(!ev){
    el.innerHTML=evSelHtml+`<div class="empty"><div class="empty-ico">${uiIcon('room',42)}</div><div class="empty-t">No event selected</div><div class="empty-s">Select an event to manage rooms</div></div>`;
    return;
  }
  if(ev._isGuestOnly){
    const me=ensureGuestRequestDefaults(getCurrentGuestInvite(ev.id));
    if(!me){
      el.innerHTML=evSelHtml+`<div class="empty"><div class="empty-ico">${uiIcon('room',42)}</div><div class="empty-t">Room details unavailable</div><div class="empty-s">We couldn't find your guest record for this invitation.</div></div>`;
      return;
    }
    const rooms=getGuestRoomAssignments(me);
    const requestsEnabled=isRoomRequestEnabled(ev);
    el.innerHTML=evSelHtml+
      `<div class="ph"><div class="ph-title">My Rooms</div><div class="ph-sub">${ev.name}</div></div>`+
      `<div class="guest-card">
        <div class="guest-card-title">Allocated Room Details</div>
        <div style="font-size:18px;font-weight:600;color:var(--txt);line-height:1.4">${formatGuestRooms(me)}</div>
        <div style="font-size:12px;color:var(--txt3);margin-top:6px">${rooms.length?`${rooms.length} room${rooms.length!==1?'s':''} assigned`:'No room has been assigned yet.'}</div>
      </div>`+
      `<div class="guest-card">
        <div class="guest-card-title">Stay Request Status</div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--txt)">${roomRequestTypeLabel(me.roomRequestType)}</div>
            <div style="font-size:12px;color:var(--txt3);margin-top:4px">${Math.max(1,parseInt(me.requestedRoomCount)||1)} room(s) requested · ${Math.max(1,parseInt(me.requestedStayCount)||me.party||1)} guest(s) staying</div>
            ${me.roomRequestNote?`<div style="font-size:12px;color:var(--txt2);margin-top:8px;line-height:1.5">${me.roomRequestNote}</div>`:''}
          </div>
          <span class="guest-room-status ${me.roomRequestStatus==='fulfilled'?'fulfilled':me.roomRequestStatus==='pending'?'pending':'none'}">${roomRequestStatusLabel(me.roomRequestStatus)}</span>
        </div>
      </div>`+
      `${requestsEnabled
        ? `<button class="fab" style="background:var(--slate-d)" onclick="App.openGuestRequestModal('${ev.id}')">Update Room Request</button>`
        : `<div class="guest-card"><div class="guest-card-title">Room Requests Closed</div><div style="font-size:13px;color:var(--txt2);line-height:1.6">The organiser has turned off guest room requests for this event. You can still view any room allocation shown above.</div></div>`}`;
    return;
  }
  if(!Auth.isRoom(DB.activeEvent)){
    el.innerHTML=evSelHtml+`<div class="empty"><div class="empty-ico">${uiIcon('room',42)}</div><div class="empty-t">Room access required</div><div class="empty-s">Only organisers and room coordinators can fulfill stay requests and allocate rooms.</div></div>`;
    return;
  }
  const locs=(ev.roomLocs)||[];
  if(locs.length===0){
    el.innerHTML=evSelHtml+
      `<div class="ph"><div class="ph-title">Room Management</div></div>`+
      `<div class="empty"><div class="empty-ico">${uiIcon('room',42)}</div><div class="empty-t">No rooms configured</div><div class="empty-s">Add room locations here to manage guest room allocation.</div></div>`+
      `<div class="floating-stack"><button class="floating-bubble floating-bubble-primary" type="button" title="Configure rooms" aria-label="Configure rooms" onclick="App.openRoomConfig('${ev.id}')" style="background:var(--slate-d);border-color:var(--slate-d)">${uiIcon('room',18)}<span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button></div>`;
    return;
  }
  // build stats
  const guests=DB.guests.filter(g=>g.eventId===DB.activeEvent).map(g=>ensureGuestRequestDefaults(g));
  const canReviewGuestRequests=Auth.isOrganizer(DB.activeEvent);
  const pendingRequests=canReviewGuestRequests?guests.filter(g=>g.roomRequestStatus==='pending'&&g.roomRequestType!=='undecided'):[];
  const totalRooms=locs.reduce((a,l)=>a+l.rooms.length,0);
  const occupiedRooms=new Set(guests.flatMap(g=>getGuestRoomAssignments(g).map(room=>room.loc+'||'+room.no))).size;
  const vacantRooms=totalRooms-occupiedRooms;
  let html=evSelHtml+
    `<div class="ph"><div class="ph-title">Room Management</div><div class="ph-sub">${totalRooms} rooms · ${occupiedRooms} occupied · ${vacantRooms} vacant</div></div>`+
    `<div class="stats-row">
      <div class="s-card"><span class="s-n">${totalRooms}</span><span class="s-l">Total</span></div>
      <div class="s-card"><span class="s-n" style="color:var(--rose-d)">${occupiedRooms}</span><span class="s-l">Occupied</span></div>
      <div class="s-card"><span class="s-n" style="color:${pendingRequests.length?'var(--gold-d)':'var(--sage-d)'}">${pendingRequests.length||vacantRooms}</span><span class="s-l">${pendingRequests.length?'Requests':'Vacant'}</span></div>
    </div>`+
    `<div class="room-legend">
      <div class="room-legend-item"><div class="room-legend-dot" style="background:var(--sage-m)"></div>Vacant</div>
      <div class="room-legend-item"><div class="room-legend-dot" style="background:var(--rose)"></div>Occupied</div>
      <div class="room-legend-item"><div class="room-legend-dot" style="background:#E67E22"></div>Multiple guests</div>
    </div>`;
  if(pendingRequests.length){
    html+=`<div class="guest-card">
      <div class="guest-card-title">Pending Guest Stay Requests</div>
      <div class="request-list">
        ${pendingRequests.map(g=>`
          <div class="request-row">
            <div class="request-row-top">
              <div>
                <div class="request-row-name">${g.first} ${g.last}</div>
                <div class="request-row-meta">
                  ${roomRequestTypeLabel(g.roomRequestType)} · ${Math.max(1,parseInt(g.requestedRoomCount)||1)} room(s) · ${Math.max(1,parseInt(g.requestedStayCount)||g.party||1)} guest(s)
                  ${getGuestRoomAssignments(g).length?`<br>Currently assigned: ${formatGuestRooms(g)}`:''}
                </div>
              </div>
              <span class="guest-room-status pending">${roomRequestStatusLabel(g.roomRequestStatus)}</span>
            </div>
            ${g.roomRequestNote?`<div style="font-size:12px;color:var(--txt2);line-height:1.5">${g.roomRequestNote}</div>`:''}
            <div class="request-actions">
              ${g.roomRequestType==='needs_room'
                ?`<button class="request-btn primary" onclick="App.prepareGuestRoomAssignment('${g.id}')">Assign in Room Map</button>`
                :`<button class="request-btn primary" onclick="App.resolveGuestRoomRequest('${g.id}','no_room_needed')">Mark Complete</button>`}
              <button class="request-btn secondary" onclick="App.openGuestDetail('${g.id}')">View Guest</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }
  locs.forEach(loc=>{
    const locGuests=guests.filter(g=>getGuestRoomAssignments(g).some(room=>room.loc===loc.name));
    html+=`<div class="room-loc-section">
      <div class="room-loc-header">
        <span class="room-loc-title">${loc.name}</span>
        <span class="room-loc-count">${locGuests.length} guests</span>
      </div>
      <div class="room-grid">`;
    loc.rooms.forEach(room=>{
      const roomGuests=guests.filter(g=>getGuestRoomAssignments(g).some(item=>item.loc===loc.name&&item.no===room));
      const isMulti=roomGuests.length>1;
      const isOccupied=roomGuests.length===1;
      const cellClass=isMulti?'multi':isOccupied?'occupied':'vacant';
      const guestNames=roomGuests.map(g=>`${g.first} ${g.last}`).join(', ');
      html+=`<div class="room-cell ${cellClass}" onclick="App.openRoomDetail('${loc.name}','${room}')">
        ${isMulti?`<span class="room-cell-badge">${roomGuests.length}</span>`:''}
        <span class="room-cell-no">${room}</span>
        ${roomGuests.length>0
          ?`<span class="room-cell-name" title="${guestNames}">${roomGuests[0].first}${roomGuests.length>1?' +'+( roomGuests.length-1):''}</span>`
          :`<span class="room-cell-vacant-lbl">Vacant</span>`}
      </div>`;
    });
    html+=`</div></div>`;
  });
  html+=`<div class="floating-stack"><button class="floating-bubble floating-bubble-primary" type="button" title="Configure rooms" aria-label="Configure rooms" onclick="App.openRoomConfig('${ev.id}')" style="background:var(--slate-d);border-color:var(--slate-d)">${uiIcon('room',18)}<span style="position:absolute;right:10px;top:7px;font-size:18px;font-weight:500;line-height:1">+</span></button></div>`;
  el.innerHTML=html;
}

let _roomAllocLoc='';
let _roomAllocNo='';
let _preferredRoomGuestId='';

function openRoomDetail(locName,roomNo){
  if(_directRoomAssignGuestId){
    const gid=_directRoomAssignGuestId;
    _directRoomAssignGuestId='';
    const g=DB.guests.find(x=>x.id===gid);
    if(!g){toast('⚠️ Guest not found');return;}
    if(getGuestRoomAssignments(g).some(room=>room.loc===locName&&room.no===roomNo)){
      toast(`${g.first} is already assigned to ${locName} Room ${roomNo}`);
      return;
    }
    ensureGuestRequestDefaults(g);
    addGuestRoomAssignment(g,locName,roomNo);
    recomputeGuestRoomRequestStatus(g);
    save();syncActiveEventData();
    _preferredRoomGuestId='';
    toast(`${g.first} assigned to ${locName} Room ${roomNo}`);
    renderRooms();
    return;
  }
  _roomAllocLoc=locName;
  _roomAllocNo=roomNo;
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  const allGuests=DB.guests.filter(g=>g.eventId===DB.activeEvent);
  const roomGuests=allGuests.filter(g=>getGuestRoomAssignments(g).some(room=>room.loc===locName&&room.no===roomNo));

  document.getElementById('mo-room-alloc-title').textContent=`Room ${roomNo}`;
  document.getElementById('mo-room-alloc-loc').textContent=locName;

  // Occupants section
  const occEl=document.getElementById('mo-room-occupants');
  if(roomGuests.length>0){
    occEl.innerHTML=`<div style="font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Current Occupants</div>`+
      roomGuests.map(g=>`<div style="display:flex;align-items:center;justify-content:space-between;background:var(--rose-l);border:1px solid var(--rose-m);border-radius:var(--rs);padding:10px 12px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:9px">
          <div style="${avStyle(g.id)};width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0">${initials(g.first,g.last)}</div>
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--txt)">${g.first} ${g.last}</div>
            <div style="font-size:11px;color:var(--txt3)">Peoples: ${g.party||1}${g.contact?' · '+g.contact:''}${getGuestRoomAssignments(g).length>1?` · ${getGuestRoomAssignments(g).length} rooms`:''}</div>
          </div>
        </div>
        <button onclick="event.stopPropagation();App.unassignGuestRoom('${g.id}','${encodeURIComponent(locName)}','${encodeURIComponent(roomNo)}')" style="background:#FEE8E8;color:#932B2B;border:1px solid #FABCBC;border-radius:var(--rxs);padding:4px 9px;font-size:13px;font-weight:700;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">X</button>
      </div>`).join('');
  } else {
    occEl.innerHTML=`<div style="background:var(--sage-l);border:1px solid var(--sage-m);border-radius:var(--rs);padding:10px 13px;margin-bottom:12px;font-size:12px;color:var(--sage-d)">Vacant — no guests assigned</div>`;
  }

  // Guest dropdown — show all guests, mark already-in-room ones
  const sel=document.getElementById('room-alloc-guest-sel');
  sel.innerHTML='<option value="">— Select a guest —</option>'+
    allGuests.map(g=>{
      const rooms=getGuestRoomAssignments(g);
      const inThisRoom=rooms.some(room=>room.loc===locName&&room.no===roomNo);
      const otherRooms=rooms.filter(room=>!(room.loc===locName&&room.no===roomNo));
      const label=`${g.first} ${g.last}`+(inThisRoom?' (this room)':otherRooms.length?` (${otherRooms.map(room=>room.loc+' #'+room.no).join(', ')})`:'');
      return`<option value="${g.id}" ${inThisRoom?'disabled':''}>${label}</option>`;
    }).join('');
  document.getElementById('room-alloc-conflict').style.display='none';
  if(_preferredRoomGuestId && allGuests.some(g=>g.id===_preferredRoomGuestId)){
    sel.value=_preferredRoomGuestId;
    onRoomAllocGuestChange();
  }
  openModal('room-alloc');
}

function onRoomAllocGuestChange(){
  const gid=document.getElementById('room-alloc-guest-sel').value;
  const conflictEl=document.getElementById('room-alloc-conflict');
  if(!gid){conflictEl.style.display='none';return;}
  const g=DB.guests.find(x=>x.id===gid);
  const rooms=getGuestRoomAssignments(g);
  if(g&&rooms.length){
    conflictEl.style.display='block';
    conflictEl.innerHTML=`<div class="room-conflict">Already assigned to ${rooms.map(room=>room.loc+' Room '+room.no).join(', ')} — this room will be added too</div>`;
  } else {
    conflictEl.style.display='none';
  }
}

function assignGuestToRoom(){
  const gid=document.getElementById('room-alloc-guest-sel').value;
  if(!gid){toast('Select a guest');return;}
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  addGuestRoomAssignment(g,_roomAllocLoc,_roomAllocNo);
  recomputeGuestRoomRequestStatus(g);
  save();syncActiveEventData();
  _preferredRoomGuestId='';
  toast(`${g.first} assigned to ${_roomAllocLoc} Room ${_roomAllocNo}`);
  closeModal('room-alloc');
  renderRooms();
}

function unassignGuestRoom(gid,encodedLoc='',encodedRoom=''){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  const targetLoc=encodedLoc?decodeURIComponent(encodedLoc):_roomAllocLoc;
  const targetRoom=encodedRoom?decodeURIComponent(encodedRoom):_roomAllocNo;
  if(!targetLoc || !targetRoom){
    toast('⚠️ Could not identify the room to remove');
    return;
  }
  const hadRoom=getGuestRoomAssignments(g).some(room=>room.loc===targetLoc&&room.no===targetRoom);
  if(!hadRoom){
    toast(`${g.first} is not assigned to ${targetLoc} Room ${targetRoom}`);
    return;
  }
  const name=`${g.first} ${g.last}`;
  removeGuestRoomAssignment(g,targetLoc,targetRoom);
  recomputeGuestRoomRequestStatus(g);
  save();syncActiveEventData();
  toast(`${name} unassigned from ${targetLoc} Room ${targetRoom}`);
  _roomAllocLoc=targetLoc;
  _roomAllocNo=targetRoom;
  closeModal('room-alloc');
  renderRooms();
  openRoomDetail(targetLoc,targetRoom);
}

function clearGuestRooms(gid){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  g.roomAssignments=[];
  syncGuestPrimaryRoom(g);
  recomputeGuestRoomRequestStatus(g);
  save();syncActiveEventData();render();
  toast(`Cleared all rooms for ${g.first}`);
}

function prepareGuestRoomAssignment(gid,{silent=false,directAssign=false}={}){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g){toast('⚠️ Guest not found');return;}
  _preferredRoomGuestId=gid;
  _directRoomAssignGuestId=directAssign?gid:'';
  switchTab('rooms');
  if(!silent) toast(`Choose a room for ${g.first} ${g.last}`);
}

function resolveGuestRoomRequest(gid,outcome){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  if(outcome==='no_room_needed'){
    g.roomLoc='';
    g.roomNo='';
    g.roomRequestType='no_room_needed';
    g.roomRequestStatus='fulfilled';
  }
  save();syncActiveEventData();renderRooms();
  toast(`${g.first}'s request updated`);
}

function sendGuestInvite(guestId){
  const gid=guestId||(_editing.guest);
  const g=DB.guests.find(x=>x.id===gid);
  if(!g){toast('⚠️ Save guest first');return;}
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!ev){toast('⚠️ No event selected');return;}
  const phone=(g.contact||'').replace(/\D/g,'');
  if(phone.length<10){toast('⚠️ No valid phone number');return;}
  const intlPhone=phone.startsWith('91')?phone:'91'+phone;
  const evDate=ev.date?fmtDate(ev.date):'';
  const venue=ev.location||'';
  const rooms=getGuestRoomAssignments(g);
  const roomPart=rooms.length?`\nRooms: ${rooms.map(room=>`${room.loc} Room ${room.no}`).join(', ')}`:'';
  const msg=`*You're Invited!*\n\nDear ${g.first},\n\nWe joyfully invite you to *${ev.name}*\n\nDate: ${evDate}\nVenue: ${venue}${roomPart}\n\nYour presence will make this celebration truly special. We look forward to seeing you!\n\nWith warm regards`;
  const url=`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
  window.open(url,'_blank');
  toast('WhatsApp invite opened');
}

function submitGuestRoomRequest(){
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Guest portal only');return;}
  if(!isRoomRequestEnabled(ev)){toast('ℹ️ Room requests are turned off for this event');closeModal('guest-request');render();return;}
  const me=getCurrentGuestInvite(ev.id);
  if(!me){toast('⚠️ Guest record not found');return;}
  ensureGuestRequestDefaults(me);
  const typeEl=document.getElementById('gr-room-request-type')||document.getElementById('gp-room-request-type');
  const roomsEl=document.getElementById('gr-requested-rooms')||document.getElementById('gp-requested-rooms');
  const stayEl=document.getElementById('gr-requested-stay-count')||document.getElementById('gp-requested-stay-count');
  const noteEl=document.getElementById('gr-room-request-note')||document.getElementById('gp-room-request-note');
  me.roomRequestType=typeEl.value;
  me.requestedRoomCount=Math.max(1,parseInt(roomsEl.value)||1);
  me.requestedStayCount=Math.max(1,parseInt(stayEl.value)||1);
  me.roomRequestNote=noteEl.value.trim();
  me.roomRequestUpdatedAt=Date.now();
  me.roomRequestStatus=me.roomRequestType==='undecided'?'none':'pending';
  save();syncActiveEventData();closeModal('guest-request');renderGuestPortal();render();
  toast('Room request sent');
}

function setGuestFeedbackRating(field,value,prefix='gf'){
  const input=document.getElementById(`${prefix}-${field}`);
  const current=Math.max(1,Math.min(5,parseInt(value)||1));
  if(input) input.value=current;
  document.querySelectorAll(`[data-feedback-prefix="${prefix}"][data-feedback-field="${field}"]`).forEach(btn=>{
    const btnVal=parseInt(btn.dataset.feedbackValue)||0;
    btn.style.borderColor=btnVal<=current?'var(--gold-d)':'var(--bord)';
    btn.style.background=btnVal<=current?'var(--gold-l)':'var(--surf)';
    btn.style.color=btnVal<=current?'var(--gold-d)':'var(--txt3)';
  });
}

function submitGuestFeedback(prefix='gf'){
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Guest feedback not available');return;}
  if(!isFeedbackEnabled(ev)){toast('ℹ️ Feedback is turned off for this event');render();return;}
  const me=getCurrentGuestInvite(ev.id);
  if(!me){toast('⚠️ Guest record not found');return;}
  ensureGuestFeedbackDefaults(me);
  const canRateRoom=getGuestRoomAssignments(me).length>0;
  const foodEl=document.getElementById(`${prefix}-food-rating`);
  const eventEl=document.getElementById(`${prefix}-event-rating`);
  const roomEl=document.getElementById(`${prefix}-room-rating`);
  const messageEl=document.getElementById(`${prefix}-message`);
  me.feedbackFoodRating=Math.max(0,Math.min(5,parseInt(foodEl?.value)||0));
  me.feedbackEventRating=Math.max(0,Math.min(5,parseInt(eventEl?.value)||0));
  me.feedbackRoomRating=canRateRoom?Math.max(0,Math.min(5,parseInt(roomEl?.value)||0)):0;
  me.feedbackMessage=(messageEl?.value||'').trim();
  me.feedbackUpdatedAt=Date.now();
  save();syncActiveEventData();renderGuestPortal();render();
  toast('Feedback sent');
}

function clearGuestFeedback(){
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Guest feedback not available');return;}
  const me=getCurrentGuestInvite(ev.id);
  if(!me){toast('⚠️ Guest record not found');return;}
  me.feedbackFoodRating=0;
  me.feedbackEventRating=0;
  me.feedbackRoomRating=0;
  me.feedbackMessage='';
  me.feedbackUpdatedAt=null;
  save();syncActiveEventData();renderGuestPortal();render();
  const content=document.getElementById('gf-content');
  if(content&&document.getElementById('mo-guest-feedback')?.classList.contains('open')){
    content.innerHTML=renderGuestFeedbackSection(ev, me, 'gf-modal');
  }
  toast('Feedback removed');
}

function toggleGuestFoodLike(sectionIdx,itemIdx,eventId){
  const targetId=eventId||DB.activeEvent;
  const ev=DB.events.find(e=>e.id===targetId);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Food menu not available');return;}
  const me=ensureGuestFoodLikesDefaults(getCurrentGuestInvite(targetId));
  if(!me){toast('⚠️ Guest record not found');return;}
  const menus=normalizeEventMenus(ev.foodMenus);
  const menu=menus[sectionIdx];
  const itemText=normalizeMenuItems(menu?.items)[itemIdx];
  if(!menu||!itemText) return;
  const key=getFoodMenuLikeKey(menu,itemText);
  const liked=new Set((me.foodMenuLikes||[]).map(item=>String(item)));
  if(liked.has(key)) liked.delete(key);
  else liked.add(key);
  me.foodMenuLikes=Array.from(liked);
  me.foodMenuLikesUpdatedAt=Date.now();
  save();
  syncActiveEventData();
  renderGuestPortal();
  render();
  if(document.getElementById('mo-guest-menu')?.classList.contains('open')){
    renderGuestFoodMenuModalContent(targetId);
  }
}

function toggleGuestFoodSectionLike(sectionIdx,eventId){
  const targetId=eventId||DB.activeEvent;
  const ev=DB.events.find(e=>e.id===targetId);
  if(!ev||!ev._isGuestOnly){toast('⚠️ Food menu not available');return;}
  const me=ensureGuestFoodLikesDefaults(getCurrentGuestInvite(targetId));
  if(!me){toast('⚠️ Guest record not found');return;}
  const menus=normalizeEventMenus(ev.foodMenus);
  const menu=menus[sectionIdx];
  if(!menu) return;
  const key=getFoodMenuSectionLikeKey(menu);
  const liked=new Set((me.foodMenuLikes||[]).map(item=>String(item)));
  if(liked.has(key)) liked.delete(key);
  else liked.add(key);
  me.foodMenuLikes=Array.from(liked);
  me.foodMenuLikesUpdatedAt=Date.now();
  save();
  syncActiveEventData();
  renderGuestPortal();
  render();
  if(document.getElementById('mo-guest-menu')?.classList.contains('open')){
    renderGuestFoodMenuModalContent(targetId);
  }
}

function scrollGuestsToFeedback(){
  const target=document.getElementById('guest-feedback-section');
  if(!target) return;
  target.scrollIntoView({behavior:'smooth',block:'start'});
}

function setRsvpDirect(id,status){
  const g=DB.guests.find(x=>x.id===id);
  if(!g)return;
  g.rsvp=status;
  save();syncActiveEventData();render();
  // re-render detail
  openGuestDetail(id);
  toast(`${g.first}: ${status}`);
}

// ═══════════════════════════════════════════════
// GIFT CRUD
// ═══════════════════════════════════════════════
function openAddGift(){
  if(!DB.activeEvent){toast('Please select an event first');return;}
  _editing.gift=null;
  _giftPhotoData=null;
  document.getElementById('mo-gift-title').textContent='Log a Gift';
  ['gi-desc','gi-from','gi-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('gi-cat').value='personal';
  document.querySelectorAll('#gi-cat-picker .cat-opt').forEach(o=>o.classList.toggle('sel',o.dataset.cat==='personal'));
  document.getElementById('gi-ty').value='pending';
  document.getElementById('gift-photo-img').style.display='none';
  document.getElementById('gift-photo-label').style.display='block';
  document.getElementById('del-gift-btn').style.display='none';
  hideAllGuestPickers();
  openModal('add-gift');
}

function openEditGift(id){
  const g=DB.gifts.find(x=>x.id===id);
  if(!g)return;
  _editing.gift=id;
  _giftPhotoData=g.photo||null;
  document.getElementById('mo-gift-title').textContent='Edit Gift';
  document.getElementById('gi-desc').value=g.desc||'';
  document.getElementById('gi-from').value=g.from||'';
  const cat=g.cat||'other';
  document.getElementById('gi-cat').value=cat;
  document.querySelectorAll('#gi-cat-picker .cat-opt').forEach(o=>o.classList.toggle('sel',o.dataset.cat===cat));
  document.getElementById('gi-ty').value=g.ty||'pending';
  document.getElementById('gi-notes').value=g.notes||'';
  if(g.photo){
    document.getElementById('gift-photo-img').src=g.photo;
    document.getElementById('gift-photo-img').style.display='block';
    document.getElementById('gift-photo-label').style.display='none';
  } else {
    document.getElementById('gift-photo-img').style.display='none';
    document.getElementById('gift-photo-label').style.display='block';
  }
  document.getElementById('del-gift-btn').style.display='block';
  hideAllGuestPickers();
  openModal('add-gift');
}

function handleGiftPhoto(input){
  const file=input.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    _giftPhotoData=e.target.result;
    document.getElementById('gift-photo-img').src=_giftPhotoData;
    document.getElementById('gift-photo-img').style.display='block';
    document.getElementById('gift-photo-label').style.display='none';
  };
  reader.readAsDataURL(file);
}

function saveGift(){
  const desc=document.getElementById('gi-desc').value.trim();
  if(!desc){toast('⚠️ Please describe the gift');return;}
  if(_editing.gift){
    const g=DB.gifts.find(x=>x.id===_editing.gift);
    if(g){
      g.desc=desc;g.from=document.getElementById('gi-from').value.trim();
      g.value=0;
      g.cat=normalizeGiftCategory(document.getElementById('gi-cat').value);
      g.ty=document.getElementById('gi-ty').value;
      g.notes=document.getElementById('gi-notes').value.trim();
      g.photo=_giftPhotoData||null;
    }
    toast('Gift updated');
  } else {
    DB.gifts.push({
      id:uid(),eventId:DB.activeEvent,
      desc,from:document.getElementById('gi-from').value.trim(),
      value:0,
      cat:normalizeGiftCategory(document.getElementById('gi-cat').value),
      ty:document.getElementById('gi-ty').value,
      notes:document.getElementById('gi-notes').value.trim(),
      photo:_giftPhotoData||null,
      createdAt:Date.now()
    });
    toast('Gift logged');
  }
  save();syncActiveEventData();closeModal('add-gift');render();
}

function cycleTy(id){
  const g=DB.gifts.find(x=>x.id===id);
  if(!g)return;
  const s=['pending','drafted','sent'];
  g.ty=s[(s.indexOf(g.ty)+1)%s.length];
  save();syncActiveEventData();render();toast(`Thank-you: ${g.ty}`);
}

function confirmDeleteGift(id){
  const gid=id||_editing.gift;
  const g=DB.gifts.find(x=>x.id===gid);
  if(!g)return;
  openConfirm('Delete this gift?','This gift record will be permanently removed.',()=>{
    DB.gifts=DB.gifts.filter(x=>x.id!==gid);
    save();syncActiveEventData();closeModal('add-gift');closeModal('add-moi');render();toast('Gift deleted');
  });
}

// ═══════════════════════════════════════════════
// EVENT PICKER
// ═══════════════════════════════════════════════
function renderEventPicker(){
  const el=document.getElementById('ep-list');
  const sess=Auth.currentSession();
  const accessibleEvents=DB.events.filter(ev=>Auth.getTeam(ev.id).some(m=>m.userId===sess?.id || ((m.email||'').trim().toLowerCase()===(sess?.email||'').trim().toLowerCase())));
  if(accessibleEvents.length===0){el.innerHTML=`<div class="empty"><div class="empty-ico">${uiIcon('event',42)}</div><div class="empty-t">No events yet</div></div>`;return;}
  const upcomingEvents=accessibleEvents.filter(ev=>{
    const days=daysUntil(ev.date);
    return days===null || days>=0;
  });
  const pastEvents=accessibleEvents.filter(ev=>{
    const days=daysUntil(ev.date);
    return days!==null && days<0;
  });
  const myEvents=_showPastPickerEvents?[...upcomingEvents,...pastEvents]:upcomingEvents;
  const pastToggle=pastEvents.length
    ? `<button class="fchip ${_showPastPickerEvents?'on':''}" style="padding:8px 14px;font-size:12px;margin:0 0 12px" onclick="App.togglePastPickerEvents(${_showPastPickerEvents?'false':'true'})">${_showPastPickerEvents?'Hide Past Events':'View Past Events'} (${pastEvents.length})</button>`
    : '';
  el.innerHTML=pastToggle+myEvents.map(ev=>{
    const col=COLORS[ev.color]||COLORS.rose;
    return`<div class="ep-item ${ev.id===DB.activeEvent?'sel':''}" onclick="App.pickEvent('${ev.id}')">
      <div class="ep-dot" style="background:${col.accent}"></div>
      <div><div style="font-size:13.5px;font-weight:500">${ev.name}</div><div style="font-size:11.5px;color:var(--txt3)">${ev.date?fmtDate(ev.date):''}</div></div>
    </div>`;
  }).join('');
}

function togglePastPickerEvents(show){
  _showPastPickerEvents=!!show;
  renderEventPicker();
}

function pickEvent(id){
  DB.activeEvent=id;save();
  closeModal('event-pick');
  render();
}

document.getElementById('mo-event-pick').addEventListener('click',e=>{
  if(e.target===document.getElementById('mo-event-pick'))return;
});
// Open hook
const _origOpen=openModal;
window.openModal=function(id){
  if(id==='event-pick'){
    _showPastPickerEvents=false;
    renderEventPicker();
  }
  if(id==='export'){
    const ev=DB.events.find(e=>e.id===DB.activeEvent);
    if(ev){_exportEventId=DB.activeEvent;document.getElementById('export-ev-name').textContent=ev.name;}
    renderExportPicker();
  }
  if(id==='event-pick-export')renderExportPicker();
  _origOpen(id);
};

function renderExportPicker(){
  const el=document.getElementById('ep-export-list');
  if(!el)return;
  el.innerHTML=DB.events.map(ev=>{
    const col=COLORS[ev.color]||COLORS.rose;
    return`<div class="ep-item ${ev.id===_exportEventId?'sel':''}" onclick="App.pickExportEvent('${ev.id}')">
      <div class="ep-dot" style="background:${col.accent}"></div>
      <div><div style="font-size:13.5px;font-weight:500">${ev.name}</div></div>
    </div>`;
  }).join('');
}

function pickExportEvent(id){
  _exportEventId=id;
  const ev=DB.events.find(e=>e.id===id);
  if(ev)document.getElementById('export-ev-name').textContent=ev.name;
  closeModal('event-pick-export');
  renderExportPicker();
}

// ═══════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════
function downloadCSV(filename,rows){
  const csv=rows.map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
}

function exportGuests(){
  const evId=_exportEventId||DB.activeEvent;
  if(!evId){toast('⚠️ Select an event first');return;}
  const ev=DB.events.find(e=>e.id===evId);
  const guests=DB.guests.filter(g=>g.eventId===evId);
  if(guests.length===0){toast('⚠️ No guests to export');return;}
  const rows=[['First Name','Last Name','Phone','Email','Peoples','Invite Status','Group','Dietary / Notes']];
  guests.forEach(g=>rows.push([g.first,g.last,g.contact,g.email,g.party,g.rsvp,g.table,g.notes]));
  downloadCSV(`${(ev?.name||'event').replace(/\s+/g,'_')}_guests.csv`,rows);
  toast('Guest list exported');
  closeModal('export');
}

function exportGifts(){
  const evId=_exportEventId||DB.activeEvent;
  if(!evId){toast('⚠️ Select an event first');return;}
  const ev=DB.events.find(e=>e.id===evId);
  const gifts=DB.gifts.filter(g=>g.eventId===evId);
  if(gifts.length===0){toast('⚠️ No gifts to export');return;}
  const rows=[['Description','From','Category',`Estimated Value (${currentCurrencyCode()})`,'Thank-You Status','Notes']];
  gifts.forEach(g=>{
    const meta=CAT_META[normalizeGiftCategory(g.cat)]||CAT_META.other;
    rows.push([g.desc,g.from,meta.label,g.value,g.ty,g.notes]);
  });
  downloadCSV(`${(ev?.name||'event').replace(/\s+/g,'_')}_gifts.csv`,rows);
  toast('Gift tracker exported');
  closeModal('export');
}

// ═══════════════════════════════════════════════
// PROFILE & SETTINGS
// ═══════════════════════════════════════════════
function openProfileModal(show=true){
  const sess=Auth.currentSession();
  const name=(sess&&sess.name)||DB.profile.name||'';
  const email=(sess&&sess.email)||DB.profile.email||'';
  const avatar=((name||email||'P').trim()[0]||'P').toUpperCase();
  const nameEl=document.getElementById('profile-name');
  const emailEl=document.getElementById('profile-email');
  const avatarEl=document.getElementById('profile-av');
  if(nameEl) nameEl.textContent=name||'Guest Host';
  if(emailEl) emailEl.textContent=email||'Sign in to sync across devices';
  if(avatarEl) avatarEl.textContent=avatar;
  if(show) openModal('profile');
}

function toggleSetting(key,btn){
  DB.settings[key]=!DB.settings[key];
  btn.classList.toggle('on',DB.settings[key]);
  save();
}
async function enableAppNotifications(){
  await NotificationCenter.requestPermission();
}
function applyCurrencyUI(){
  const symbol=currencySymbol();
  const amountLabels=[document.getElementById('ca-amount-label'),document.getElementById('moi-amount-label')];
  amountLabels.forEach(label=>{ if(label) label.textContent=`Amount (${symbol.trim()}) *`; });
  const iconEls=[document.getElementById('ca-currency-badge'),document.getElementById('moi-currency-symbol')];
  iconEls.forEach(el=>{ if(el) el.textContent=symbol.trim(); });
  const cashEmpty=document.getElementById('cash-empty-currency');
  if(cashEmpty) cashEmpty.textContent=symbol.trim();
  document.querySelectorAll('[data-quick-amount]').forEach(btn=>{
    const amount=Number(btn.getAttribute('data-quick-amount')||0);
    btn.textContent=fmtVal(amount);
  });
}
function setCurrency(code){
  const normalized=(code||'INR').toUpperCase();
  if(!CURRENCY_META[normalized]) return;
  DB.settings.currency=normalized;
  save();
  applyCurrencyUI();
  render();
  toast(`Currency changed to ${normalized}`);
}

function unlockPremium(){
  DB.premium=true;save();closeModal('premium');render();
  toast('Premium unlocked. Ads removed.');
  if(!DB.premium) return;
  document.querySelector('.ad-top').style.display='none';
  document.querySelector('.ad-bot').style.display='none';
}

function clearAllData(){
  openConfirm('Clear all data?','This will permanently delete all events, guests, and gifts. This cannot be undone.',()=>{
    const eventIds = DB.events.map(event => event.id);
    DB.events=[];DB.guests=[];DB.gifts=[];DB.masterGuests=[];DB.activeEvent=null;
    save();
    Cloud.clearAllCloudData(eventIds).catch(()=>toast('⚠️ Could not delete cloud data'));
    render();toast('All data cleared');
  });
}

// ═══════════════════════════════════════════════
// LOCATION SEARCH (OpenStreetMap Nominatim)
// ═══════════════════════════════════════════════
let _locTimer=null;
function locSearch(val){
  const sug=document.getElementById('loc-suggestions');
  if(!val||val.length<3){if(sug)sug.style.display='none';return;}
  clearTimeout(_locTimer);
  _locTimer=setTimeout(async()=>{
    try{
      const r=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&limit=5&countrycodes=in`,{headers:{'Accept-Language':'en'}});
      const data=await r.json();
      if(!sug)return;
      if(!data.length){sug.style.display='none';return;}
      sug.innerHTML=data.map((p,i)=>`<div onclick="App.pickLoc('${encodeURIComponent(p.display_name)}','${p.lat}','${p.lon}')" style="padding:10px 13px;font-size:12.5px;cursor:pointer;border-bottom:1px solid var(--bord2);transition:background .12s" onmouseover="this.style.background='var(--surf2)'" onmouseout="this.style.background=''">${p.display_name}</div>`).join('');
      sug.style.display='block';
    }catch(e){if(sug)sug.style.display='none';}
  },400);
}

function pickLoc(name,lat,lon){
  const decoded=decodeURIComponent(name);
  const inp=document.getElementById('ev-loc');
  const sug=document.getElementById('loc-suggestions');
  const preview=document.getElementById('loc-map-preview');
  const frame=document.getElementById('loc-map-frame');
  const mapLink=document.getElementById('loc-map-link');
  if(inp)inp.value=decoded;
  if(sug)sug.style.display='none';
  if(preview&&frame){
    frame.src=`https://maps.google.com/maps?q=${lat},${lon}&z=15&output=embed`;
    preview.style.display='block';
  }
  if(mapLink){
    mapLink.href=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(decoded)}`;
  }
  // store coords for display
  document.getElementById('ev-loc').dataset.lat=lat;
  document.getElementById('ev-loc').dataset.lon=lon;
}

// ═══════════════════════════════════════════════
// WHATSAPP THANK YOU
// ═══════════════════════════════════════════════
let _waGiftId=null;
function openWhatsApp(giftId){
  const g=DB.gifts.find(x=>x.id===giftId);
  if(!g)return;
  const guestMatch=DB.guests.find(gu=>gu.eventId===DB.activeEvent&&(gu.first+' '+gu.last).toLowerCase().trim()===(g.from||'').toLowerCase().trim());
  if(!guestMatch||!guestMatch.contact){toast('⚠️ No phone number for this guest');return;}
  const phone=guestMatch.contact.replace(/\D/g,'');
  if(phone.length<10){toast('⚠️ Invalid phone number');return;}
  _waGiftId=giftId;
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  const evName=ev?ev.name:'our event';
  const defaultMsg=`Dear ${g.from},\n\nThank you so much for the wonderful ${g.desc}${g.value?' (worth '+fmtVal(g.value)+')':''}. Your thoughtfulness means the world to us. We are truly grateful for your presence and generosity at ${evName}.\n\nWith love and gratitude`;
  document.getElementById('wa-to-name').textContent=g.from||'Guest';
  document.getElementById('wa-to-phone').textContent=guestMatch.contact;
  document.getElementById('wa-msg').value=defaultMsg;
  openModal('whatsapp');
}

function sendWhatsApp(){
  if(!_waGiftId)return;
  const g=DB.gifts.find(x=>x.id===_waGiftId);
  if(!g)return;
  const guestMatch=DB.guests.find(gu=>gu.eventId===DB.activeEvent&&(gu.first+' '+gu.last).toLowerCase().trim()===(g.from||'').toLowerCase().trim());
  const phone=(guestMatch?.contact||'').replace(/\D/g,'');
  const msg=document.getElementById('wa-msg').value.trim();
  if(!msg){toast('⚠️ Please enter a message');return;}
  // Add country code if needed
  const intlPhone=phone.startsWith('91')?phone:'91'+phone;
  const url=`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
  window.open(url,'_blank');
  // Mark as sent
  g.ty='sent';save();syncActiveEventData();
  closeModal('whatsapp');
  render();
  toast('WhatsApp opened · Marked as TY Sent');
}
function setMoiTy(val,btn){
  document.getElementById('moi-ty').value=val;
  document.querySelectorAll('.moi-ty-pick-btn').forEach(b=>{
    const active=b.dataset.val===val;
    b.style.borderColor=active?'var(--gold-d)':'var(--bord)';
    b.style.background=active?'var(--gold-l)':'var(--surf)';
    b.style.color=active?'var(--gold-d)':'var(--txt3)';
  });
}

function filterMoi(val){
  document.querySelectorAll('#moi-list [data-moi]').forEach(r=>{
    const name=r.dataset.name||'';
    r.style.display=(!val||name.toLowerCase().includes(val.toLowerCase()))?'':'none';
  });
}

function setGFilter(f){_guestFilter=f;renderGuests()}
function setGSearch(v){
  _guestSearch=v;
  _preserveGuestSearchFocus=true;
  renderGuests();
}
function scrollToTop(){
  const mainScroll=document.getElementById('main-scroll');
  if(!mainScroll) return;
  mainScroll.scrollTo({top:0,behavior:'smooth'});
}

function updateScrollTopVisibility(){
  const mainScroll=document.getElementById('main-scroll');
  const shouldShow=!!mainScroll && mainScroll.scrollTop>220;
  if(_showScrollTop===shouldShow) return;
  _showScrollTop=shouldShow;
  const btn=document.getElementById('global-scroll-top-btn');
  if(btn) btn.classList.toggle('show', shouldShow);
}

function setMoiFilter(f,el){
  document.querySelectorAll('#moi-ty-filter .moi-fchip').forEach(c=>c.classList.remove('on'));
  if(el)el.classList.add('on');
  document.querySelectorAll('#moi-list [data-moi]').forEach(r=>{
    const match=f==='all'||r.dataset.ty===f;
    r.style.display=match?'':'none';
  });
}


function selectCat(el,cat){
  document.querySelectorAll('#gi-cat-picker .cat-opt').forEach(o=>o.classList.remove('sel'));
  el.classList.add('sel');
  document.getElementById('gi-cat').value=cat;
}

function setGiftCatFilter(cat){_giftCatFilter=cat;renderGifts();}

function setGiftTab(t){_giftTab=t;_giftCatFilter='all';renderGifts();}

function openAddMoi(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  _editing.gift=null;
  applyCurrencyUI();
  document.getElementById('mo-moi-title').textContent='Add Cash Gift Entry';
  const saveBtn=document.getElementById('moi-save-btn');
  const doneBtn=document.getElementById('moi-done-btn');
  if(saveBtn){
    saveBtn.textContent='Save & Next';
    saveBtn.setAttribute('onclick',"App.saveMoi({keepOpen:true})");
  }
  if(doneBtn) doneBtn.textContent='Done';
  document.getElementById('moi-from').value='';
  document.getElementById('moi-amount').value='';
  const notesEl=document.getElementById('moi-notes');
  if(notesEl)notesEl.value='Cash Envelope';
  const notesInlineEl=document.getElementById('moi-notes-inline');
  if(notesInlineEl) notesInlineEl.value='Cash Envelope';
  document.getElementById('moi-ty').value='pending';
  document.getElementById('del-moi-btn').style.display='none';
  hideAllGuestPickers();
  openModal('add-moi');
  setTimeout(()=>document.getElementById('moi-from')?.focus(),20);
}

function openEditMoi(id){
  const g=DB.gifts.find(x=>x.id===id);
  if(!g)return;
  _editing.gift=id;
  applyCurrencyUI();
  document.getElementById('mo-moi-title').textContent='Edit Cash Gift Entry';
  const saveBtn=document.getElementById('moi-save-btn');
  const doneBtn=document.getElementById('moi-done-btn');
  if(saveBtn){
    saveBtn.textContent='Save Changes';
    saveBtn.setAttribute('onclick',"App.saveMoi()");
  }
  if(doneBtn) doneBtn.textContent='Done';
  document.getElementById('moi-from').value=g.from||'';
  document.getElementById('moi-amount').value=g.value||'';
  const notesEl=document.getElementById('moi-notes');
  if(notesEl)notesEl.value=g.notes||'Cash Envelope';
  const notesInlineEl=document.getElementById('moi-notes-inline');
  if(notesInlineEl) notesInlineEl.value=g.notes||'Cash Envelope';
  document.getElementById('moi-ty').value='pending';
  document.getElementById('del-moi-btn').style.display='block';
  hideAllGuestPickers();
  openModal('add-moi');
}

function _saveMoiEntry(opts={}){
  const keepOpen=!!opts.keepOpen;
  const from=document.getElementById('moi-from').value.trim();
  const amount=parseFloat(document.getElementById('moi-amount').value)||0;
  const paymentMode=(document.getElementById('moi-notes-inline')?.value || document.getElementById('moi-notes')?.value || 'Cash Envelope').trim() || 'Cash Envelope';
  if(!from){toast('⚠️ Please enter a name');return;}
  if(!amount){toast('⚠️ Please enter the amount');return;}
  const wasEditing=!!_editing.gift;
  if(_editing.gift){
    const g=DB.gifts.find(x=>x.id===_editing.gift);
    if(g){g.from=from;g.value=amount;g.notes=paymentMode;g.ty='pending';}
    toast('Cash gift entry updated');
  } else {
    DB.gifts.push({id:uid(),eventId:DB.activeEvent,isMoi:true,desc:'Cash Gift',from,value:amount,cat:'cash_gift',ty:'pending',notes:paymentMode,createdAt:Date.now()});
    toast(`Cash gift of ${fmtVal(amount)} from ${from} recorded`);
  }
  save();syncActiveEventData();renderGifts();
  if(keepOpen && !wasEditing){
    document.getElementById('moi-from').value='';
    document.getElementById('moi-amount').value='';
    const notesEl=document.getElementById('moi-notes');
    if(notesEl)notesEl.value='Cash Envelope';
    const notesInlineEl=document.getElementById('moi-notes-inline');
    if(notesInlineEl) notesInlineEl.value='Cash Envelope';
    hideAllGuestPickers();
    setTimeout(()=>document.getElementById('moi-from')?.focus(),20);
    return true;
  }
  closeModal('add-moi');
  return true;
}
function saveMoi(opts){return _saveMoiEntry(opts);}
function handleMoiFieldEnter(field,e){
  if(e.key!=='Enter') return;
  e.preventDefault();
  if(field==='from'){
    document.getElementById('moi-amount')?.focus();
    document.getElementById('moi-amount')?.select?.();
    return;
  }
  if(field==='amount'){
    saveMoi({keepOpen:!_editing.gift});
  }
}


// ═══════════════════════════════════════════════
// TEAM & AUTH UI
// ═══════════════════════════════════════════════
function openTeamModal(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  _teamEventId=DB.activeEvent;
  if(!Auth.isOrganizer(DB.activeEvent)){
    // Non-organizers can view team but not edit
  }
  renderTeamEventPickerLabelOnly();
  const picker=document.getElementById('team-event-picker');
  if(picker) picker.style.display='none';
  Auth.renderTeamModal(_teamEventId);
  openModal('team');
}

async function sendTeamInvite(){
  const targetEventId=_teamEventId||DB.activeEvent;
  if(!targetEventId){toast('⚠️ Select an event first');return;}
  if(!Auth.isOrganizer(targetEventId)){toast('⚠️ Only organisers can invite members');return;}
  const email=document.getElementById('team-invite-email').value.trim().toLowerCase();
  const role=document.getElementById('team-invite-role').value;
  if(!email){toast('⚠️ Enter an email');return;}
  const result=Auth.sendInvite(targetEventId,email,role);
  if(result==='exists'){toast('⚠️ Already a team member');return;}
  if(result===false){toast('⚠️ Invalid email');return;}
  document.getElementById('team-invite-email').value='';
  const roleLabel=role==='organizer'?'Organizer':role==='cash'?'Cash Collector':'Room Coordinator';
  toast(`${email} added as ${roleLabel}`);
  try{ await Cloud.loadEventsForSession(Auth.currentSession()); }catch(e){}
  Auth.renderTeamModal(targetEventId);
}

function renderTeamEventPicker(){
  const selectedId=_teamEventId||DB.activeEvent;
  const selectedEvent=DB.events.find(ev=>ev.id===selectedId);
  const label=document.getElementById('team-event-name');
  if(label) label.textContent=selectedEvent?selectedEvent.name:'Select an event';
  const picker=document.getElementById('team-event-picker');
  if(!picker) return;
  const sess=Auth.currentSession();
  const accessibleEvents=DB.events.filter(ev=>{
    const hasAccess=Auth.getTeam(ev.id).some(m=>m.userId===sess?.id || ((m.email||'').trim().toLowerCase()===(sess?.email||'').trim().toLowerCase()));
    if(!hasAccess) return false;
    const days=daysUntil(ev.date);
    return days===null || days>=0;
  });
  picker.innerHTML=accessibleEvents.map(ev=>{
    const col=COLORS[ev.color]||COLORS.rose;
    return `<div class="ep-item ${ev.id===selectedId?'sel':''}" onclick="App.pickTeamEvent('${ev.id}')">
      <div class="ep-dot" style="background:${col.accent}"></div>
      <div><div style="font-size:13.5px;font-weight:500">${ev.name}</div><div style="font-size:11.5px;color:var(--txt3)">${ev.date?fmtDate(ev.date):''}</div></div>
    </div>`;
  }).join('');
  picker.style.display=picker.style.display==='block'?'none':'block';
}

function pickTeamEvent(id){
  _teamEventId=id;
  const picker=document.getElementById('team-event-picker');
  if(picker) picker.style.display='none';
  renderTeamEventPickerLabelOnly();
  Auth.renderTeamModal(id);
}

function renderTeamEventPickerLabelOnly(){
  const selectedEvent=DB.events.find(ev=>ev.id===(_teamEventId||DB.activeEvent));
  const label=document.getElementById('team-event-name');
  if(label) label.textContent=selectedEvent?selectedEvent.name:'Select an event';
}

function openUserMenu(){
  const sess=Auth.currentSession();
  if(!sess){openProfileModal();return;}
  const role=Auth.currentRole(DB.activeEvent);
  const roleLabel=role==='organizer'?'Organizer':role==='cash'?'Cash Collector':role==='room'?'Room Coordinator':'—';
  openConfirm(
    sess.name||sess.email,
    `${sess.email}\nRole: ${roleLabel}\n\nSign out of eventise?`,
    ()=>{ Auth.logout(); }
  );
  document.getElementById('confirm-ok').textContent='Sign Out';
  document.getElementById('confirm-ok').style.background='var(--rose-d)';
  document.getElementById('confirm-ok').style.color='white';
  document.getElementById('confirm-ok').style.borderColor='var(--rose-d)';
}

// Role-gate wrappers — show toast if insufficient permission
function _requireOrganizer(fn){
  return function(...args){
    if(!Auth.isOrganizer(DB.activeEvent)){toast('⚠️ Only Organisers can do this');return;}
    return fn(...args);
  };
}
function _requireCash(fn){
  return function(...args){
    if(!Auth.isCash(DB.activeEvent)){toast('⚠️ Only Organisers or Cash Collectors can do this');return;}
    return fn(...args);
  };
}
function _requireRoom(fn){
  return function(...args){
    if(!Auth.isRoom(DB.activeEvent)){toast('⚠️ Only Organisers or Room Coordinators can do this');return;}
    return fn(...args);
  };
}

// Gated versions
const openAddGuestGated=_requireOrganizer(openAddGuest);
const openEditGuestGated=_requireOrganizer(openEditGuest);
const confirmDeleteGuestGated=_requireOrganizer(confirmDeleteGuest);
const openAddEventGated=openAddEvent; // anyone logged in can create events (they become organizer)
const openEditEventGated=_requireRoom(openEditEvent);
const confirmDeleteEventGated=_requireOrganizer(confirmDeleteEvent);
const openAddGiftGated=_requireOrganizer(openAddGift);
const openEditGiftGated=_requireOrganizer(openEditGift);
const confirmDeleteGiftGated=_requireOrganizer(confirmDeleteGift);
const openAddMoiGated=_requireCash(openAddMoi);
const openEditMoiGated=_requireCash(openEditMoi);
const addRoomLocationGated=_requireRoom(addRoomLocation);
const assignGuestToRoomGated=_requireRoom(assignGuestToRoom);
const unassignGuestRoomGated=_requireRoom(unassignGuestRoom);

// ═══════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════
window.App={
  togglePastEvents(show){_showPastEvents=!!show; renderEvents();},
  switchTab,openModal: window.openModal,closeModal,
  openAddEvent:openAddEventGated,openEditEvent:openEditEventGated,openRoomConfig:_requireRoom(openRoomConfig),openEventFoodMenuEditor,saveEvent,saveRoomConfig,saveEventFoodMenus,confirmDeleteEvent:confirmDeleteEventGated,
  addEventContact,_updateEventContact,_removeEventContact,openEventContacts,saveEventContacts,toggleEventContactsEditMode,handleEventContactsHeaderAction,handleEventContactPhoneKey,shareEventContact,callEventContact,whatsAppEventContact,openEventContactActions,callActiveEventContact,whatsAppActiveEventContact,shareActiveEventContact,
  setActive,
  openAddGuest:openAddGuestGated,openEditGuest:openEditGuestGated,saveGuest,cycleRsvp,
  confirmDeleteGuest:confirmDeleteGuestGated,openGuestDetail,setRsvpDirect,handleGuestRowTap,swipeAllocateRoom,swipeAddGift,swipeAddCashGift,openGuestSwipeActions,toggleGuestRowEdit,saveGuestRowEdit,undoGuestRemoval,
  openMasterGuestModal,filterMasterGuests,pickMasterGuest,exportCurrentEventToMaster,openMasterGuestEditor,saveMasterGuest,confirmDeleteMasterGuest,updateEventGuestToMaster,resolveMasterGuestConflict,toggleMasterGuestSelection,toggleMasterGuestGroupSelection,openMasterGuestShareComposer,sendMasterGuestShare,openMasterGuestShares,acceptMasterGuestShare,
  openAddGift:openAddGiftGated,openEditGift:openEditGiftGated,saveGift,cycleTy,
  confirmDeleteGift:confirmDeleteGiftGated,handleGiftPhoto,
  setGiftTab,setGiftCatFilter,selectCat,
  openAddMoi:openAddMoiGated,openEditMoi:openEditMoiGated,saveMoi,handleMoiFieldEnter,filterMoi,setMoiFilter,setMoiTy,
  _editingGift:()=>_editing.gift,
  openGuestRequestModal,openGuestFeedbackModal,openGuestFoodMenuModal,
  submitGuestRoomRequest,setGuestFeedbackRating,submitGuestFeedback,clearGuestFeedback,scrollGuestsToFeedback,prepareGuestRoomAssignment:_requireOrganizer(prepareGuestRoomAssignment),resolveGuestRoomRequest:_requireOrganizer(resolveGuestRoomRequest),
  toggleGuestFoodLike,toggleGuestFoodSectionLike,
  showGuestPicker,filterGuestPicker,pickGuest,showGroupPicker,filterGroupPicker,pickGroup,
  openGroupInviteModal,filterGroupInvite,importMasterGroup,importMasterGuest,
  pickEvent,pickExportEvent,exportGuests,exportGifts,
  openProfileModal,toggleSetting,enableAppNotifications,setCurrency,unlockPremium,clearAllData,
  setGFilter,setGSearch,scrollToTop,openConfirm,closeConfirm,
  limitPhoneDigits,
  locSearch,pickLoc,openWhatsApp,sendWhatsApp,
  addEventMenu,_updateEventMenuTitle,_updateEventMenuItems,_removeEventMenu,
  addRoomLocation:addRoomLocationGated,_updateLocName,_removeLocation,_addRoom,_removeRoom,
  populateRoomSelects,refreshRoomNumbers,checkRoomConflict,sendGuestInvite,
  renderRooms,openRoomDetail,
  togglePastPickerEvents,
  assignGuestToRoom:assignGuestToRoomGated,
  onRoomAllocGuestChange,
  unassignGuestRoom:unassignGuestRoomGated,
  clearGuestRooms:_requireRoom(clearGuestRooms),
  openTeamModal,sendTeamInvite,renderTeamEventPicker,pickTeamEvent,openUserMenu,
  toast,
};

// Expose modal helpers globally for inline onclick in dynamic HTML
window.setMoiTy=setMoiTy;
window.setMoiFilter=setMoiFilter;

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
function setupMasterGuestSharingUi(){
  const modal=document.getElementById('mo-master-guests');
  if(!modal) return;
  const addBtn=document.getElementById('master-guest-add-btn');
  const search=document.getElementById('master-guest-search');
  const searchIcon=modal.querySelector('.search-ico');
  if(addBtn && !document.getElementById('master-guest-share-btn')){
    const toolbar=document.createElement('div');
    toolbar.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px';
    toolbar.innerHTML=`
      <button class="btn-p" id="master-guest-add-btn-replacement" style="margin:0;flex:1 1 180px" onclick="App.openMasterGuestEditor()">+ Add Saved Guest</button>
      <button class="btn-s" id="master-guest-share-btn" style="margin:0;flex:1 1 180px" onclick="App.openMasterGuestShareComposer()">Share Selected</button>
      <button class="btn-s" id="master-guest-inbox-btn" style="margin:0;display:inline-flex;align-items:center;justify-content:center;gap:8px" onclick="App.openMasterGuestShares()">Shared Lists <span id="master-guest-inbox-count" style="min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--rose-d);color:#fff;font-size:10px;display:inline-flex;align-items:center;justify-content:center"></span></button>
    `;
    addBtn.style.display='none';
    addBtn.insertAdjacentElement('afterend', toolbar);
  }
  if(search){
    search.placeholder='Search by name, email, phone, or group';
  }
  if(searchIcon) searchIcon.textContent='⌕';
  if(!document.getElementById('mo-master-guest-share')){
    modal.insertAdjacentHTML('afterend', `
<div class="mo mo-center" id="mo-master-guest-share">
  <div class="ms">
    <div class="m-handle"></div>
    <div class="m-title">Share Guest List</div>
    <div style="font-size:12px;color:var(--txt3);margin:-8px 0 14px;line-height:1.6">Share selected guests or groups with another Eventise user. Once accepted, they will be added to that user's master guest list.</div>
    <div class="fg">
      <label class="fl">Selected</label>
      <div class="fi" id="master-guest-share-preview" style="background:var(--surf2)"></div>
    </div>
    <div class="fg">
      <label class="fl">Recipient Eventise Email</label>
      <input class="fi" type="email" id="master-guest-share-email" placeholder="friend@example.com" />
    </div>
    <button class="btn-p" onclick="App.sendMasterGuestShare()">Send Share</button>
    <button class="btn-s" onclick="App.closeModal('master-guest-share')">Cancel</button>
  </div>
</div>
<div class="mo" id="mo-master-guest-shares">
  <div class="ms">
    <div class="m-handle"></div>
    <div class="m-title">Shared Guest Lists</div>
    <div style="font-size:12px;color:var(--txt3);margin:-8px 0 14px;line-height:1.6">Accept incoming shared lists to import them into your master guest list, or track the ones you have already sent.</div>
    <div id="master-guest-shares-list"></div>
    <button class="btn-s" onclick="App.closeModal('master-guest-shares')">Close</button>
  </div>
</div>`);
    document.querySelectorAll('#mo-master-guest-share,#mo-master-guest-shares').forEach(el=>{
      el.addEventListener('click',e=>{
        if(e.target===el) closeModal(el.id.replace(/^mo-/,''));
      });
    });
  }
}

// Pre-populate profile modal
setupMasterGuestSharingUi();
openProfileModal(false);
const groupInviteSearchIcon=document.querySelector('#mo-group-invite .search-ico');
if(groupInviteSearchIcon) groupInviteSearchIcon.textContent='⌕';
if (window.history && window.history.replaceState) {
  window.history.replaceState({ tab: 'events' }, '', window.location.href);
}

// Hide ads if premium
if(DB.premium){
  document.querySelector('.ad-top').style.display='none';
  document.querySelector('.ad-bot').style.display='none';
}

// Seed sample data if empty
if(false && DB.events.length===0){
  const eid=uid();
  DB.events=[{id:eid,name:"Priya & Arjun's Wedding",date:'2025-12-14',type:'wedding',location:'The Leela, Chennai',color:'rose',createdAt:Date.now()}];
  DB.activeEvent=eid;
  const gids=[uid(),uid(),uid(),uid(),uid(),uid()];
  DB.guests=[
    {id:gids[0],eventId:eid,first:'Divya',last:'Sharma',contact:'+91 98100 11111',party:2,rsvp:'attending',notes:'Vegetarian',table:'Table 1'},
    {id:gids[1],eventId:eid,first:'Karthik',last:'Nair',contact:'+91 98200 22222',party:1,rsvp:'attending',notes:'',table:'Table 2'},
    {id:gids[2],eventId:eid,first:'Sneha',last:'Patel',contact:'+91 98300 33333',party:3,rsvp:'pending',notes:'Gluten-free',table:''},
    {id:gids[3],eventId:eid,first:'Vikram',last:'Singh',contact:'+91 98400 44444',party:4,rsvp:'attending',notes:'',table:'VIP'},
    {id:gids[4],eventId:eid,first:'Ananya',last:'Iyer',contact:'+91 98500 55555',party:2,rsvp:'invited',notes:'',table:''},
    {id:gids[5],eventId:eid,first:'Rohan',last:'Gupta',contact:'+91 98600 66666',party:1,rsvp:'declined',notes:'',table:''},
  ];
  DB.gifts=[
    {id:uid(),eventId:eid,desc:'Silk saree set (Kanjivaram)',from:'Divya Sharma',value:15000,cat:'personal',ty:'sent',notes:''},
    {id:uid(),eventId:eid,desc:'KitchenAid Stand Mixer',from:'Karthik Nair',value:28000,cat:'home',ty:'pending',notes:'Red colour'},
    {id:uid(),eventId:eid,desc:'Crystal dinner set',from:'Ananya Iyer',value:12000,cat:'home',ty:'drafted',notes:'12 piece'},
    {id:uid(),eventId:eid,isMoi:true,desc:'Cash Gift',from:'Vikram Singh',value:5001,cat:'cash_gift',ty:'sent',notes:'Cash'},
    {id:uid(),eventId:eid,isMoi:true,desc:'Cash Gift',from:'Rohan Gupta',value:2100,cat:'cash_gift',ty:'pending',notes:''},
    {id:uid(),eventId:eid,isMoi:true,desc:'Cash Gift',from:'Sneha Patel',value:3000,cat:'cash_gift',ty:'pending',notes:'Online transfer'},
  ];
  save();
  // Seed organizer for demo event based on current session
  Auth.addCreatorAsOrganizer(eid);
}

// Initialize auth — shows login screen or app based on session
Auth.init();

render();

document.getElementById('main-scroll')?.addEventListener('scroll',()=>{
  updateScrollTopVisibility();
},{passive:true});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

