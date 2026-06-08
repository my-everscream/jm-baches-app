/* ================================================================
   FIREBASE LAYER — JM Bâches
   Remplace le localStorage par Firestore + Firebase Auth
   
   INSTRUCTIONS D'INTÉGRATION :
   1. Remplacer YOUR_API_KEY, etc. par ta vraie config Firebase
   2. Ajouter dans app_without_data.html, avant la balise </body> :
      <script src="firebase-layer.js"></script>
   3. Supprimer le bloc INIT (lignes ~3748–3822) de app_without_data.html
      (la version DATA_VERSION, loadData(), migrateIfNeeded(), etc.)
   4. Le login/logout est pris en charge ici — ne plus appeler doLogin()
      directement depuis le HTML (le bouton peut rester, voir bas de fichier)
   ================================================================ */

// ----------------------------------------------------------------
// 1. CONFIGURATION FIREBASE — remplacer par ta vraie config
// ----------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBe3ftHEv0SLYE9iaLoX0ycv4b0os48wPI",
  authDomain: "jm-baches.firebaseapp.com",
  projectId: "jm-baches",
  storageBucket: "jm-baches.firebasestorage.app",
  messagingSenderId: "526625133379",
  appId: "1:526625133379:web:5d23d9eef20df4a1bd55f6"
};

// ----------------------------------------------------------------
// 2. IMPORT SDK Firebase (ESM via CDN)
//    Ces imports fonctionnent si le <script> est de type="module"
//    Voir note en bas pour l'alternative sans module
// ----------------------------------------------------------------
import { initializeApp }                        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword,
         signOut, onAuthStateChanged }           from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, collection,
         getDoc, getDocs, setDoc, updateDoc,
         deleteDoc, onSnapshot, writeBatch,
         serverTimestamp, query, orderBy }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ----------------------------------------------------------------
// 3. INITIALISATION
// ----------------------------------------------------------------
const _app  = initializeApp(FIREBASE_CONFIG);
const _auth = getAuth(_app);
const _db   = getFirestore(_app);

// Listeners temps réel actifs (pour les désabonner si besoin)
let _unsubDossiers     = null;
let _unsubNotifs       = null;
let _unsubUsers        = null;

// Flag pour éviter les boucles de sauvegarde au chargement
let _firestoreReady = false;

// ----------------------------------------------------------------
// 4. CHARGEMENT INITIAL — remplace loadData()
//    Abonne l'app aux 3 collections en temps réel (onSnapshot)
// ----------------------------------------------------------------
async function initFirebase() {
  showLoadingOverlay(true);

  // --- Users ---
  _unsubUsers = onSnapshot(collection(_db, 'users'), snap => {
    users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Si un utilisateur est connecté, resynchroniser currentUser
    if (currentUser) {
      const refreshed = users.find(u => u.id === currentUser.id);
      if (refreshed) currentUser = refreshed;
    }
    if (_firestoreReady) {
      buildLoginSelect?.();
      renderUsers?.();
    }
  });

  // --- Dossiers (triés par ID décroissant) ---
  _unsubDossiers = onSnapshot(
    query(collection(_db, 'dossiers'), orderBy('__name__', 'desc')),
    snap => {
      dossiers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_firestoreReady) {
        // Rafraîchir la vue active
        refreshCurrentView();
      }
    }
  );

  // --- Notifications ---
  _unsubNotifs = onSnapshot(collection(_db, 'notifications'), snap => {
    notifications = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.id > a.id ? 1 : -1));
    if (_firestoreReady) {
      updateBadge?.();
    }
  });

  // Attendre le premier chargement complet
  await waitForFirstLoad();
  _firestoreReady = true;
  showLoadingOverlay(false);
}

// Attend que les 3 collections aient chargé au moins une fois
function waitForFirstLoad() {
  return new Promise(resolve => {
    let loaded = 0;
    const check = () => { if (++loaded >= 3) resolve(); };
    const u1 = onSnapshot(collection(_db, 'users'),        () => { u1(); check(); });
    const u2 = onSnapshot(collection(_db, 'dossiers'),     () => { u2(); check(); });
    const u3 = onSnapshot(collection(_db, 'notifications'),() => { u3(); check(); });
  });
}

// ----------------------------------------------------------------
// 5. SAUVEGARDE — remplace saveData()
//    Chaque entité est sauvegardée individuellement dans Firestore
// ----------------------------------------------------------------

/**
 * Sauvegarde un dossier dans Firestore.
 * Appelé à chaque modification d'un dossier.
 */
async function saveDossierFS(dossier) {
  try {
    const ref = doc(_db, 'dossiers', dossier.id);
    const data = { ...dossier };
    delete data.id; // l'id est dans le chemin du document
    await setDoc(ref, data, { merge: true });
    showSaveIndicator('ok');
  } catch (e) {
    console.error('Firestore saveDossier error:', e);
    showSaveIndicator('error');
  }
}

