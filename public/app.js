// ═══════════════════════════════════════════════
// FIREBASE — real Google OAuth only
// ═══════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, onAuthStateChanged, reauthenticateWithPopup, signInWithEmailAndPassword, signInWithPopup, signOut as fbSignOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
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
  let _unsubs = { eventsMem: null, eventsGst: null, guests: [], gifts: [] };

  function unsubscribeAll() {
    if (_unsubs.eventsMem) { _unsubs.eventsMem(); _unsubs.eventsMem = null; }
    if (_unsubs.eventsGst) { _unsubs.eventsGst(); _unsubs.eventsGst = null; }
    _unsubs.guests.forEach(unsub => unsub()); _unsubs.guests = [];
    _unsubs.gifts.forEach(unsub => unsub()); _unsubs.gifts = [];
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
  }

  function loadEventsForSession(session) {
    const myToken = ++_sessionToken;
    const email = normalizeEmail(session?.email);
    
    if (_unsubs.eventsMem) { _unsubs.eventsMem(); _unsubs.eventsMem = null; }
    if (_unsubs.eventsGst) { _unsubs.eventsGst(); _unsubs.eventsGst = null; }
    
    if (!email) {
      applyEventsToLocal([], session);
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

  return { unsubscribeAll, loadEventsForSession, saveEvent, deleteEvent, migrateLocalEvents, hydrateTeamForSession, syncEventData, clearAllCloudData };
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
    document.getElementById('auth-screen').style.display='flex';
    document.getElementById('app').style.display='none';
    document.getElementById('hdr-team-btn').style.display='none';
    document.getElementById('auth-email').value='';
    document.getElementById('auth-pass').value='';
    clearError();
    Cloud.unsubscribeAll();
  }

  function _onLogin(sess, isFirstUser) {
    // If first ever user — make them organizer of all events automatically
    document.getElementById('auth-screen').style.display='none';
    document.getElementById('app').style.display='flex';
    // Show team btn only for organizers (checked per event later)
    document.getElementById('hdr-team-btn').style.display='block';
    Cloud.migrateLocalEvents(sess).catch(()=>Cloud.loadEventsForSession(sess).catch(()=>{}));
    render();
    toast(`👋 Welcome, ${sess.name}!`);
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
    if(!el) return;
    if(team.length===0){el.innerHTML=`<div class="empty" style="padding:20px 0"><div class="empty-ico">👥</div><div class="empty-t" style="font-size:16px">No team members yet</div></div>`;return;}
    el.innerHTML = team.map(m=>{
      const memberEmail = (m.email||'').trim().toLowerCase();
      const isMe = m.userId===sess?.id || memberEmail===((sess?.email||'').trim().toLowerCase());
      const roleLabel = m.role==='organizer'?'👑 Organizer':m.role==='cash'?'💵 Cash Collector':'🏨 Room Coord.';
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
            <button onclick="Auth._removeMember('${eventId}','${m.userId}')" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--txt4);padding:0 4px">✕</button>`
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
        _onLogin(sess, false);
      } else {
        clearSession();
        DB.events=[];DB.guests=[];DB.gifts=[];DB.activeEvent=null;
        save();
        document.getElementById('auth-screen').style.display='flex';
        document.getElementById('app').style.display='none';
        document.getElementById('hdr-team-btn').style.display='none';
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
  activeEvent: STORE.get('activeEvent')||null,
  profile: STORE.get('profile')||{name:'',email:''},
  premium: STORE.get('premium')||false,
  settings: STORE.get('settings')||{rsvpReminders:true,tyReminders:true,exportNotes:true},
};

function save(){
  STORE.set('events',DB.events);
  STORE.set('guests',DB.guests);
  STORE.set('gifts',DB.gifts);
  STORE.set('activeEvent',DB.activeEvent);
  STORE.set('profile',DB.profile);
  STORE.set('premium',DB.premium);
  STORE.set('settings',DB.settings);
}

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
const COLORS={
  rose:{accent:'#C4637A',light:'#FAF0F3',chip:'background:var(--rose-l);color:var(--rose-d)'},
  sage:{accent:'#6B9B7E',light:'#EEF5F0',chip:'background:var(--sage-l);color:var(--sage-d)'},
  gold:{accent:'#C09050',light:'#FBF6EC',chip:'background:var(--gold-l);color:var(--gold-d)'},
  slate:{accent:'#5B7FA6',light:'#EBF2F9',chip:'background:var(--slate-l);color:var(--slate-d)'},
};
const TYPE_LABEL={wedding:'💍 Wedding',birthday:'🎂 Birthday',babyshower:'🍼 Baby Shower',party:'🎊 Party',other:'✨ Other'};
const AV_BG=['#FFEAEE','#E8F5E9','#E3EEF9','#FFF6E1','#F4EAF5','#E1F4F0'];
const AV_C=['#8B3A52','#3D6B50','#2F5380','#8A6020','#6A2B8A','#1A6B5A'];

function daysUntil(dateStr){
  if(!dateStr)return null;
  const d=new Date(dateStr)-new Date();
  return Math.ceil(d/(1000*60*60*24));
}
function fmtDate(dateStr){
  if(!dateStr)return '';
  return new Date(dateStr+'T00:00:00').toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});
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
  if(!v||isNaN(v))return '—';
  return '₹'+Number(v).toLocaleString('en-IN');
}
function initials(first,last){return((first||'')[0]||(last||'')[0]||'?').toUpperCase()+((last||'')[0]||'').toUpperCase()}
function avStyle(id){const i=Math.abs(id.charCodeAt?[...id].reduce((a,c)=>a+c.charCodeAt(0),0):0)%6;return`background:${AV_BG[i]};color:${AV_C[i]}`}
function normalizeEmailValue(email){return(email||'').trim().toLowerCase()}
function normalizePhoneValue(phone){return(phone||'').replace(/\D/g,'')}
function splitContactName(fullName){
  const name=String(fullName||'').trim();
  if(!name) return {first:'Guest',last:''};
  const parts=name.split(/\s+/).filter(Boolean);
  return {first:parts.shift()||'Guest',last:parts.join(' ')};
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
function roomRequestTypeLabel(type){
  return type==='needs_room'?'Room needed':type==='no_room_needed'?'No room needed':'Not submitted';
}
function roomRequestStatusLabel(status){
  return status==='fulfilled'?'Request handled':status==='pending'?'Awaiting coordinator':'No request';
}
function getGuestRoomAssignments(guest){
  if(!guest) return [];
  if(Array.isArray(guest.roomAssignments)&&guest.roomAssignments.length){
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
  return `<div class="empty"><div class="empty-ico">🎉</div><div class="empty-t">${title}</div><div class="empty-s">${message}</div><button class="fab" style="margin-top:16px" onclick="App.openAddEvent()">＋ Create New Event</button></div>`;
}
function escapeHtml(value){
  return String(value??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
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

function normalizeMenuItems(items){
  return String(items||'')
    .split(/\r?\n/)
    .map(item=>item.trim())
    .filter(Boolean);
}

function getFoodMenuLikeKey(menu, itemText){
  return `${(menu?.title||'menu').trim().toLowerCase()}::${String(itemText||'').trim().toLowerCase()}`;
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
  document.getElementById('gf-event-meta').innerHTML=`${ev.date?`📅 ${fmtDate(ev.date)}<br>`:''}${ev.time?`⏰ ${fmtTime(ev.time)}<br>`:''}${ev.location?`📍 ${ev.location}<br>`:''}👤 ${me.first} ${me.last}`;
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
      <div style="font-size:12px;color:var(--txt3);line-height:1.6;margin-bottom:12px">Tap the heart beside any item you love.</div>
      <div style="display:grid;gap:10px">
        ${menus.map((menu,sectionIdx)=>{
          const items=normalizeMenuItems(menu.items);
          return `<div style="padding:12px 14px;border-radius:var(--rs);background:var(--surf2);border:1px solid var(--bord2)">
              <div style="font-size:13px;font-weight:600;color:var(--txt);margin-bottom:${items.length?'8px':'0'}">${menu.title||'Menu'}</div>
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
  document.getElementById('gm-event-meta').innerHTML=`${ev.date?`📅 ${fmtDate(ev.date)}<br>`:''}${ev.time?`⏰ ${fmtTime(ev.time)}<br>`:''}${ev.location?`📍 ${ev.location}<br>`:''}👤 ${me.first} ${me.last}`;
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

// ═══════════════════════════════════════════════
// MODAL SYSTEM
// ═══════════════════════════════════════════════
let _editing={event:null,guest:null,gift:null};
let _roomLocsTemp=[];
let _eventMenusTemp=[];
let _eventMenuEditorDisabled=false;
let _giftPhotoData=null;
let _showPastEvents=false;
let _googleContactsTemp=[];
let _googleContactsSelected=new Set();
let _googleContactsSearch='';
let _googleContactsBusy=false;

function openModal(id){document.getElementById('mo-'+id)?.classList.add('open')}
function closeModal(id){document.getElementById('mo-'+id)?.classList.remove('open')}

document.querySelectorAll('.mo').forEach(el=>{
  el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open')});
});

// ═══════════════════════════════════════════════
// CONFIRM SYSTEM
// ═══════════════════════════════════════════════
let _confirmCb=null;
function openConfirm(title,sub,cb){
  document.getElementById('confirm-t').textContent=title;
  document.getElementById('confirm-s').textContent=sub;
  _confirmCb=cb;
  document.getElementById('confirm-ok').onclick=()=>{_confirmCb&&_confirmCb();closeConfirm()};
  document.getElementById('confirm-overlay').classList.add('open');
}
function closeConfirm(){document.getElementById('confirm-overlay').classList.remove('open')}
document.getElementById('confirm-overlay').addEventListener('click',e=>{if(e.target===document.getElementById('confirm-overlay'))closeConfirm()});

// ═══════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════
let _tab='events';
let _guestFilter='all';
let _guestSearch='';
let _exportEventId=null;

function switchTab(tab) {
  const ev = DB.events.find(e => e.id === DB.activeEvent);
  const isGuestOnly = ev && ev._isGuestOnly;

  if (isGuestOnly && tab !== 'events' && tab !== 'rooms' && tab !== 'settings') {
    tab = 'events';
  }

  _tab = tab;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  
  const scr = document.getElementById('scr-' + tab);
  if (scr) scr.classList.add('active');
  const tabEl = document.getElementById('tab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  
  const mainScroll = document.getElementById('main-scroll');
  if (mainScroll) mainScroll.scrollTop = 0;
  
  const navTabs = document.querySelector('.tabs');
  if (navTabs) navTabs.style.display = 'flex';
  const teamBtn = document.getElementById('hdr-team-btn');
  if (teamBtn) teamBtn.style.display = isGuestOnly ? 'none' : 'block';
  
  render();
}

// ═══════════════════════════════════════════════
// EVENTS SCREEN
// ═══════════════════════════════════════════════
function renderEvents(){
  const el=document.getElementById('scr-events');
  const sess=Auth.currentSession();
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
      <div class="no-events-ico">🎊</div>
      <div class="no-events-t">Welcome to eventise!</div>
      <p class="no-events-s">Manage guest lists and track gifts for all your special events in one beautiful place.</p>
      <button class="fab" onclick="App.openAddEvent()">＋ Create Your First Event</button>
    </div>`;
    return;
  }
  if(myEvents.length===0&&pastEvents.length){
    el.innerHTML=`<div class="no-events">
      <div class="no-events-ico">📅</div>
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
    const giftc=DB.gifts.filter(g=>g.eventId===ae.id);
    const attending=gc.filter(g=>g.rsvp==='attending').length;
    const days=daysUntil(ae.date);
    const col=COLORS[ae.color]||COLORS.rose;
    heroHtml=`<div class="dash-hero anim" onclick="${ae._isGuestOnly?(isRoomRequestEnabled(ae)?`App.setActive('${ae.id}');App.openGuestRequestModal('${ae.id}')`:`App.setActive('${ae.id}');App.switchTab('rooms')`):`App.setActive('${ae.id}');App.switchTab('guests')`}">
      <div class="dash-hero-event">${TYPE_LABEL[ae.type]||ae.type}</div>
      <div class="dash-hero-title">${ae.name}</div>
      <div class="dash-hero-stats">
        ${ae._isGuestOnly ? `<div class="dash-stat"><span class="dash-stat-l">Invitation Access</span></div>` : 
        `<div class="dash-stat"><span class="dash-stat-n">${gc.length}</span><span class="dash-stat-l">Guests</span></div>
        <div class="dash-stat"><span class="dash-stat-n">${attending}</span><span class="dash-stat-l">Attending</span></div>
        <div class="dash-stat"><span class="dash-stat-n">${giftc.length}</span><span class="dash-stat-l">Gifts</span></div>`}
      </div>
      ${days!==null?`<div class="dash-cd">${days>0?'⏳ '+days+' days away':days===0?'🎉 Today!':'✅ Past event'}</div>`:''}
      ${ae._isGuestOnly?`<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px" onclick="event.stopPropagation()">
        ${normalizeEventMenus(ae.foodMenus).length?`<button class="ev-btn" onclick="App.setActive('${ae.id}');App.openGuestFoodMenuModal('${ae.id}')">Food Menu</button>`:''}
        <button class="ev-btn" onclick="App.setActive('${ae.id}');${isRoomRequestEnabled(ae)?`App.openGuestRequestModal('${ae.id}')`:`App.switchTab('rooms')`}">${isRoomRequestEnabled(ae)?'Request Room':'View Rooms'}</button>
        ${isFeedbackEnabled(ae)?`<button class="ev-btn" onclick="App.setActive('${ae.id}');App.openGuestFeedbackModal('${ae.id}')">Feedback</button>`:''}
      </div>`:''}
    </div>`;
  }
  const cards=myEvents.map(ev=>{
    const gc=DB.guests.filter(g=>g.eventId===ev.id);
    const giftc=DB.gifts.filter(g=>g.eventId===ev.id);
    const att=gc.filter(g=>g.rsvp==='attending').length;
    const days=daysUntil(ev.date);
    const col=COLORS[ev.color]||COLORS.rose;
    const isAct=ev.id===DB.activeEvent;
    const team=Auth.getTeam(ev.id);
    const myRole=team.find(m=>m.userId===sess?.id || ((m.email||'').trim().toLowerCase()===(sess?.email||'').trim().toLowerCase()))?.role||'';
    const roleLbl=myRole==='organizer'?'👑':myRole==='cash'?'💵':myRole==='room'?'🏨':'';
    return`<div class="ev-card anim ${isAct?'':''}">
      <div class="ev-accent" style="background:${col.accent}"></div>
      <div class="ev-body">
        <div class="ev-top">
          <div class="ev-name">${ev.name}</div>
          <span class="type-chip" style="${col.chip}">${TYPE_LABEL[ev.type]||ev.type} ${roleLbl}</span>
        </div>
        <div class="ev-meta">
          ${ev.date?`<span class="ev-meta-item">📅 ${fmtDate(ev.date)}</span>`:''}
          ${ev.time?`<span class="ev-meta-item">⏰ ${fmtTime(ev.time)}</span>`:''}
          ${ev.location?`<span class="ev-meta-item"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" style="color:inherit;text-decoration:none;display:flex;align-items:center;gap:4px" onclick="event.stopPropagation()">📍 ${ev.location}</a></span>`:''}
        </div>
        <div class="ev-stats">
          ${ev._isGuestOnly ? `<div class="ev-stat"><span class="ev-stat-l">My Invitation Access</span></div>` : 
          `<div class="ev-stat"><span class="ev-stat-n">${gc.length}</span><span class="ev-stat-l">Guests</span></div>
          <div class="ev-stat"><span class="ev-stat-n">${att}</span><span class="ev-stat-l">Attending</span></div>
          <div class="ev-stat"><span class="ev-stat-n">${giftc.length}</span><span class="ev-stat-l">Gifts</span></div>`}
        </div>
        ${normalizeEventMenus(ev.foodMenus).length?`<div style="font-size:11.5px;color:var(--txt3);margin-top:10px">🍽 ${normalizeEventMenus(ev.foodMenus).length} menu section${normalizeEventMenus(ev.foodMenus).length!==1?'s':''} added</div>`:''}
        <div class="ev-footer">
          ${days!==null?`<span class="countdown" style="background:${col.accent}">${days>0?'⏳ '+days+' days':days===0?'🎉 Today!':'✅ Past'}</span>`:'<span></span>'}
          <div class="ev-actions">
            ${ev._isGuestOnly
              ?`${normalizeEventMenus(ev.foodMenus).length?`<button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.openGuestFoodMenuModal('${ev.id}')">Food Menu</button>`:''}
            ${isFeedbackEnabled(ev)?`<button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.openGuestFeedbackModal('${ev.id}')">Feedback</button>`:''}
            <button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');${isRoomRequestEnabled(ev)?`App.openGuestRequestModal('${ev.id}')`:`App.switchTab('rooms')`}">${isRoomRequestEnabled(ev)?'Request Room':'View Rooms'}</button>`
              :`<button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.switchTab('guests')">Guests</button>
            <button class="ev-btn" onclick="event.stopPropagation();App.setActive('${ev.id}');App.switchTab('gifts')">Gifts</button>`}
            ${Auth.isOrganizer(ev.id)?`<button class="ev-btn" onclick="event.stopPropagation();App.openEditEvent('${ev.id}')">✏️</button>`:''}
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
    `<button class="fab" onclick="App.openAddEvent()">＋ Create New Event</button>`+
    pastToggle+
    cards;
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
    <span class="fchip ${_guestFilter==='attending'?'on':''}" onclick="App.setGFilter('attending')">✅ Attending</span>
    <span class="fchip ${_guestFilter==='pending'?'on':''}" onclick="App.setGFilter('pending')">⏳ Pending</span>
    <span class="fchip ${_guestFilter==='declined'?'on':''}" onclick="App.setGFilter('declined')">❌ Declined</span>
    <span class="fchip ${_guestFilter==='invited'?'on':''}" onclick="App.setGFilter('invited')">📬 Invited</span>
  </div>`;
  const organizerActions=isOrg?`<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <button class="fab" style="margin-bottom:0;flex:1 1 180px" onclick="App.openAddGuest()">＋ Add Guest</button>
      <button class="fchip" style="padding:10px 14px;font-size:12px" onclick="App.openGoogleContactsImport()">Import Contacts</button>
      ${feedbackGuests.length?`<button class="fchip" style="padding:8px 14px;font-size:12px" onclick="App.scrollGuestsToFeedback()">Jump to Feedback</button>`:''}
    </div>`:'';
  let listHtml='';
  if(!DB.activeEvent){
    listHtml=`<div class="empty"><div class="empty-ico">📋</div><div class="empty-t">No event selected</div><div class="empty-s">Select one of your events to manage guests</div></div>`;
  } else if(guests.length===0){
    listHtml=`<div class="empty"><div class="empty-ico">👥</div><div class="empty-t">No guests yet</div><div class="empty-s">${_guestSearch||_guestFilter!=='all'?'Try clearing filters':'Add your first guest to get started'}</div></div>`;
  } else {
    guests.forEach((g,i)=>{
      if(i>0&&i%15===0&&!DB.premium){
        listHtml+=`<div class="ad-inline"><span>🎂 Order a custom cake at <strong>FNP</strong> – Free delivery</span><span class="adlbl" style="font-size:9px">AD</span></div>`;
      }
      const ini=initials(g.first,g.last);
      listHtml+=`<div class="g-row anim" onclick="App.openGuestDetail('${g.id}')">
        <div class="g-av" style="${avStyle(g.id)}">${ini}</div>
        <div class="g-info">
          <div class="g-name">${g.first} ${g.last}</div>
          <div class="g-detail">Peoples: ${g.party||1}${g.contact?' · '+g.contact:''}${g.email?' · '+g.email:''}${g.table?' · '+g.table:''}${getGuestRoomAssignments(g).length?` · 🏨 ${formatGuestRooms(g)}`:''}${g.notes?' · '+g.notes:''}</div>
        </div>
        <div class="g-actions">
          <button class="rsvp-btn r-${g.rsvp}" onclick="event.stopPropagation();App.cycleRsvp('${g.id}')">${g.rsvp.charAt(0).toUpperCase()+g.rsvp.slice(1)}</button>
          <button class="g-del" onclick="event.stopPropagation();App.confirmDeleteGuest('${g.id}')">✕</button>
        </div>
      </div>`;
    });
  }
  const isOrg=Auth.isOrganizer(DB.activeEvent);
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
    `<div class="ph"><div class="ph-title">Guest List</div></div>`+
    statsHtml+
    organizerActions+
    `<div class="search-wrap"><span class="search-ico">🔍</span><input class="search-inp" type="text" placeholder="Search guests…" value="${_guestSearch}" oninput="App.setGSearch(this.value)" /></div>`+
    filtersHtml+listHtml+feedbackHtml;
  // Hide delete buttons for non-organisers
  if(!isOrg){
    el.querySelectorAll('.g-del').forEach(b=>b.style.display='none');
  }
}

// ═══════════════════════════════════════════════
// GIFTS SCREEN  (Gifts tab | Cash Gift tab)
// ═══════════════════════════════════════════════
function renderGuestPortal(){
  const el=document.getElementById('scr-guest-portal');
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  if(!ev){
    el.innerHTML=`<div class="empty"><div class="empty-ico">🏨</div><div class="empty-t">No invitation selected</div><div class="empty-s">Choose an event to view your stay details.</div></div>`;
    return;
  }
  const me=ensureGuestRequestDefaults(getCurrentGuestInvite(ev.id));
  if(!me){
    el.innerHTML=`<div class="empty"><div class="empty-ico">📩</div><div class="empty-t">Invitation not found</div><div class="empty-s">We couldn't find your guest record for this event yet.</div></div>`;
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
        ${ev.date?`📅 ${fmtDate(ev.date)}<br>`:''}
        ${ev.time?`⏰ ${fmtTime(ev.time)}<br>`:''}
        ${ev.location?`📍 ${ev.location}<br>`:''}
        👤 ${me.first} ${me.last}
      </div>
    </div>`+
    `<div class="guest-card anim">
      <div class="guest-card-title">Event Schedule</div>
      <div style="font-size:13px;color:var(--txt2);line-height:1.7">
        ${ev.date?`Date: ${fmtDate(ev.date)}<br>`:''}
        ${ev.time?`Time: ${fmtTime(ev.time)}<br>`:''}
        ${ev.location?`Location: ${ev.location}`:'Location will be shared by the organiser.'}
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

function renderGoogleContactsImportModal(){
  const listEl=document.getElementById('gci-list');
  const countEl=document.getElementById('gci-count');
  const searchEl=document.getElementById('gci-search');
  const importBtn=document.getElementById('gci-import-btn');
  if(searchEl&&searchEl.value!==_googleContactsSearch) searchEl.value=_googleContactsSearch;
  if(importBtn) importBtn.disabled=_googleContactsSelected.size===0||_googleContactsBusy;
  if(countEl) countEl.textContent=_googleContactsBusy?'Loading contacts…':`${_googleContactsSelected.size} selected`;
  if(!listEl) return;
  if(_googleContactsBusy){
    listEl.innerHTML=`<div class="empty" style="padding:26px 12px"><div class="empty-ico">📇</div><div class="empty-t" style="font-size:17px">Loading contacts</div><div class="empty-s">Please wait while we fetch your Google contacts.</div></div>`;
    return;
  }
  const filtered=_googleContactsTemp.filter(contact=>{
    const haystack=`${contact.name} ${contact.email} ${contact.phone}`.toLowerCase();
    return !_googleContactsSearch||haystack.includes(_googleContactsSearch.toLowerCase());
  });
  if(!filtered.length){
    listEl.innerHTML=`<div class="empty" style="padding:26px 12px"><div class="empty-ico">📭</div><div class="empty-t" style="font-size:17px">No contacts found</div><div class="empty-s">${_googleContactsSearch?'Try clearing your search.':'No Google contacts with usable name, email, or phone were found.'}</div></div>`;
    return;
  }
  listEl.innerHTML=filtered.map(contact=>{
    const selected=_googleContactsSelected.has(contact.id);
    return `<label style="display:flex;gap:10px;align-items:flex-start;padding:11px 12px;border:1px solid ${selected?'var(--rose-m)':'var(--bord2)'};background:${selected?'var(--rose-l)':'var(--surf)'};border-radius:12px;cursor:pointer">
        <input type="checkbox" ${selected?'checked':''} onchange="App.toggleGoogleContact('${contact.id}')" style="margin-top:2px" />
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--txt)">${escapeHtml(contact.name||'Unnamed Contact')}</div>
          ${contact.email?`<div style="font-size:11.5px;color:var(--txt3);margin-top:3px">${escapeHtml(contact.email)}</div>`:''}
          ${contact.phone?`<div style="font-size:11.5px;color:var(--txt3);margin-top:${contact.email?'2px':'3px'}">${escapeHtml(contact.phone)}</div>`:''}
        </div>
      </label>`;
  }).join('');
}

async function fetchGoogleContacts(){
  if(_googleContactsBusy) return;
  const sess=Auth.currentSession();
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  if(!Auth.isOrganizer(DB.activeEvent)){toast('⚠️ Only organisers can import contacts');return;}
  if(sess?.provider!=='google.com'){toast('⚠️ Contact import currently works for Google-signed-in organisers only');return;}
  const user=_fbAuth.currentUser;
  if(!user){toast('⚠️ Please sign in again');return;}
  _googleContactsBusy=true;
  renderGoogleContactsImportModal();
  try{
    const provider=new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/contacts.readonly');
    provider.setCustomParameters({prompt:'consent'});
    const result=await reauthenticateWithPopup(user,provider);
    const credential=GoogleAuthProvider.credentialFromResult(result);
    const accessToken=credential?.accessToken;
    if(!accessToken) throw new Error('missing-token');
    const contacts=[];
    let pageToken='';
    for(let page=0; page<5; page++){
      const url=new URL('https://people.googleapis.com/v1/people/me/connections');
      url.searchParams.set('personFields','names,emailAddresses,phoneNumbers');
      url.searchParams.set('pageSize','200');
      if(pageToken) url.searchParams.set('pageToken',pageToken);
      const resp=await fetch(url.toString(),{
        headers:{Authorization:`Bearer ${accessToken}`}
      });
      if(!resp.ok) throw new Error('contacts-fetch-failed');
      const data=await resp.json();
      (data.connections||[]).forEach((person,idx)=>{
        const name=person.names?.find(n=>n.displayName)?.displayName?.trim()||'';
        const email=normalizeEmailValue(person.emailAddresses?.find(e=>e.value)?.value||'');
        const phone=(person.phoneNumbers?.find(p=>p.value)?.value||'').trim();
        if(!name&&!email&&!phone) return;
        contacts.push({
          id:person.resourceName||`contact-${page}-${idx}-${email||normalizePhoneValue(phone)||name}`,
          name:name||email||phone||'Unnamed Contact',
          email,
          phone
        });
      });
      pageToken=data.nextPageToken||'';
      if(!pageToken) break;
    }
    const deduped=[];
    const seen=new Set();
    contacts.forEach(contact=>{
      const key=`${normalizeEmailValue(contact.email)}|${normalizePhoneValue(contact.phone)}|${contact.name.toLowerCase()}`;
      if(seen.has(key)) return;
      seen.add(key);
      deduped.push(contact);
    });
    _googleContactsTemp=deduped;
    _googleContactsSelected=new Set(deduped.slice(0,Math.min(10,deduped.length)).map(contact=>contact.id));
    renderGoogleContactsImportModal();
    toast(deduped.length?`✅ ${deduped.length} Google contacts loaded`:'ℹ️ No usable Google contacts found');
  }catch(err){
    if(err?.code==='auth/popup-closed-by-user'){
      toast('ℹ️ Contact import cancelled');
    } else {
      toast('⚠️ Could not load Google contacts');
    }
  } finally {
    _googleContactsBusy=false;
    renderGoogleContactsImportModal();
  }
}

function openGoogleContactsImport(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  if(!Auth.isOrganizer(DB.activeEvent)){toast('⚠️ Only organisers can import contacts');return;}
  _googleContactsSearch='';
  openModal('google-contacts');
  if(!_googleContactsTemp.length) fetchGoogleContacts();
  else renderGoogleContactsImportModal();
}

function setGoogleContactsSearch(value){
  _googleContactsSearch=value||'';
  renderGoogleContactsImportModal();
}

function toggleGoogleContact(id){
  if(_googleContactsSelected.has(id)) _googleContactsSelected.delete(id);
  else _googleContactsSelected.add(id);
  renderGoogleContactsImportModal();
}

function toggleAllGoogleContacts(selectAll){
  const visible=_googleContactsTemp.filter(contact=>{
    const haystack=`${contact.name} ${contact.email} ${contact.phone}`.toLowerCase();
    return !_googleContactsSearch||haystack.includes(_googleContactsSearch.toLowerCase());
  });
  if(selectAll) visible.forEach(contact=>_googleContactsSelected.add(contact.id));
  else visible.forEach(contact=>_googleContactsSelected.delete(contact.id));
  renderGoogleContactsImportModal();
}

function importSelectedGoogleContacts(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  const selected=_googleContactsTemp.filter(contact=>_googleContactsSelected.has(contact.id));
  if(!selected.length){toast('⚠️ Select at least one contact');return;}
  const eventGuests=DB.guests.filter(g=>g.eventId===DB.activeEvent);
  const emailSet=new Set(eventGuests.map(g=>normalizeEmailValue(g.email)).filter(Boolean));
  const phoneSet=new Set(eventGuests.map(g=>normalizePhoneValue(g.contact)).filter(Boolean));
  const nameSet=new Set(eventGuests.map(g=>`${(g.first||'').trim().toLowerCase()} ${(g.last||'').trim().toLowerCase()}`.trim()).filter(Boolean));
  let added=0;
  let skipped=0;
  selected.forEach(contact=>{
    const email=normalizeEmailValue(contact.email);
    const phone=contact.phone||'';
    const phoneKey=normalizePhoneValue(phone);
    const nameParts=splitContactName(contact.name);
    const fullName=`${nameParts.first} ${nameParts.last}`.trim().toLowerCase();
    const isDup=(email&&emailSet.has(email))||(phoneKey&&phoneSet.has(phoneKey))||(!email&&!phoneKey&&fullName&&nameSet.has(fullName));
    if(isDup){ skipped++; return; }
    DB.guests.push({
      id:uid(),eventId:DB.activeEvent,
      first:nameParts.first,last:nameParts.last,
      contact:phone,
      email,
      party:1,
      rsvp:'invited',
      notes:'',
      table:'',
      roomLoc:'',roomNo:'',
      roomAssignments:[],
      roomRequestType:'undecided',
      requestedRoomCount:1,
      requestedStayCount:1,
      roomRequestNote:'',
      roomRequestStatus:'none',
      feedbackFoodRating:0,
      feedbackEventRating:0,
      feedbackRoomRating:0,
      feedbackMessage:'',
      foodMenuLikes:[],
      createdAt:Date.now()
    });
    if(email) emailSet.add(email);
    if(phoneKey) phoneSet.add(phoneKey);
    if(fullName) nameSet.add(fullName);
    added++;
  });
  save();
  syncActiveEventData();
  closeModal('google-contacts');
  renderGuests();
  render();
  toast(added?`✅ Imported ${added} contact${added!==1?'s':''}${skipped?` · Skipped ${skipped} duplicate${skipped!==1?'s':''}`:''}`:`ℹ️ All selected contacts were already added`);
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
  document.getElementById('gr-event-meta').innerHTML=`${ev.date?`📅 ${fmtDate(ev.date)}<br>`:''}${ev.time?`⏰ ${fmtTime(ev.time)}<br>`:''}${ev.location?`📍 ${ev.location}<br>`:''}👤 ${me.first} ${me.last}`;
  document.getElementById('gr-room-status').textContent=formatGuestRooms(me);
  document.getElementById('gr-room-request-type').value=me.roomRequestType||'undecided';
  document.getElementById('gr-requested-rooms').value=Math.max(1,parseInt(me.requestedRoomCount)||1);
  document.getElementById('gr-requested-stay-count').value=Math.max(1,parseInt(me.requestedStayCount)||me.party||1);
  document.getElementById('gr-room-request-note').value=me.roomRequestNote||'';
  openModal('guest-request');
}

let _giftTab='gifts';
let _giftCatFilter='all';

const CAT_META={
  '💝':{label:'Personal',  stripe:'#C4637A',bg:'#FAF0F3',chip:'background:#FAF0F3;color:#8B3A52'},
  '🏠':{label:'Home',      stripe:'#5B7FA6',bg:'#EBF2F9',chip:'background:#EBF2F9;color:#2F5380'},
  '💳':{label:'Cash/Card', stripe:'#C09050',bg:'#FBF6EC',chip:'background:#FBF6EC;color:#8A6020'},
  '👗':{label:'Clothing',  stripe:'#9B6BC4',bg:'#F5EEFA',chip:'background:#F5EEFA;color:#6A2B9A'},
  '🍽️':{label:'Kitchen',  stripe:'#6B9B7E',bg:'#EEF5F0',chip:'background:#EEF5F0;color:#3D6B50'},
  '📦':{label:'Other',     stripe:'#888780',bg:'#F5F0E8',chip:'background:#F5F0E8;color:#5F5E5A'},
};

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
      🎁 Gifts${physGifts.length?` <span style="background:${_giftTab==='gifts'?'var(--rose-l)':'rgba(0,0,0,.06)'};color:${_giftTab==='gifts'?'var(--rose-d)':'var(--txt3)'};border-radius:10px;padding:1px 6px;font-size:10px">${allGifts.filter(g=>!g.isMoi).length}</span>`:''}
    </button>
    <button onclick="App.setGiftTab('moi')" style="flex:1;padding:9px 6px;border:none;border-radius:6px;font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;font-weight:500;cursor:pointer;transition:all .2s;background:${_giftTab==='moi'?'var(--surf)':'transparent'};color:${_giftTab==='moi'?'var(--gold-d)':'var(--txt3)'};box-shadow:${_giftTab==='moi'?'var(--sh1)':'none'}">
      💵 Cash Gift${moiGifts.length?` <span style="background:${_giftTab==='moi'?'var(--gold-l)':'rgba(0,0,0,.06)'};color:${_giftTab==='moi'?'var(--gold-d)':'var(--txt3)'};border-radius:10px;padding:1px 6px;font-size:10px">${moiGifts.length}</span>`:''}
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
    const meta=CAT_META[g.cat]||CAT_META['📦'];
    const gm=DB.guests.find(gu=>gu.eventId===DB.activeEvent&&(gu.first+' '+gu.last).toLowerCase().trim()===(g.from||'').toLowerCase().trim());
    const avS=gm?avStyle(gm.id):'background:var(--surf3);color:var(--txt3)';
    const ini=gm?initials(gm.first,gm.last):(g.from||'?').charAt(0).toUpperCase();
    const tyLabel=g.ty==='sent'?'✓ TY Sent':g.ty==='drafted'?'✏ Drafted':'⏳ Pending';
    const tyDot=g.ty==='sent'?'var(--sage-d)':g.ty==='drafted'?'var(--slate-d)':'var(--gold-d)';
    return`<div class="gift-card anim" onclick="App.openEditGift('${g.id}')">
      <div class="gift-stripe" style="background:${meta.stripe}"></div>
      <div class="gift-inner">
        <div class="gift-top">
          <div class="gift-ico" style="background:${meta.bg}">${g.cat||'📦'}</div>
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
          <div>
            <div class="gift-val">${g.value?fmtVal(g.value):'—'}</div>
            ${g.value?`<div style="font-size:9.5px;color:var(--txt4);text-transform:uppercase;letter-spacing:.5px;margin-top:1px">Est. value</div>`:''}
          </div>
          <div class="gift-actions">
            <button class="ty-btn ty-${g.ty}" onclick="event.stopPropagation();App.cycleTy('${g.id}')" style="display:flex;align-items:center;gap:4px">
              <span style="width:6px;height:6px;border-radius:50%;background:${tyDot};flex-shrink:0;display:inline-block"></span>${tyLabel}
            </button>
            ${waBtn(g)}
          </div>
        </div>
        ${g.photo?`<img class="gift-photo-thumb" src="${g.photo}" alt="Gift" />`:''}
      </div>
      <button class="gift-del" onclick="event.stopPropagation();App.confirmDeleteGift('${g.id}')">✕</button>
    </div>`;
  }

  function moiRow(g,rank){
    const gm=DB.guests.find(gu=>gu.eventId===DB.activeEvent&&(gu.first+' '+gu.last).toLowerCase().trim()===(g.from||'').toLowerCase().trim());
    const avS=gm?avStyle(gm.id):`background:${rank===1?'#F0DEB8':rank===2?'#E0E0E0':rank===3?'#EBCFB0':'var(--surf2)'};color:${rank<=3?'var(--txt2)':'var(--txt3)'}`;
    const ini=gm?initials(gm.first,gm.last):(g.from||'?').charAt(0).toUpperCase();
    const medalColor=rank===1?'#C09050':rank===2?'#9E9E9E':rank===3?'#9C6B3A':null;
    const tyBg=g.ty==='sent'?'var(--sage-l)':g.ty==='drafted'?'var(--slate-l)':'var(--gold-l)';
    const tyColor=g.ty==='sent'?'var(--sage-d)':g.ty==='drafted'?'var(--slate-d)':'var(--gold-d)';
    const tyLabel=g.ty==='sent'?'✓ TY Sent':g.ty==='drafted'?'✏ Draft':'⏳ Pending';
    const modeIcon=g.notes==='UPI / GPay'?'📲':g.notes==='Bank Transfer'?'🏦':g.notes==='Cheque'?'📄':g.notes==='Gold / Jewellery'?'💛':'💵';
    const modeLabel=g.notes||'Cash';
    return`<div class="moi-row anim" data-moi="1" data-name="${(g.from||'').replace(/"/g,'')}" data-ty="${g.ty||'pending'}" onclick="App.openEditMoi('${g.id}')">
      <div style="position:relative;flex-shrink:0">
        <div class="moi-av" style="${avS}">${ini}</div>
        ${medalColor?`<div style="position:absolute;bottom:-2px;right:-2px;width:16px;height:16px;border-radius:50%;background:${medalColor};border:2px solid var(--surf);display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:800;color:white">${rank}</div>`:''}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13.5px;font-weight:500;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px">${g.from||'Unknown'}</div>
        <div style="font-size:11px;color:var(--txt4);display:flex;align-items:center;gap:4px">${modeIcon} <span>${modeLabel}</span></div>
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
    body=`<div class="empty"><div class="empty-ico">🎁</div><div class="empty-t">No event selected</div><div class="empty-s">Select one of your events to track gifts</div></div>`;
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
        <span class="gsn" style="font-size:${physVal>=100000?'15px':'21px'};color:var(--sage-d)">${physVal>0?fmtVal(physVal):'—'}</span>
        <span class="gsl">Est. Value</span>
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
          <span class="ty-bar-pct" style="color:${fillColor}">${tyPct===100?'All done! 🎉':tyPct+'% done'}</span>
        </div>
        <div class="ty-track"><div class="ty-fill" style="width:${tyPct}%;background:${fillColor}"></div></div>
      </div>`;
    }
    // Category filters
    const cats=[...new Set(physGifts.map(g=>g.cat))];
    if(cats.length>1){
      body+=`<div class="cat-filters">
        <span class="cat-chip ${_giftCatFilter==='all'?'on':''}" style="${_giftCatFilter==='all'?'background:var(--txt);color:white;border-color:var(--txt)':''}" onclick="App.setGiftCatFilter('all')">All</span>
        ${cats.map(c=>{const m=CAT_META[c]||CAT_META['📦'];return`<span class="cat-chip ${_giftCatFilter===c?'on':''}" style="${_giftCatFilter===c?m.chip+';border-color:transparent':''}" onclick="App.setGiftCatFilter('${c}')">${c} ${m.label}</span>`;}).join('')}
      </div>`;
    }
    const filtered=_giftCatFilter==='all'?physGifts:physGifts.filter(g=>g.cat===_giftCatFilter);
    body+=`<button class="fab" onclick="App.openAddGift()">＋ Log a Gift</button>`;
    if(physGifts.length===0){
      body+=`<div class="empty"><div class="empty-ico">🎁</div><div class="empty-t">No gifts yet</div><div class="empty-s">Tap above to log your first gift</div></div>`;
    } else if(filtered.length===0){
      body+=`<div class="empty"><div class="empty-ico">🔍</div><div class="empty-t">None in this category</div></div>`;
    } else {
      filtered.forEach((g,i)=>{
        if(i>0&&i%8===0&&!DB.premium) body+=`<div class="ad-inline"><span>✍️ Send cards at <strong>Hallmark</strong></span><span class="adlbl" style="font-size:9px">AD</span></div>`;
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
          <div style="font-family:'Cormorant Garamond',serif;font-size:40px;font-weight:600;color:white;line-height:1">${moiTotal>0?fmtVal(moiTotal):'₹0'}</div>
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
      ${moiGifts.length>0?`<div><div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:rgba(255,255,255,.5);margin-bottom:5px"><span>Thank-you progress</span><span style="font-weight:600;color:${moiPct===100?'#A5E5B8':'rgba(255,255,255,.7)'}">${moiPct===100?'All done! 🎉':moiPct+'%'}</span></div><div style="height:6px;background:rgba(255,255,255,.12);border-radius:3px;overflow:hidden"><div style="height:100%;width:${moiPct}%;background:linear-gradient(90deg,#FFD07A,#A5E5B8);border-radius:3px;transition:width .6s ease"></div></div></div>`:''}
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

    body+=`<button class="fab" style="background:var(--gold-d);margin-bottom:12px" onclick="App.openAddMoi()">+ Add Cash Gift Entry</button>`;
    if(moiGifts.length===0){
      body+=`<div class="empty"><div class="empty-ico">🪙</div><div class="empty-t">No entries yet</div><div class="empty-s">Record cash received from guests — tap above to start</div></div>`;
    } else {
      body+=`<div class="search-wrap" style="margin-bottom:10px"><span class="search-ico">🔍</span><input class="search-inp" type="text" placeholder="Search by name…" oninput="App.filterMoi(this.value)" id="moi-search-inp" /></div>`;
      body+=`<div class="moi-filter-row" id="moi-ty-filter">
        <span class="moi-fchip on" onclick="App.setMoiFilter('all',this)">All (${moiGifts.length})</span>
        <span class="moi-fchip" onclick="App.setMoiFilter('pending',this)">⏳ Pending (${moiPend})</span>
        <span class="moi-fchip" onclick="App.setMoiFilter('drafted',this)">✏️ Drafted (${moiDrafted})</span>
        <span class="moi-fchip" onclick="App.setMoiFilter('sent',this)">✅ Sent (${moiSent})</span>
      </div>`;
      const sorted=[...moiGifts].sort((a,b)=>(parseFloat(b.value)||0)-(parseFloat(a.value)||0));
      body+=`<div id="moi-list">${sorted.map((g,i)=>moiRow(g,i+1)).join('')}</div>`;
    }
  }

  el.innerHTML=evSelHtml+`<div class="ph" style="margin-bottom:12px"><div class="ph-title">Gift Tracker</div></div>`+tabBar+body;
}

// ═══════════════════════════════════════════════
// SETTINGS SCREEN
// ═══════════════════════════════════════════════
function renderSettings(){
  const el=document.getElementById('scr-settings');
  const sess=Auth.currentSession();
  const p={
    name:(sess&&sess.name)||DB.profile.name||'',
    email:(sess&&sess.email)||DB.profile.email||''
  };
  el.innerHTML=`
  <div class="ph"><div class="ph-title">Settings</div></div>
  ${!DB.premium?`<div class="prem-banner">
    <div class="prem-t">Go Ad-Free</div>
    <div class="prem-s">Enjoy eventise without interruptions. Unlock premium features coming soon.</div>
    <button class="prem-cta" onclick="App.openModal('premium')">Upgrade - Rs 499 / year</button>
  </div>`:`<div class="prem-banner" style="background:linear-gradient(135deg,var(--sage-d) 0%,#2A5038 100%)">
    <div class="prem-t">Premium Active</div>
    <div class="prem-s">You're enjoying eventise ad-free. Thank you for your support!</div>
  </div>`}
  <div class="set-sec">
    <div class="set-sec-t">Account</div>
    <div class="set-item" onclick="App.openProfileModal()">
      <div class="set-left">
        <div class="set-ico" style="background:var(--rose-l)">PR</div>
        <div><div class="set-lbl">Profile</div><div class="set-sub">${p.name||'Set your name'} ${p.email?' - '+p.email:''}</div></div>
      </div>
      <span class="chev">></span>
    </div>
  </div>
  <div class="set-sec">
    <div class="set-sec-t">Notifications</div>
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
  <div class="set-sec">
    <div class="set-sec-t">Data & Export</div>
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
  updateBadges();
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
  if(roomsTab&&Auth.isRoom(DB.activeEvent)){
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
  document.getElementById('mo-event-title').textContent='New Event';
  document.getElementById('ev-name').value='';
  document.getElementById('ev-date').value='';
  const timeEl=document.getElementById('ev-time');
  if(timeEl){
    timeEl.value='';
    timeEl.disabled=false;
    timeEl.style.opacity='1';
  }
  document.getElementById('ev-type').value='wedding';
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
  document.getElementById('del-event-btn').style.display='none';
  _roomLocsTemp=[];
  _eventMenusTemp=[];
  renderRoomLocsEditor();
  renderEventMenusEditor();
  openModal('add-event');
}

function openEditEvent(id){
  const ev=DB.events.find(e=>e.id===id);
  if(!ev)return;
  _editing.event=id;
  const isOrg = Auth.isOrganizer(id);
  document.getElementById('mo-event-title').textContent=isOrg?'Edit Event':'Configure Rooms';
  document.getElementById('ev-name').value=ev.name||'';
  document.getElementById('ev-date').value=ev.date||'';
  const timeEl=document.getElementById('ev-time');
  if(timeEl){
    timeEl.value=toTimeInputValue(ev.time);
    timeEl.disabled=!isOrg;
    timeEl.style.opacity=isOrg?'1':'0.6';
  }
  document.getElementById('ev-type').value=ev.type||'wedding';
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
  
  // Disable core fields for non-organizers
  ['ev-name', 'ev-date', 'ev-type', 'ev-loc', 'ev-color'].forEach(fid => {
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
  renderRoomLocsEditor();
  renderEventMenusEditor();
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

async function saveEvent(){
  const name=document.getElementById('ev-name').value.trim();
  if(!name){toast('⚠️ Please enter an event name');return;}
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
      ev.roomLocs=JSON.parse(JSON.stringify(_roomLocsTemp));
      if(isOrg){
        ev.name=name;
        ev.date=document.getElementById('ev-date').value;
        ev.time=eventTime;
        ev.type=document.getElementById('ev-type').value;
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
    toast('✅ Event updated');
  } else {
    const ev={
      id:uid(),name,
      date:document.getElementById('ev-date').value,
      time:eventTime,
      type:document.getElementById('ev-type').value,
      location:locVal,
      locLat,locLon,
      color:document.getElementById('ev-color').value,
      roomLocs:JSON.parse(JSON.stringify(_roomLocsTemp)),
      foodMenus:JSON.parse(JSON.stringify(normalizeEventMenus(_eventMenusTemp))),
      roomRequestsEnabled:roomRequestsEnabledEl?roomRequestsEnabledEl.checked:true,
      feedbackEnabled:feedbackEnabledEl?feedbackEnabledEl.checked:false,
      createdAt:Date.now()
    };
    DB.events.push(ev);
    if(!DB.activeEvent)DB.activeEvent=ev.id;
    Auth.addCreatorAsOrganizer(ev.id);
    savedEvent=ev;
    toast('🎉 Event created!');
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
    closeModal('add-event');render();toast('🗑️ Event deleted');
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
  document.getElementById('mo-guest-title').textContent='Add Guest';
  ['g-first','g-last','g-contact','g-email','g-notes','g-table'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('g-party').value='1';
  document.getElementById('g-rsvp').value='invited';
  document.getElementById('del-guest-btn').style.display='none';
  document.getElementById('send-invite-btn').style.display='none';
  populateRoomSelects();
  document.getElementById('g-room-loc').value='';
  document.getElementById('g-room-no').value='';
  openModal('add-guest');
}

function openEditGuest(id){
  const g=DB.guests.find(x=>x.id===id);
  if(!g)return;
  _editing.guest=id;
  document.getElementById('mo-guest-title').textContent='Edit Guest';
  document.getElementById('g-first').value=g.first||'';
  document.getElementById('g-last').value=g.last||'';
  document.getElementById('g-contact').value=g.contact||'';
  document.getElementById('g-email').value=g.email||'';
  document.getElementById('g-party').value=g.party||1;
  document.getElementById('g-rsvp').value=g.rsvp||'invited';
  document.getElementById('g-notes').value=g.notes||'';
  document.getElementById('g-table').value=g.table||'';
  document.getElementById('del-guest-btn').style.display='block';
  const hasPhone=g.contact&&g.contact.replace(/\D/g,'').length>=10;
  document.getElementById('send-invite-btn').style.display=hasPhone?'block':'none';
  const primaryRoom=getGuestRoomAssignments(g)[0]||{loc:g.roomLoc||'',no:g.roomNo||''};
  populateRoomSelects(primaryRoom.loc,primaryRoom.no);
  openModal('add-guest');
}

function saveGuest(){
  const first=document.getElementById('g-first').value.trim();
  if(!first){toast('⚠️ Please enter a first name');return;}
  const last=document.getElementById('g-last').value.trim();
  const gContact=document.getElementById('g-contact').value.trim();
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
    }
    toast('✅ Guest updated');
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
    toast(`👤 ${first} added!`);
  }
  save();syncActiveEventData();closeModal('add-guest');closeModal('guest-detail');render();
}

function cycleRsvp(id){
  const g=DB.guests.find(x=>x.id===id);
  if(!g)return;
  const s=['invited','attending','pending','declined'];
  g.rsvp=s[(s.indexOf(g.rsvp)+1)%s.length];
  save();syncActiveEventData();render();toast(`${g.first}: ${g.rsvp}`);
}

function confirmDeleteGuest(id){
  const gid=id||_editing.guest;
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  openConfirm(`Remove ${g.first} ${g.last}?`,'This guest will be removed from the list.',()=>{
    DB.guests=DB.guests.filter(x=>x.id!==gid);
    save();syncActiveEventData();closeModal('add-guest');closeModal('guest-detail');render();toast('🗑️ Guest removed');
  });
}

function openGuestDetail(id){
  const g=DB.guests.find(x=>x.id===id);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  ensureGuestFeedbackDefaults(g);
  const hasGuestFeedback=!!(g.feedbackMessage||g.feedbackUpdatedAt||g.feedbackFoodRating||g.feedbackEventRating||g.feedbackRoomRating);
  const linkedGifts=DB.gifts.filter(gi=>gi.eventId===DB.activeEvent&&gi.from&&gi.from.toLowerCase().includes((g.first+' '+g.last).toLowerCase().trim()));
  const rsvpOpts=['invited','attending','declined','pending'];
  const el=document.getElementById('guest-detail-content');
  const hasPhone=g.contact&&g.contact.replace(/\D/g,'').length>=10;
  const canViewRoomRequest=Auth.isRoom(DB.activeEvent);
  el.innerHTML=`
    <div class="detail-header">
      <div class="g-av" style="${avStyle(g.id)};width:44px;height:44px;font-size:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">${initials(g.first,g.last)}</div>
      <div class="detail-title">${g.first} ${g.last}</div>
      <button class="ib" onclick="App.openEditGuest('${g.id}');App.closeModal('guest-detail')">✏️</button>
    </div>
    <div class="info-grid">
      ${g.contact?`<div class="info-cell"><div class="info-lbl">Phone</div><div class="info-val">${g.contact}</div></div>`:''}
      ${g.email?`<div class="info-cell"><div class="info-lbl">Email</div><div class="info-val">${g.email}</div></div>`:''}
      <div class="info-cell"><div class="info-lbl">Peoples</div><div class="info-val">${g.party||1}</div></div>
      ${g.table?`<div class="info-cell"><div class="info-lbl">Table / Group</div><div class="info-val">${g.table}</div></div>`:''}
      ${getGuestRoomAssignments(g).length?`<div class="info-cell" style="grid-column:span 2"><div class="info-lbl">🏨 Assigned Rooms</div><div class="info-val">${formatGuestRooms(g)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Stay Request</div><div class="info-val">${roomRequestTypeLabel(g.roomRequestType)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Request Status</div><div class="info-val">${roomRequestStatusLabel(g.roomRequestStatus)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Rooms Requested</div><div class="info-val">${Math.max(1,parseInt(g.requestedRoomCount)||1)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestType!=='undecided'?`<div class="info-cell"><div class="info-lbl">Guests Staying</div><div class="info-val">${Math.max(1,parseInt(g.requestedStayCount)||g.party||1)}</div></div>`:''}
      ${canViewRoomRequest&&g.roomRequestNote?`<div class="info-cell" style="grid-column:span 2"><div class="info-lbl">Room Request Note</div><div class="info-val">${g.roomRequestNote}</div></div>`:''}
      ${hasGuestFeedback?`<div class="info-cell"><div class="info-lbl">Food Rating</div><div class="info-val">${renderFeedbackStars(g.feedbackFoodRating)}</div></div>`:''}
      ${hasGuestFeedback?`<div class="info-cell"><div class="info-lbl">Event Rating</div><div class="info-val">${renderFeedbackStars(g.feedbackEventRating)}</div></div>`:''}
      ${hasGuestFeedback?`<div class="info-cell"><div class="info-lbl">Room Rating</div><div class="info-val">${renderFeedbackStars(g.feedbackRoomRating)}</div></div>`:''}
      ${g.feedbackMessage?`<div class="info-cell" style="grid-column:span 2"><div class="info-lbl">Wishes and Feedback</div><div class="info-val">${g.feedbackMessage}</div></div>`:''}
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
    <div style="font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">RSVP Status</div>
    <div class="rsvp-big">
      ${rsvpOpts.map(s=>`<button class="rsvp-opt ${g.rsvp===s?'sel-'+s:''}" onclick="App.setRsvpDirect('${g.id}','${s}')">${s.charAt(0).toUpperCase()+s.slice(1)}</button>`).join('')}
    </div>
    ${hasPhone?`<button onclick="App.sendGuestInvite('${g.id}')" style="width:100%;padding:11px;background:#25D366;color:white;border:none;border-radius:var(--rs);font-family:'Plus Jakarta Sans',sans-serif;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px;transition:opacity .15s" onmouseover="this.style.opacity='.9'" onmouseout="this.style.opacity='1'"><svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg> Send WhatsApp Invite</button>`:''}
    ${linkedGifts.length>0?`<div class="linked-gifts">
      <div class="lg-title">Linked Gifts (${linkedGifts.length})</div>
      ${linkedGifts.map(gi=>`<div class="lg-item"><span>${gi.cat||'📦'} ${gi.desc}</span><span style="color:var(--sage-d);font-weight:500">${gi.value?fmtVal(gi.value):''}</span></div>`).join('')}
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
  const canViewLikes=!!_editing.event&&Auth.isOrganizer(_editing.event);
  const likeCounts=canViewLikes?getEventFoodLikeCounts(_editing.event):new Map();
  if(_eventMenusTemp.length===0){
    container.innerHTML=`<div style="font-size:12px;color:var(--txt3);line-height:1.6">Add one or more menu sections like Breakfast, Lunch, or Evening Snacks.</div>`;
    return;
  }
  container.innerHTML=_eventMenusTemp.map((menu,idx)=>`
    <div class="room-loc-block">
      <div class="room-loc-name" style="margin-bottom:10px">
        <input style="flex:1;background:transparent;border:none;outline:none;font-size:12.5px;font-weight:600;color:var(--txt2);font-family:'Plus Jakarta Sans',sans-serif" value="${menu.title||''}" placeholder="Section title (e.g. Breakfast)" oninput="App._updateEventMenuTitle(${idx},this.value)" ${_eventMenuEditorDisabled?'disabled':''} />
        ${_eventMenuEditorDisabled?'':`<button style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--txt4);padding:0 0 0 6px" onclick="App._removeEventMenu(${idx})" title="Remove menu section">✕</button>`}
      </div>
      <textarea class="fi" rows="4" style="resize:vertical" placeholder="Enter each menu item on a new line" oninput="App._updateEventMenuItems(${idx},this.value)" ${_eventMenuEditorDisabled?'disabled':''}>${menu.items||''}</textarea>
      ${canViewLikes&&normalizeMenuItems(menu.items).length?`<div style="margin-top:10px;padding:10px 12px;border-radius:12px;background:var(--surf);border:1px solid var(--bord2)">
        <div style="font-size:11px;font-weight:600;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Guest Hearts</div>
        <div style="display:grid;gap:6px">
          ${normalizeMenuItems(menu.items).map(itemText=>{
            const count=likeCounts.get(getFoodMenuLikeKey(menu,itemText))||0;
            return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--txt2)">
                <span style="line-height:1.5">${itemText}</span>
                <span style="flex-shrink:0;padding:3px 9px;border-radius:999px;background:${count?'var(--rose-l)':'var(--surf2)'};color:${count?'var(--rose-d)':'var(--txt3)'};font-weight:600">${count} heart${count===1?'':'s'}</span>
              </div>`;
          }).join('')}
        </div>
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
  const container=document.getElementById('ev-room-locs');
  if(!container)return;
  if(_roomLocsTemp.length===0){container.innerHTML='';return;}
  container.innerHTML=_roomLocsTemp.map((loc,li)=>`
    <div class="room-loc-block">
      <div class="room-loc-name">
        <input style="flex:1;background:transparent;border:none;outline:none;font-size:12.5px;font-weight:600;color:var(--txt2);font-family:'Plus Jakarta Sans',sans-serif" value="${loc.name}" placeholder="Location name (e.g. Block A, Hall 1)" oninput="App._updateLocName(${li},this.value)" />
        <button style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--txt4);padding:0 0 0 6px" onclick="App._removeLocation(${li})" title="Remove location">✕</button>
      </div>
      <div class="room-list" id="room-list-${li}">
        ${loc.rooms.map((r,ri)=>`<span class="room-tag">${r}<button class="room-tag-del" onclick="App._removeRoom(${li},${ri})">✕</button></span>`).join('')}
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
  const inputs=document.querySelectorAll('#ev-room-locs .room-loc-name input');
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
  if(added>0&&skipped>0) toast(`✅ Added ${added} rooms · ${skipped} already existed`);
  else if(added>0) toast(`✅ ${added} room${added>1?'s':''} added`);
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
  ind.innerHTML=`<div class="room-conflict">⚠️ Already allocated to: <span class="room-conflict-name">${names}</span></div>`;
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
    el.innerHTML=evSelHtml+`<div class="empty"><div class="empty-ico">🏨</div><div class="empty-t">No event selected</div><div class="empty-s">Select an event to manage rooms</div></div>`;
    return;
  }
  if(ev._isGuestOnly){
    const me=ensureGuestRequestDefaults(getCurrentGuestInvite(ev.id));
    if(!me){
      el.innerHTML=evSelHtml+`<div class="empty"><div class="empty-ico">🏨</div><div class="empty-t">Room details unavailable</div><div class="empty-s">We couldn't find your guest record for this invitation.</div></div>`;
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
    el.innerHTML=evSelHtml+`<div class="empty"><div class="empty-ico">🔐</div><div class="empty-t">Room access required</div><div class="empty-s">Only organisers and room coordinators can fulfill stay requests and allocate rooms.</div></div>`;
    return;
  }
  const locs=(ev.roomLocs)||[];
  if(locs.length===0){
    el.innerHTML=evSelHtml+
      `<div class="ph"><div class="ph-title">Room Management</div></div>`+
      `<div class="empty"><div class="empty-ico">🏨</div><div class="empty-t">No rooms configured</div><div class="empty-s">Add room locations in the Event settings to manage guest room allocation.</div><button class="fab" style="margin-top:16px" onclick="App.openEditEvent('${ev.id}')">⚙️ Configure Rooms</button></div>`;
    return;
  }
  // build stats
  const guests=DB.guests.filter(g=>g.eventId===DB.activeEvent).map(g=>ensureGuestRequestDefaults(g));
  const pendingRequests=guests.filter(g=>g.roomRequestStatus==='pending'&&g.roomRequestType!=='undecided');
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
  html+=`<button class="fab fab-outline" style="margin-top:8px" onclick="App.openEditEvent('${ev.id}')">⚙️ Edit Room Configuration</button>`;
  el.innerHTML=html;
}

let _roomAllocLoc='';
let _roomAllocNo='';
let _preferredRoomGuestId='';

function openRoomDetail(locName,roomNo){
  _roomAllocLoc=locName;
  _roomAllocNo=roomNo;
  const ev=DB.events.find(e=>e.id===DB.activeEvent);
  const allGuests=DB.guests.filter(g=>g.eventId===DB.activeEvent);
  const roomGuests=allGuests.filter(g=>getGuestRoomAssignments(g).some(room=>room.loc===locName&&room.no===roomNo));

  document.getElementById('mo-room-alloc-title').textContent=`Room ${roomNo}`;
  document.getElementById('mo-room-alloc-loc').textContent=`📍 ${locName}`;

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
        <button onclick="App.unassignGuestRoom('${g.id}')" style="background:#FEE8E8;color:#932B2B;border:1px solid #FABCBC;border-radius:var(--rxs);padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif">Remove This Room</button>
      </div>`).join('');
  } else {
    occEl.innerHTML=`<div style="background:var(--sage-l);border:1px solid var(--sage-m);border-radius:var(--rs);padding:10px 13px;margin-bottom:12px;font-size:12px;color:var(--sage-d)">🟢 Vacant — no guests assigned</div>`;
  }

  // Guest dropdown — show all guests, mark already-in-room ones
  const sel=document.getElementById('room-alloc-guest-sel');
  sel.innerHTML='<option value="">— Select a guest —</option>'+
    allGuests.map(g=>{
      const rooms=getGuestRoomAssignments(g);
      const inThisRoom=rooms.some(room=>room.loc===locName&&room.no===roomNo);
      const otherRooms=rooms.filter(room=>!(room.loc===locName&&room.no===roomNo));
      const label=`${g.first} ${g.last}`+(inThisRoom?' ✓ (this room)':otherRooms.length?` (${otherRooms.map(room=>room.loc+' #'+room.no).join(', ')})`:'');
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
    conflictEl.innerHTML=`<div class="room-conflict">⚠️ Already assigned to ${rooms.map(room=>room.loc+' Room '+room.no).join(', ')} — this room will be added too</div>`;
  } else {
    conflictEl.style.display='none';
  }
}

function assignGuestToRoom(){
  const gid=document.getElementById('room-alloc-guest-sel').value;
  if(!gid){toast('⚠️ Select a guest');return;}
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  addGuestRoomAssignment(g,_roomAllocLoc,_roomAllocNo);
  recomputeGuestRoomRequestStatus(g);
  save();syncActiveEventData();
  _preferredRoomGuestId='';
  toast(`✅ ${g.first} assigned to ${_roomAllocLoc} Room ${_roomAllocNo}`);
  closeModal('room-alloc');
  renderRooms();
}

function unassignGuestRoom(gid){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  const name=`${g.first} ${g.last}`;
  removeGuestRoomAssignment(g,_roomAllocLoc,_roomAllocNo);
  recomputeGuestRoomRequestStatus(g);
  save();syncActiveEventData();
  toast(`🗑️ ${name} unassigned from ${_roomAllocLoc} Room ${_roomAllocNo}`);
  // re-open to refresh
  openRoomDetail(_roomAllocLoc,_roomAllocNo);
  renderRooms();
}

function clearGuestRooms(gid){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g)return;
  ensureGuestRequestDefaults(g);
  g.roomAssignments=[];
  syncGuestPrimaryRoom(g);
  recomputeGuestRoomRequestStatus(g);
  save();syncActiveEventData();render();
  toast(`🗑️ Cleared all rooms for ${g.first}`);
}

function prepareGuestRoomAssignment(gid){
  const g=DB.guests.find(x=>x.id===gid);
  if(!g){toast('⚠️ Guest not found');return;}
  _preferredRoomGuestId=gid;
  switchTab('rooms');
  toast(`Choose a room for ${g.first} ${g.last}`);
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
  toast(`✅ ${g.first}'s request updated`);
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
  const roomPart=rooms.length?`\n🏨 Rooms: ${rooms.map(room=>`${room.loc} Room ${room.no}`).join(', ')}`:'';
  const msg=`🎉 *You're Invited!*\n\nDear ${g.first},\n\nWe joyfully invite you to *${ev.name}*\n\n📅 Date: ${evDate}\n📍 Venue: ${venue}${roomPart}\n\nYour presence will make this celebration truly special. We look forward to seeing you!\n\nWith warm regards 🙏`;
  const url=`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
  window.open(url,'_blank');
  toast('📲 WhatsApp invite opened!');
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
  toast('✅ Room request sent');
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
  toast('✅ Feedback sent');
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
  toast('🗑️ Feedback removed');
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
  if(!DB.activeEvent){toast('⚠️ Please select an event first');return;}
  _editing.gift=null;
  _giftPhotoData=null;
  document.getElementById('mo-gift-title').textContent='Log a Gift';
  ['gi-desc','gi-from','gi-val','gi-notes'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('gi-cat').value='💝';
  document.querySelectorAll('#gi-cat-picker .cat-opt').forEach(o=>o.classList.toggle('sel',o.dataset.cat==='💝'));
  document.getElementById('gi-ty').value='pending';
  document.getElementById('gift-photo-img').style.display='none';
  document.getElementById('gift-photo-label').style.display='block';
  document.getElementById('del-gift-btn').style.display='none';
  const dl=document.getElementById('guest-datalist');
  dl.innerHTML=DB.guests.filter(g=>g.eventId===DB.activeEvent).map(g=>`<option value="${g.first} ${g.last}"></option>`).join('');
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
  document.getElementById('gi-val').value=g.value||'';
  const cat=g.cat||'📦';
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
  const dl=document.getElementById('guest-datalist');
  dl.innerHTML=DB.guests.filter(g=>g.eventId===DB.activeEvent).map(g=>`<option value="${g.first} ${g.last}"></option>`).join('');
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
      g.value=parseFloat(document.getElementById('gi-val').value)||0;
      g.cat=document.getElementById('gi-cat').value;
      g.ty=document.getElementById('gi-ty').value;
      g.notes=document.getElementById('gi-notes').value.trim();
      g.photo=_giftPhotoData||null;
    }
    toast('✅ Gift updated');
  } else {
    DB.gifts.push({
      id:uid(),eventId:DB.activeEvent,
      desc,from:document.getElementById('gi-from').value.trim(),
      value:parseFloat(document.getElementById('gi-val').value)||0,
      cat:document.getElementById('gi-cat').value,
      ty:document.getElementById('gi-ty').value,
      notes:document.getElementById('gi-notes').value.trim(),
      photo:_giftPhotoData||null,
      createdAt:Date.now()
    });
    toast('🎁 Gift logged!');
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
    save();syncActiveEventData();closeModal('add-gift');closeModal('add-moi');render();toast('🗑️ Gift deleted');
  });
}

// ═══════════════════════════════════════════════
// EVENT PICKER
// ═══════════════════════════════════════════════
function renderEventPicker(){
  const el=document.getElementById('ep-list');
  const sess=Auth.currentSession();
  const myEvents=DB.events.filter(ev=>Auth.getTeam(ev.id).some(m=>m.userId===sess?.id || ((m.email||'').trim().toLowerCase()===(sess?.email||'').trim().toLowerCase())));
  if(myEvents.length===0){el.innerHTML=`<div class="empty"><div class="empty-ico">🎉</div><div class="empty-t">No events yet</div></div>`;return;}
  el.innerHTML=myEvents.map(ev=>{
    const col=COLORS[ev.color]||COLORS.rose;
    return`<div class="ep-item ${ev.id===DB.activeEvent?'sel':''}" onclick="App.pickEvent('${ev.id}')">
      <div class="ep-dot" style="background:${col.accent}"></div>
      <div><div style="font-size:13.5px;font-weight:500">${ev.name}</div><div style="font-size:11.5px;color:var(--txt3)">${TYPE_LABEL[ev.type]} ${ev.date?'· '+fmtDate(ev.date):''}</div></div>
    </div>`;
  }).join('');
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
  if(id==='event-pick')renderEventPicker();
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
  const rows=[['First Name','Last Name','Phone','Email','Peoples','RSVP Status','Table/Group','Notes']];
  guests.forEach(g=>rows.push([g.first,g.last,g.contact,g.email,g.party,g.rsvp,g.table,g.notes]));
  downloadCSV(`${(ev?.name||'event').replace(/\s+/g,'_')}_guests.csv`,rows);
  toast('📊 Guest list exported!');
  closeModal('export');
}

function exportGifts(){
  const evId=_exportEventId||DB.activeEvent;
  if(!evId){toast('⚠️ Select an event first');return;}
  const ev=DB.events.find(e=>e.id===evId);
  const gifts=DB.gifts.filter(g=>g.eventId===evId);
  if(gifts.length===0){toast('⚠️ No gifts to export');return;}
  const rows=[['Description','From','Category','Estimated Value (₹)','Thank-You Status','Notes']];
  gifts.forEach(g=>rows.push([g.desc,g.from,g.cat,g.value,g.ty,g.notes]));
  downloadCSV(`${(ev?.name||'event').replace(/\s+/g,'_')}_gifts.csv`,rows);
  toast('🎁 Gift tracker exported!');
  closeModal('export');
}

// ═══════════════════════════════════════════════
// PROFILE & SETTINGS
// ═══════════════════════════════════════════════
function saveProfile(){
  DB.profile.name=document.getElementById('prof-name').value.trim();
  DB.profile.email=document.getElementById('prof-email').value.trim();
  save();closeModal('profile');render();toast('✅ Profile saved');
}

function openProfileModal(){
  const sess=Auth.currentSession();
  const name=(sess&&sess.name)||DB.profile.name||'';
  const email=(sess&&sess.email)||DB.profile.email||'';
  const avatar=((name||email||'P').trim()[0]||'P').toUpperCase();
  const nameEl=document.getElementById('profile-name');
  const emailEl=document.getElementById('profile-email');
  const avatarEl=document.getElementById('profile-av');
  const inputName=document.getElementById('prof-name');
  const inputEmail=document.getElementById('prof-email');
  if(nameEl) nameEl.textContent=name||'Guest Host';
  if(emailEl) emailEl.textContent=email||'Sign in to sync across devices';
  if(avatarEl) avatarEl.textContent=avatar;
  if(inputName) inputName.value=name;
  if(inputEmail) inputEmail.value=email;
  openModal('profile');
}

function toggleSetting(key,btn){
  DB.settings[key]=!DB.settings[key];
  btn.classList.toggle('on',DB.settings[key]);
  save();
}

function unlockPremium(){
  DB.premium=true;save();closeModal('premium');render();
  toast('🎉 Premium unlocked! Ads removed.');
  if(!DB.premium) return;
  document.querySelector('.ad-top').style.display='none';
  document.querySelector('.ad-bot').style.display='none';
}

function clearAllData(){
  openConfirm('Clear all data?','This will permanently delete all events, guests, and gifts. This cannot be undone.',()=>{
    const eventIds = DB.events.map(event => event.id);
    DB.events=[];DB.guests=[];DB.gifts=[];DB.activeEvent=null;
    save();
    Cloud.clearAllCloudData(eventIds).catch(()=>toast('⚠️ Could not delete cloud data'));
    render();toast('🗑️ All data cleared');
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
      sug.innerHTML=data.map((p,i)=>`<div onclick="App.pickLoc('${encodeURIComponent(p.display_name)}','${p.lat}','${p.lon}')" style="padding:10px 13px;font-size:12.5px;cursor:pointer;border-bottom:1px solid var(--bord2);transition:background .12s" onmouseover="this.style.background='var(--surf2)'" onmouseout="this.style.background=''">📍 ${p.display_name}</div>`).join('');
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
  const defaultMsg=`Dear ${g.from},\n\nThank you so much for the wonderful ${g.desc}${g.value?' (worth '+fmtVal(g.value)+')':''}. Your thoughtfulness means the world to us. We are truly grateful for your presence and generosity at ${evName}.\n\nWith love & gratitude 🙏`;
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
  toast('✅ WhatsApp opened · Marked as TY Sent');
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
function setGSearch(v){_guestSearch=v;renderGuests()}

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
  document.getElementById('mo-moi-title').textContent='Add Cash Gift Entry';
  document.getElementById('moi-from').value='';
  document.getElementById('moi-amount').value='';
  const notesEl=document.getElementById('moi-notes');
  if(notesEl)notesEl.value='';
  document.getElementById('moi-ty').value='pending';
  // Reset TY picker buttons
  document.querySelectorAll('.moi-ty-pick-btn').forEach(b=>{
    const active=b.dataset.val==='pending';
    b.style.borderColor=active?'var(--gold-d)':'var(--bord)';
    b.style.background=active?'var(--gold-l)':'var(--surf)';
    b.style.color=active?'var(--gold-d)':'var(--txt3)';
  });
  document.getElementById('del-moi-btn').style.display='none';
  const dl=document.getElementById('moi-datalist');
  dl.innerHTML=DB.guests.filter(g=>g.eventId===DB.activeEvent).map(g=>`<option value="${g.first} ${g.last}"></option>`).join('');
  openModal('add-moi');
}

function openEditMoi(id){
  const g=DB.gifts.find(x=>x.id===id);
  if(!g)return;
  _editing.gift=id;
  document.getElementById('mo-moi-title').textContent='Edit Cash Gift Entry';
  document.getElementById('moi-from').value=g.from||'';
  document.getElementById('moi-amount').value=g.value||'';
  const notesEl=document.getElementById('moi-notes');
  if(notesEl)notesEl.value=g.notes||'';
  const tyVal=g.ty||'pending';
  document.getElementById('moi-ty').value=tyVal;
  // Sync TY picker buttons
  document.querySelectorAll('.moi-ty-pick-btn').forEach(b=>{
    const active=b.dataset.val===tyVal;
    b.style.borderColor=active?'var(--gold-d)':'var(--bord)';
    b.style.background=active?'var(--gold-l)':'var(--surf)';
    b.style.color=active?'var(--gold-d)':'var(--txt3)';
  });
  document.getElementById('del-moi-btn').style.display='block';
  const dl=document.getElementById('moi-datalist');
  dl.innerHTML=DB.guests.filter(g=>g.eventId===DB.activeEvent).map(g=>`<option value="${g.first} ${g.last}"></option>`).join('');
  openModal('add-moi');
}

function saveMoi(){
  const from=document.getElementById('moi-from').value.trim();
  const amount=parseFloat(document.getElementById('moi-amount').value)||0;
  if(!from){toast('⚠️ Please enter a name');return;}
  if(!amount){toast('⚠️ Please enter the amount');return;}
  if(_editing.gift){
    const g=DB.gifts.find(x=>x.id===_editing.gift);
    if(g){g.from=from;g.value=amount;g.notes=document.getElementById('moi-notes').value.trim();g.ty=document.getElementById('moi-ty').value;}
    toast('✅ Cash gift entry updated');
  } else {
    DB.gifts.push({id:uid(),eventId:DB.activeEvent,isMoi:true,desc:'Cash Gift',from,value:amount,cat:'💵',ty:document.getElementById('moi-ty').value,notes:document.getElementById('moi-notes').value.trim(),createdAt:Date.now()});
    toast(`💵 ₹${amount.toLocaleString('en-IN')} from ${from} recorded`);
  }
  save();syncActiveEventData();closeModal('add-moi');renderGifts();
}


// ═══════════════════════════════════════════════
// TEAM & AUTH UI
// ═══════════════════════════════════════════════
function openTeamModal(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  if(!Auth.isOrganizer(DB.activeEvent)){
    // Non-organizers can view team but not edit
  }
  Auth.renderTeamModal(DB.activeEvent);
  openModal('team');
}

async function sendTeamInvite(){
  if(!DB.activeEvent){toast('⚠️ Select an event first');return;}
  if(!Auth.isOrganizer(DB.activeEvent)){toast('⚠️ Only organisers can invite members');return;}
  const email=document.getElementById('team-invite-email').value.trim().toLowerCase();
  const role=document.getElementById('team-invite-role').value;
  if(!email){toast('⚠️ Enter an email');return;}
  const result=Auth.sendInvite(DB.activeEvent,email,role);
  if(result==='exists'){toast('⚠️ Already a team member');return;}
  if(result===false){toast('⚠️ Invalid email');return;}
  document.getElementById('team-invite-email').value='';
  const roleLabel=role==='organizer'?'Organizer':role==='cash'?'Cash Collector':'Room Coordinator';
  toast(`✅ ${email} added as ${roleLabel}`);
  try{ await Cloud.loadEventsForSession(Auth.currentSession()); }catch(e){}
}

function openUserMenu(){
  const sess=Auth.currentSession();
  if(!sess){openProfileModal();return;}
  const role=Auth.currentRole(DB.activeEvent);
  const roleLabel=role==='organizer'?'👑 Organizer':role==='cash'?'💵 Cash Collector':role==='room'?'🏨 Room Coordinator':'—';
  openConfirm(
    sess.name||sess.email,
    `${sess.email}\nRole: ${roleLabel}\n\nSign out of eventise?`,
    ()=>{ Auth.logout(); }
  );
  document.getElementById('confirm-ok').textContent='Sign Out';
  document.getElementById('confirm-ok').style.background='var(--rose-d)';
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
  openAddEvent:openAddEventGated,openEditEvent:openEditEventGated,saveEvent,confirmDeleteEvent:confirmDeleteEventGated,
  setActive,
  openAddGuest:openAddGuestGated,openEditGuest:openEditGuestGated,saveGuest,cycleRsvp,
  confirmDeleteGuest:confirmDeleteGuestGated,openGuestDetail,setRsvpDirect,
  openAddGift:openAddGiftGated,openEditGift:openEditGiftGated,saveGift,cycleTy,
  confirmDeleteGift:confirmDeleteGiftGated,handleGiftPhoto,
  setGiftTab,setGiftCatFilter,selectCat,
  openAddMoi:openAddMoiGated,openEditMoi:openEditMoiGated,saveMoi,filterMoi,setMoiFilter,setMoiTy,
  _editingGift:()=>_editing.gift,
  openGuestRequestModal,openGuestFeedbackModal,openGuestFoodMenuModal,
  submitGuestRoomRequest,setGuestFeedbackRating,submitGuestFeedback,clearGuestFeedback,scrollGuestsToFeedback,prepareGuestRoomAssignment:_requireRoom(prepareGuestRoomAssignment),resolveGuestRoomRequest:_requireRoom(resolveGuestRoomRequest),
  toggleGuestFoodLike,
  pickEvent,pickExportEvent,exportGuests,exportGifts,
  saveProfile,openProfileModal,toggleSetting,unlockPremium,clearAllData,
  setGFilter,setGSearch,openConfirm,closeConfirm,
  locSearch,pickLoc,openWhatsApp,sendWhatsApp,
  openGoogleContactsImport,fetchGoogleContacts,setGoogleContactsSearch,toggleGoogleContact,toggleAllGoogleContacts,importSelectedGoogleContacts,
  addEventMenu,_updateEventMenuTitle,_updateEventMenuItems,_removeEventMenu,
  addRoomLocation:addRoomLocationGated,_updateLocName,_removeLocation,_addRoom,_removeRoom,
  populateRoomSelects,refreshRoomNumbers,checkRoomConflict,sendGuestInvite,
  renderRooms,openRoomDetail,
  assignGuestToRoom:assignGuestToRoomGated,
  onRoomAllocGuestChange,
  unassignGuestRoom:unassignGuestRoomGated,
  clearGuestRooms:_requireRoom(clearGuestRooms),
  openTeamModal,sendTeamInvite,openUserMenu,
  toast,
};

// Expose modal helpers globally for inline onclick in dynamic HTML
window.setMoiTy=setMoiTy;
window.setMoiFilter=setMoiFilter;

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
// Pre-populate profile modal
openProfileModal();
closeModal('profile');

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
    {id:uid(),eventId:eid,desc:'Silk saree set (Kanjivaram)',from:'Divya Sharma',value:15000,cat:'💝',ty:'sent',notes:''},
    {id:uid(),eventId:eid,desc:'KitchenAid Stand Mixer',from:'Karthik Nair',value:28000,cat:'🏠',ty:'pending',notes:'Red colour'},
    {id:uid(),eventId:eid,desc:'Crystal dinner set',from:'Ananya Iyer',value:12000,cat:'🏠',ty:'drafted',notes:'12 piece'},
    {id:uid(),eventId:eid,isMoi:true,desc:'Cash Gift',from:'Vikram Singh',value:5001,cat:'💵',ty:'sent',notes:'Cash'},
    {id:uid(),eventId:eid,isMoi:true,desc:'Cash Gift',from:'Rohan Gupta',value:2100,cat:'💵',ty:'pending',notes:''},
    {id:uid(),eventId:eid,isMoi:true,desc:'Cash Gift',from:'Sneha Patel',value:3000,cat:'💵',ty:'pending',notes:'Online transfer'},
  ];
  save();
  // Seed organizer for demo event based on current session
  Auth.addCreatorAsOrganizer(eid);
}

// Initialize auth — shows login screen or app based on session
Auth.init();

render();