/**
 * Sauvegarde un utilisateur dans Firestore.
 */
async function saveUserFS(user) {
  try {
    const ref = doc(_db, 'users', user.id);
    const data = { ...user };
    delete data.id;
    await setDoc(ref, data, { merge: true });
    showSaveIndicator('ok');
  } catch (e) {
    console.error('Firestore saveUser error:', e);
    showSaveIndicator('error');
  }
}

/**
 * Sauvegarde une notification dans Firestore.
 */
async function saveNotifFS(notif) {
  try {
    const ref = doc(_db, 'notifications', String(notif.id));
    const data = { ...notif };
    delete data.id;
    await setDoc(ref, data, { merge: true });
  } catch (e) {
    console.error('Firestore saveNotif error:', e);
  }
}

/**
 * Met à jour un champ précis d'un dossier (ex: statut, poseDate…)
 * Plus efficace que réécrire tout le document.
 */
async function updateDossierField(dosId, fields) {
  try {
    const ref = doc(_db, 'dossiers', dosId);
    await updateDoc(ref, fields);
  } catch (e) {
    console.error('Firestore updateDossierField error:', e);
  }
}

/**
 * Remplace saveData() — redirige vers la bonne fonction Firestore
 * selon ce qui a changé. Appelé partout dans le code original.
 * 
 * STRATÉGIE : on re-sauvegarde tout ce qui est en mémoire.
 * Pour une app temps réel multi-utilisateur, les onSnapshot
 * se chargent de synchroniser — cette fonction ne fait que
 * persister les changements locaux.
 */
window.saveData = async function saveData() {
  if (!_firestoreReady) return;
  try {
    // Sauvegarder tous les dossiers modifiés (batch pour limiter les requêtes)
    const batch = writeBatch(_db);
    dossiers.forEach(d => {
      const ref = doc(_db, 'dossiers', d.id);
      const data = { ...d };
      delete data.id;
      batch.set(ref, data, { merge: true });
    });
    users.forEach(u => {
      const ref = doc(_db, 'users', u.id);
      const data = { ...u };
      delete data.id;
      batch.set(ref, data, { merge: true });
    });
    notifications.forEach(n => {
      const ref = doc(_db, 'notifications', String(n.id));
      const data = { ...n };
      delete data.id;
      batch.set(ref, data, { merge: true });
    });
    await batch.commit();
    showSaveIndicator('ok');
  } catch (e) {
    console.error('Firestore saveData error:', e);
    showSaveIndicator('error');
  }
};

// ----------------------------------------------------------------
// 6. AUTH — remplace doLogin() / doLogout()
// ----------------------------------------------------------------

/**
 * Remplace doLogin() — utilise Firebase Auth
 */
window.doLogin = async function doLogin() {
  const email   = document.getElementById('login-email').value.trim().toLowerCase();
  const pwd     = document.getElementById('login-pwd').value;
  const err     = document.getElementById('login-error');

  if (!email) { err.textContent = 'Entrez votre adresse email'; return; }
  if (!pwd)   { err.textContent = 'Entrez votre mot de passe'; return; }

  err.textContent = '';
  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connexion…'; }

  try {
    await signInWithEmailAndPassword(_auth, email, pwd);
    // onAuthStateChanged va prendre le relais et appeler connectUser()
  } catch (e) {
    const msgs = {
      'auth/user-not-found':   'Aucun compte trouvé pour cette adresse email',
      'auth/wrong-password':   'Mot de passe incorrect',
      'auth/invalid-email':    'Adresse email invalide',
      'auth/user-disabled':    'Ce compte a été désactivé',
      'auth/too-many-requests':'Trop de tentatives — réessayez dans quelques minutes',
      'auth/invalid-credential': 'Email ou mot de passe incorrect',
    };
    err.textContent = msgs[e.code] || 'Erreur de connexion : ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Se connecter'; }
  }
};

/**
 * Remplace doLogout()
 */
window.doLogout = async function doLogout() {
  await signOut(_auth);
  currentUser = null;
  currentDosId = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-email').value = '';
  document.getElementById('login-pwd').value = '';
  document.getElementById('login-error').textContent = '';
};

// ----------------------------------------------------------------
// 7. GESTION DE SESSION — remplace la reconnexion via localStorage
//    onAuthStateChanged écoute les changements d'état Auth
// ----------------------------------------------------------------
onAuthStateChanged(_auth, async (firebaseUser) => {
  if (firebaseUser) {
    // Utilisateur connecté — trouver son profil dans Firestore
    const u = users.find(x => x.email && x.email.toLowerCase() === firebaseUser.email.toLowerCase() && x.active);
    if (u) {
      connectUser(u);
    } else {
      // Email Firebase Auth non trouvé dans users Firestore
      // Peut arriver si le compte Auth n'a pas de correspondance dans la collection users
      console.warn('Utilisateur Firebase Auth sans profil Firestore :', firebaseUser.email);
      await signOut(_auth);
    }
  }
  // Si firebaseUser est null → déjà géré par doLogout ou session expirée
});

// ----------------------------------------------------------------
// 8. SUPPRESSION — pour resetData()
// ----------------------------------------------------------------
window.resetData = async function resetData() {
  if (!confirm('Remettre toutes les données à zéro ? Cette action est irréversible.')) return;
  const batch = writeBatch(_db);
  dossiers.forEach(d => batch.delete(doc(_db, 'dossiers', d.id)));
  notifications.forEach(n => batch.delete(doc(_db, 'notifications', String(n.id))));
  await batch.commit();
  // On ne supprime pas les users (comptes Auth maintenus)
  location.reload();
};

// ----------------------------------------------------------------
// 9. SEED INITIAL — importer les données initiales dans Firestore
//    À appeler UNE SEULE FOIS depuis la console du navigateur :
//    seedFirestore()
// ----------------------------------------------------------------
window.seedFirestore = async function seedFirestore() {
  if (!confirm('Importer les données initiales dans Firestore ? À ne faire qu\'une seule fois.')) return;

  // Ces variables doivent être définies dans app_without_data.html
  const _users         = typeof users !== 'undefined' ? users : [];
  const _dossiers      = typeof dossiers !== 'undefined' ? dossiers : [];
  const _notifications = typeof notifications !== 'undefined' ? notifications : [];

  const batch = writeBatch(_db);

  _users.forEach(u => {
    const ref = doc(_db, 'users', u.id);
    const data = { ...u }; delete data.id;
    batch.set(ref, data);
  });
  _dossiers.forEach(d => {
    const ref = doc(_db, 'dossiers', d.id);
    const data = { ...d }; delete data.id;
    batch.set(ref, data);
  });
  _notifications.forEach(n => {
    const ref = doc(_db, 'notifications', String(n.id));
    const data = { ...n }; delete data.id;
    batch.set(ref, data);
  });

  await batch.commit();
  alert(`✓ Seed terminé : ${_users.length} users, ${_dossiers.length} dossiers, ${_notifications.length} notifications`);
};

// ----------------------------------------------------------------
// 10. UTILITAIRES UI
// ----------------------------------------------------------------
function showSaveIndicator(state) {
  const ind = document.getElementById('save-indicator');
  if (!ind) return;
  if (state === 'ok') {
    ind.textContent = '✓ Sauvegardé';
    ind.style.color = 'var(--green)';
    clearTimeout(ind._t);
    ind._t = setTimeout(() => {
      ind.textContent = '☁ Cloud';
      ind.style.color = 'var(--ink-faint)';
    }, 2000);
  } else {
    ind.textContent = '⚠ Erreur sauvegarde';
    ind.style.color = 'var(--red)';
  }
}

function showLoadingOverlay(show) {
  let el = document.getElementById('fb-loading-overlay');
  if (show) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'fb-loading-overlay';
      el.style.cssText = `
        position:fixed; inset:0; background:rgba(20,20,24,.7);
        display:flex; align-items:center; justify-content:center;
        z-index:9999; color:#fff; font-size:15px; font-family:'DM Sans',sans-serif;
        gap:12px; letter-spacing:.3px;
      `;
      el.innerHTML = `<div style="width:20px;height:20px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite"></div> Chargement des données…`;
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
  } else {
    if (el) el.style.display = 'none';
  }
}

/**
 * Rafraîchit la vue active après un update Firestore temps réel
 */
function refreshCurrentView() {
  if (typeof currentTab === 'undefined') return;
  const refreshMap = {
    dashboard:     () => typeof renderDashboard    === 'function' && renderDashboard(),
    dossiers:      () => typeof renderDos          === 'function' && renderDos(),
    atelier:       () => typeof renderAtelier      === 'function' && renderAtelier(),
    atelier_grand: () => typeof renderAtelierGrand === 'function' && renderAtelierGrand(),
    emballage:     () => typeof renderEmballage    === 'function' && renderEmballage(),
    emballage_grand:() => typeof renderEmballageGrand==='function'&& renderEmballageGrand(),
    planning:      () => typeof renderPlanning     === 'function' && renderPlanning(),
    users:         () => typeof renderUsers        === 'function' && renderUsers(),
  };
  const fn = refreshMap[currentTab];
  if (fn) fn();
  updateBadge?.();
}

// ----------------------------------------------------------------
// 11. DÉMARRAGE — remplace le bloc INIT de app_without_data.html
// ----------------------------------------------------------------
// On attend que le DOM soit prêt avant d'initialiser Firebase
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
});
